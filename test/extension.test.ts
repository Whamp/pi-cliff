import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliffExtension } from "../src/extension.js";
import {
  DEFAULT_CLIFF_CONFIG,
  loadCliffConfig,
  type CliffConfig,
  type CliffConfigFileState,
  type CliffConfigOrigin,
  type CliffMode,
} from "../src/config.js";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { PiAgentMessage } from "../src/pi-units.js";

const TIMESTAMP = 1_700_000_000_000;

function makeExtension(
  options: {
    mode?: CliffMode;
    errors?: string[];
    throwLoad?: boolean;
    config?: Partial<CliffConfig>;
    origins?: CliffConfigOrigin[];
    files?: CliffConfigFileState[];
    branch?: SessionEntry[];
  } = {},
) {
  type BeforeHandler = (
    input: SessionBeforeCompactEvent,
    context: ExtensionContext,
  ) => SessionBeforeCompactResult | void | Promise<SessionBeforeCompactResult | void>;
  const handlers = new Map<string, BeforeHandler>();
  const receipts: unknown[] = [];
  let notificationError: Error | undefined;
  let notificationAttempts = 0;
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let failAppend = false;
  let loadCalls = 0;
  let branchCalls = 0;
  const dependencies = {
    resolveConfigPaths: () => ({
      globalPath: "/global/cliff.json",
      projectPath: "/project/.pi/cliff.json",
    }),
    loadConfig: () => {
      loadCalls += 1;
      if (options.throwLoad) {
        throw new Error("config reader failed");
      }
      return {
        config: {
          ...DEFAULT_CLIFF_CONFIG,
          ...options.config,
          mode: options.mode ?? options.config?.mode ?? "active",
        },
        origins: options.origins ?? [],
        files: options.files ?? [],
        errors: options.errors ?? [],
      };
    },
  };
  const api = {
    on(event: string, handler: (...args: never[]) => unknown) {
      if (event === "session_before_compact") {
        // SAFETY: this test adapter stores the Pi-typed handler under its matching event name.
        handlers.set(event, handler as BeforeHandler);
      }
      return () => {};
    },
    registerCommand(
      _name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) {
      commandHandler = command.handler;
    },
    appendEntry(type: string, data: unknown) {
      if (failAppend) {
        throw new Error("session entry write failed");
      }
      receipts.push({ type, data });
    },
  };
  createCliffExtension(api, dependencies);
  const notifyCalls: { message: string; kind: string | undefined }[] = [];
  // SAFETY: the hook only reads the project, UI availability, model, and branch capabilities below.
  const context = {
    cwd: "/project",
    hasUI: true,
    mode: "tui",
    ui: {
      notify(message: string, kind?: string) {
        notificationAttempts += 1;
        if (notificationError !== undefined) {
          throw notificationError;
        }
        notifyCalls.push({ message, kind });
      },
    },
    model: { contextWindow: 64 },
    sessionManager: {
      getBranch: () => {
        branchCalls += 1;
        return options.branch ?? [];
      },
    },
  } as unknown as ExtensionContext;
  return {
    before: handlers.get("session_before_compact"),
    get command() {
      return commandHandler;
    },
    get notificationAttempts() {
      return notificationAttempts;
    },
    context,
    commandContext: context as unknown as ExtensionCommandContext,
    dependencies,
    receipts,
    notifyCalls,
    get loadCalls() {
      return loadCalls;
    },
    get branchCalls() {
      return branchCalls;
    },
    setNotificationError(error: Error | undefined) {
      notificationError = error;
    },
    setFailAppend(value: boolean) {
      failAppend = value;
    },
  };
}

function user(text: string): Extract<PiAgentMessage, { role: "user" }> {
  return { role: "user", content: text, timestamp: TIMESTAMP };
}

function assistant(
  text: string,
  inputTokens = 100,
): Extract<PiAgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: inputTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: TIMESTAMP,
  };
}

function event(
  options: {
    reason?: "manual" | "threshold" | "overflow";
    messages?: PiAgentMessage[];
    branchEntries?: SessionEntry[];
    customInstructions?: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    aborted?: boolean;
  } = {},
): SessionBeforeCompactEvent {
  const input: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    reason: options.reason ?? "manual",
    willRetry: false,
    signal: options.aborted ? AbortSignal.abort() : new AbortController().signal,
    branchEntries: options.branchEntries ?? [],
    preparation: {
      messagesToSummarize: options.messages ?? [user("starting task"), assistant("working")],
      turnPrefixMessages: [],
      firstKeptEntryId: options.firstKeptEntryId ?? "pi-kept-entry",
      tokensBefore: options.tokensBefore ?? 73,
      isSplitTurn: false,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 50 },
    },
  };
  if (options.customInstructions !== undefined) {
    input.customInstructions = options.customInstructions;
  }
  return input;
}

function requireCompaction(result: SessionBeforeCompactResult | void) {
  if (result?.compaction === undefined) {
    throw new Error("active Cliff hook did not return a compaction");
  }
  return result.compaction;
}

async function compact(
  harness: ReturnType<typeof makeExtension>,
  input: SessionBeforeCompactEvent,
): Promise<SessionBeforeCompactResult | void> {
  if (harness.before === undefined) {
    throw new Error("session_before_compact handler was not registered");
  }
  return await harness.before(input, harness.context);
}

async function runCommand(harness: ReturnType<typeof makeExtension>, args: string): Promise<void> {
  if (harness.command === undefined) {
    throw new Error("Cliff test: /cliff command was not registered");
  }
  await harness.command(args, harness.commandContext);
}

describe("native compaction hook", () => {
  it("keeps overflow's 75-estimated-token equivalent at the existing 300-code-point cap", async () => {
    const harness = makeExtension({ config: { assistantTextMaxTokens: 75 } });
    const result = await compact(
      harness,
      event({
        reason: "overflow",
        messages: [user("opening task"), assistant("ACTION-DETAIL ".repeat(80), 50_000)],
        branchEntries: [
          {
            type: "message",
            id: "pi-kept-entry",
            parentId: null,
            timestamp: new Date(TIMESTAMP).toISOString(),
            message: user("kept tail"),
          },
        ],
      }),
    );

    const compaction = requireCompaction(result);
    expect(compaction).toMatchObject({ firstKeptEntryId: "pi-kept-entry", tokensBefore: 73 });
    expect(compaction.summary).toContain(
      `assistant: ${"ACTION-DETAIL ".repeat(80).slice(0, 300)}...`,
    );
  });

  it("converts estimated-token settings once to exact code-point renderer caps", async () => {
    const harness = makeExtension({
      config: {
        assistantTextMaxTokens: 37.5,
        reasoningTextMaxTokens: 1.25,
        toolCallMaxTokens: 37.5,
        toolResultMaxTokens: 125,
        userTextMaxTokens: 5_000,
      },
    });
    const assistantMessage: PiAgentMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "r".repeat(6) },
        { type: "text", text: "😀".repeat(151) },
        {
          type: "toolCall",
          id: "cap-call",
          name: "probe",
          arguments: { value: "😀".repeat(200) },
        },
      ],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 100,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 101,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: TIMESTAMP,
    };
    const shortResult: PiAgentMessage = {
      role: "toolResult",
      toolCallId: "cap-call",
      toolName: "probe",
      content: [{ type: "text", text: "s".repeat(500) }],
      isError: false,
      timestamp: TIMESTAMP,
    };
    const longResult: PiAgentMessage = {
      ...shortResult,
      content: [{ type: "text", text: "x".repeat(501) }],
    };

    const result = requireCompaction(
      await compact(
        harness,
        event({ messages: [user("u".repeat(20_001)), assistantMessage, shortResult, longResult] }),
      ),
    );
    const serializedCall = `{"value":"${"😀".repeat(200)}"}`;

    expect(result.summary).toContain(`user: ${"u".repeat(20_000)}...`);
    expect(result.summary).toContain(`thinking: ${"r".repeat(5)}...`);
    expect(result.summary).toContain(`assistant: ${"😀".repeat(150)}...`);
    expect(result.summary).toContain(
      `[probe] ${Array.from(serializedCall).slice(0, 150).join("")}...`,
    );
    expect(result.summary).toContain(`result: ${"s".repeat(500)}`);
    expect(result.summary).not.toContain("x".repeat(501));
  });

  it("restores a valid head when optional historical report stats are absent", async () => {
    const harness = makeExtension();
    const first = requireCompaction(
      await compact(
        harness,
        event({ messages: [user("original opening task"), assistant("first answer")] }),
      ),
    );
    const previous: SessionEntry = {
      type: "compaction",
      id: "previous-compaction",
      parentId: null,
      timestamp: new Date(TIMESTAMP).toISOString(),
      summary: first.summary,
      firstKeptEntryId: "pi-kept-entry",
      tokensBefore: 73,
      details: {
        cliff: {
          version: 1,
          head: [{ kind: "human", text: "original opening task" }],
          summaryChars: "corrupt optional report stat",
        },
      },
    } satisfies SessionEntry;
    harness.context.sessionManager.getBranch = () => [previous];

    const second = await compact(
      harness,
      event({
        messages: [user("new opening turn"), assistant("second answer")],
        branchEntries: [previous],
      }),
    );

    const secondCompaction = requireCompaction(second);
    expect(secondCompaction.details).toMatchObject({
      cliff: { head: [{ kind: "human", text: "original opening task" }] },
    });
    expect(secondCompaction.summary).toContain("user: original opening task");
  });

  it("isolates a throwing warning notification from active compaction", async () => {
    const harness = makeExtension();
    harness.setNotificationError(new Error("notification failed"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await compact(harness, event({ customInstructions: "focus on decisions" }));

    expect(requireCompaction(result).summary).toContain("user: starting task");
    expect(harness.notificationAttempts).toBe(1);
    expect(stderr).toHaveBeenCalledOnce();
    stderr.mockRestore();
  });

  it("cancels active compaction when a Cliff-owned head is malformed", async () => {
    const harness = makeExtension();
    const prior: SessionEntry = {
      type: "compaction",
      id: "prior",
      parentId: null,
      timestamp: new Date(TIMESTAMP).toISOString(),
      summary: "foreign-looking text is not head state",
      firstKeptEntryId: "pi-kept-entry",
      tokensBefore: 10,
      details: { cliff: { version: 1, head: [{ kind: "toolResult", text: "bad head" }] } },
    };

    const result = await compact(
      harness,
      event({ branchEntries: [prior], messages: [user("new turn"), assistant("new answer")] }),
    );

    expect(result).toEqual({ cancel: true });
  });

  it.each([
    [
      "inherited record fields",
      '{"cliff":{"__proto__":{"version":1,"head":[{"kind":"human","text":"injected opening"}]}}}',
    ],
    [
      "inherited head-unit fields",
      '{"cliff":{"version":1,"head":[{"__proto__":{"kind":"human","text":"injected opening"}}]}}',
    ],
  ])("cancels when persisted head JSON uses %s", async (_caseName, encodedDetails) => {
    const harness = makeExtension();
    const prior: SessionEntry = {
      type: "compaction",
      id: "malformed-json-head",
      parentId: null,
      timestamp: new Date(TIMESTAMP).toISOString(),
      summary: "untrusted persisted summary",
      firstKeptEntryId: "pi-kept-entry",
      tokensBefore: 10,
      details: JSON.parse(encodedDetails),
    };

    const result = await compact(
      harness,
      event({ branchEntries: [prior], messages: [user("new turn"), assistant("new answer")] }),
    );

    expect(result).toEqual({ cancel: true });
  });

  it.each(["manual", "threshold", "overflow"] as const)(
    "copies Pi's exact boundary and token count for %s compaction",
    async (reason) => {
      const harness = makeExtension();
      const result = await compact(
        harness,
        event({ reason, firstKeptEntryId: "pi-cut-17", tokensBefore: 991 }),
      );
      expect(requireCompaction(result)).toMatchObject({
        firstKeptEntryId: "pi-cut-17",
        tokensBefore: 991,
      });
    },
  );

  it("preserves an established empty head across later opening turns", async () => {
    const harness = makeExtension();
    const first = requireCompaction(
      await compact(harness, event({ messages: [assistant("first answer")] })),
    );
    const prior: SessionEntry = {
      type: "compaction",
      id: "prior-empty-head",
      parentId: null,
      timestamp: new Date(TIMESTAMP).toISOString(),
      summary: first.summary,
      firstKeptEntryId: "pi-kept-entry",
      tokensBefore: 73,
      details: { cliff: { version: 1, head: [], summaryChars: "corrupt optional report stat" } },
    } satisfies SessionEntry;
    harness.context.sessionManager.getBranch = () => [prior];

    const second = await compact(
      harness,
      event({ branchEntries: [prior], messages: [user("later turn"), assistant("answer")] }),
    );

    expect(requireCompaction(second).details).toMatchObject({ cliff: { head: [] } });
  });

  it.each(["shadow", "off"] as const)("delegates in resolved %s mode", async (mode) => {
    const harness = makeExtension({ mode });
    expect(await compact(harness, event())).toBeUndefined();
  });

  it("does not let a failed optional receipt turn active cancellation into delegation", async () => {
    const harness = makeExtension({ errors: ["bad config"] });
    harness.setFailAppend(true);

    const result = await compact(harness, event());

    expect(result).toEqual({ cancel: true });
  });
});

describe("/cliff command", () => {
  it("shows help without reading config or querying the session", async () => {
    const harness = makeExtension({ throwLoad: true });

    await runCommand(harness, "help");

    expect(harness.loadCalls).toBe(0);
    expect(harness.branchCalls).toBe(0);
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]?.message).toContain('"unlimited" disables the limit');
    expect(harness.notifyCalls[0]?.message).toContain('"toolCallMaxTokens"');
    expect(harness.notifyCalls[0]?.message).toContain('"toolResultMaxTokens"');
    expect(harness.notifyCalls[0]?.message).toContain("Unicode code points divided by 4");
    expect(harness.notifyCalls[0]?.message).toContain("```json");
    expect(harness.notifyCalls[0]?.message).toContain("Precedence: built-in defaults");
  });

  it("returns usage for unknown args instead of showing status", async () => {
    const harness = makeExtension({ throwLoad: true });

    await runCommand(harness, "anything");

    expect(harness.loadCalls).toBe(0);
    expect(harness.branchCalls).toBe(0);
    expect(harness.notifyCalls).toEqual([{ message: "Usage: /cliff [help]", kind: "warning" }]);
  });

  it("points to help when status cannot read the config", async () => {
    const harness = makeExtension({ throwLoad: true });

    await runCommand(harness, "");

    expect(harness.notifyCalls[0]?.message).toContain(
      "Cliff config could not be read: config reader failed",
    );
    expect(harness.notifyCalls[0]?.message).toContain(
      "Use /cliff help for settings and a JSON example.",
    );
  });

  it("delegates when project off overrides an invalid global config and reports its migration hint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliff-off-config-"));
    const globalPath = join(directory, "global", "cliff.json");
    const projectPath = join(directory, "project", ".pi", "cliff.json");
    try {
      await mkdir(join(directory, "global"), { recursive: true });
      await mkdir(join(directory, "project", ".pi"), { recursive: true });
      await writeFile(globalPath, JSON.stringify({ cmdMaxChars: 0 }), "utf8");
      await writeFile(projectPath, JSON.stringify({ mode: "off" }), "utf8");

      const loaded = loadCliffConfig({ globalPath, projectPath });
      expect(loaded.files).toEqual([
        { path: globalPath, state: "invalid" },
        { path: projectPath, state: "read" },
      ]);
      expect(loaded.config.mode).toBe("off");
      expect(loaded.origins).toContainEqual({ key: "mode", path: projectPath });
      expect(loaded.errors).toHaveLength(1);
      expect(loaded.errors[0]).toContain(
        'retired key "cmdMaxChars"; use "toolCallMaxTokens" instead.',
      );
      expect(loaded.errors[0]).toContain('legacy 0 meant unlimited, so use "unlimited".');

      const harness = makeExtension({
        config: loaded.config,
        errors: loaded.errors,
        origins: loaded.origins,
        files: loaded.files,
      });
      expect(await compact(harness, event())).toBeUndefined();
      await runCommand(harness, "");

      const status = harness.notifyCalls[0]?.message ?? "";
      expect(status).toContain(`mode = off (origin: ${projectPath})`);
      expect(status).toContain(`error: Cliff config ${globalPath}:`);
      expect(status).toContain('retired key "cmdMaxChars"; use "toolCallMaxTokens" instead.');
      expect(status).toContain('legacy 0 meant unlimited, so use "unlimited".');
      expect(status).toContain("Use /cliff help for settings and a JSON example.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports every effective value and its winning origin with the branch status", async () => {
    const globalPath = "/global/cliff.json";
    const projectPath = "/project/.pi/cliff.json";
    const harness = makeExtension({
      config: {
        mode: "shadow",
        includeReasoning: false,
        assistantTextMaxTokens: 0,
        reasoningTextMaxTokens: "unlimited",
        toolCallMaxTokens: 3.75,
        toolResultMaxTokens: 0,
        userTextMaxTokens: 50,
      },
      origins: [
        { key: "mode", path: globalPath },
        { key: "assistantTextMaxTokens", path: globalPath },
        { key: "reasoningTextMaxTokens", path: globalPath },
        { key: "toolCallMaxTokens", path: projectPath },
        { key: "toolResultMaxTokens", path: globalPath },
        { key: "userTextMaxTokens", path: projectPath },
      ],
      files: [
        { path: globalPath, state: "read" },
        { path: projectPath, state: "read" },
      ],
    });

    await runCommand(harness, "");

    expect(harness.loadCalls).toBe(1);
    expect(harness.branchCalls).toBe(1);
    const report = harness.notifyCalls[0]?.message ?? "";
    expect(report).toContain(`mode = shadow (origin: ${globalPath})`);
    expect(report).toContain("includeReasoning = false (origin: built-in default)");
    expect(report).toContain(`assistantTextMaxTokens = 0 (origin: ${globalPath})`);
    expect(report).toContain(`reasoningTextMaxTokens = unlimited (origin: ${globalPath})`);
    expect(report).toContain(`toolCallMaxTokens = 3.75 (origin: ${projectPath})`);
    expect(report).toContain(`toolResultMaxTokens = 0 (origin: ${globalPath})`);
    expect(report).toContain(`userTextMaxTokens = 50 (origin: ${projectPath})`);
    expect(report).toContain(`file ${globalPath}: read`);
    expect(report).toContain(`file ${projectPath}: read`);
    expect(report).toContain("Last compaction on this branch: none yet");
    expect(report).toContain("Last Cliff receipt: none on this branch");
    expect(report).toContain("Use /cliff help for settings and a JSON example.");
  });
});
