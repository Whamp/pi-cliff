import { describe, expect, it, vi } from "vitest";
import { createCliffExtension } from "../src/extension.js";
import { DEFAULT_CLIFF_CONFIG, type CliffMode } from "../src/config.js";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { PiAgentMessage } from "../src/pi-units.js";

const TIMESTAMP = 1_700_000_000_000;

function makeExtension(options: { mode?: CliffMode; errors?: string[]; throwLoad?: boolean } = {}) {
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
        config: { ...DEFAULT_CLIFF_CONFIG, mode: options.mode ?? "active" },
        origins: [],
        files: [],
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
    sessionManager: { getBranch: () => [] },
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
    dependencies,
    receipts,
    notifyCalls,
    get loadCalls() {
      return loadCalls;
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

describe("native compaction hook", () => {
  it("keeps the lean overflow summary without inferring a fit budget", async () => {
    const harness = makeExtension();
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
