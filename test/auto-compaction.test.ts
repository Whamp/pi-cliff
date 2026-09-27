import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createCliffExtension } from "../src/extension.js";
import { DEFAULT_CLIFF_CONFIG, loadCliffConfig } from "../src/config.js";
import { planCliffAutoCompaction } from "../src/auto-compaction.js";

async function runSdkBoundary(
  mode:
    | "contract"
    | "cliff"
    | "off"
    | "shadow"
    | "native-cancel"
    | "native-supply"
    | "length"
    | "error",
  contextWindow = 128_000,
): Promise<number[]> {
  const root = await mkdtemp(join(tmpdir(), "cliff-auto-boundary-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);

  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
    }
    requests.push(body);
    if (mode === "error") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "fixture provider failure", type: "server_error" } }),
      );
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    const delta =
      requests.length === 1
        ? mode === "length"
          ? { content: "Truncated completion" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "live-call-4",
                  type: "function",
                  function: { name: "probe_tool", arguments: '{"step":4}' },
                },
              ],
            }
        : { content: "Finished after the compacted request." };
    response.write(
      `data: ${JSON.stringify({ id: "probe-1", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "probe-1", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? (mode === "length" ? "length" : "tool_calls") : "stop" }] })}\n\n`,
    );
    if (mode === "native-cancel" || (mode === "native-supply" && requests.length === 1)) {
      response.write(
        `data: ${JSON.stringify({ id: "probe-1", object: "chat.completion.chunk", created: 1, model: "probe", choices: [], usage: { prompt_tokens: 120_000, completion_tokens: 10, total_tokens: 120_010 } })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Cliff boundary test server has no TCP address");
    }
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({ role: "user", content: "Opening task must survive", timestamp: 1 });
    const assistants: string[] = [];
    for (let step = 1; step <= 3; step++) {
      manager.appendMessage({
        role: "user",
        content: `Old instruction ${step}`,
        timestamp: step * 100,
      });
      assistants.push(
        manager.appendMessage({
          role: "assistant",
          content: [
            { type: "text", text: `Assistant step ${step}` },
            { type: "toolCall", id: `old-call-${step}`, name: "probe_tool", arguments: { step } },
          ],
          api: "openai-completions",
          provider: "cliff-test",
          model: "probe",
          usage: {
            input: 50,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 60,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: step * 100 + 1,
        }),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `old-call-${step}`,
        toolName: "probe_tool",
        content: [
          { type: "text", text: step === 1 ? "obsolete ".repeat(3_000) : `result-${step}` },
        ],
        isError: false,
        timestamp: step * 100 + 2,
      });
    }
    const firstKeptEntryId = assistants[1];
    if (firstKeptEntryId === undefined) {
      throw new Error("Cliff boundary test needs three seeded assistant steps");
    }
    const cliffConfigPath = join(root, "cliff.json");
    if (mode !== "contract") {
      await writeFile(
        cliffConfigPath,
        JSON.stringify({
          mode: mode === "off" || mode === "shadow" ? mode : "active",
          thresholdTokens: mode === "native-cancel" || mode === "native-supply" ? 200_000 : 3_500,
          keepRecentTurns: mode === "native-cancel" ? 100 : 3,
        }),
      );
    }
    const settings = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        keepRecentTokens: mode === "native-cancel" || mode === "native-supply" ? 1 : 64_000,
        reserveTokens: 16_384,
      },
      retry: { enabled: false },
    });
    const nativeReasons: string[] = [];
    const nativeEnds: boolean[] = [];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "native-threshold-observer",
          factory: (pi) => {
            pi.on("session_before_compact", (event) => {
              nativeReasons.push(event.reason);
            });
          },
        },
        mode !== "contract"
          ? {
              name: "shipped-cliff",
              factory: (pi) =>
                createCliffExtension(pi, {
                  resolveConfigPaths: () => ({
                    globalPath: join(root, "absent-global.json"),
                    projectPath: cliffConfigPath,
                  }),
                  loadConfig: loadCliffConfig,
                }),
            }
          : {
              name: "cliff-boundary-proof",
              factory: (pi) => {
                pi.on("turn_end", (event) => {
                  if (event.toolResults.length === 0) {
                    return;
                  }
                  return {
                    entries: [
                      {
                        type: "compaction",
                        summary: "Opening task must survive. Obsolete result omitted.",
                        firstKeptEntryId,
                      },
                    ],
                  };
                });
              },
            },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerProvider("cliff-test", {
      name: "Local Cliff test provider",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "not-a-real-key",
      models: [
        {
          id: "probe",
          name: "Probe",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: 1_024,
        },
      ],
    });
    const model = runtime.getModel("cliff-test", "probe");
    if (model === undefined) {
      throw new Error("Cliff boundary test model was not registered");
    }
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: manager,
      modelRuntime: runtime,
      model,
      noTools: "builtin",
      customTools: [
        {
          name: "probe_tool",
          label: "Probe",
          description: "Return a short observation",
          parameters: {
            type: "object",
            properties: { step: { type: "number" } },
            required: ["step"],
          },
          execute: async () => ({
            content: [{ type: "text", text: "live-result-4" }],
            details: {},
          }),
        },
      ],
    }));
    session.subscribe((event) => {
      if (event.type === "compaction_end" && event.reason === "threshold") {
        nativeEnds.push(event.aborted);
      }
    });
    if (mode !== "native-cancel" && mode !== "native-supply") {
      await expect(session.compact()).rejects.toThrow("Nothing to compact");
      expect(requests).toHaveLength(0);
    }
    await session.prompt("Live instruction 4");
    const requestBytes = requests.map((request) => Buffer.byteLength(request));
    const compactions = manager.getBranch().filter((entry) => entry.type === "compaction");
    if (mode === "length" || mode === "error") {
      expect(compactions).toHaveLength(0);
      expect(requests).toHaveLength(1);
      return requestBytes;
    }
    expect(requests).toHaveLength(2);
    if (mode === "native-cancel" || mode === "native-supply") {
      expect(nativeReasons).toContain("threshold");
      expect(nativeEnds).toContain(mode === "native-cancel");
    }
    if (mode === "off" || mode === "shadow" || mode === "native-cancel" || contextWindow < 2_000) {
      expect(compactions).toHaveLength(0);
      expect(requests[1]).toContain("obsolete");
      return requestBytes;
    }
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(requests[1]).toContain("Opening task must survive");
    if (mode === "cliff" || mode === "native-supply") {
      expect(requests[1]).toContain("The following is a summary of your previous actions");
    } else {
      expect(requests[1]).toContain("Opening task must survive. Obsolete result omitted.");
    }
    expect(requests[1]).toContain("live-result-4");
    expect(requests[1]).toContain("result-2");
    expect(requests[1]).not.toContain("obsolete");
    return requestBytes;
  } finally {
    session?.dispose();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

it("persists a turn_end compaction despite Pi's 64K retained tail", async () => {
  await runSdkBoundary("contract");
});

it("uses Cliff's automatic cut for the next Pi provider request", async () => {
  await runSdkBoundary("cliff");
});

it("reduces provider request bytes against the same off-mode workload", async () => {
  const off = await runSdkBoundary("off");
  const cliff = await runSdkBoundary("cliff");
  const offTotal = off.reduce((sum, bytes) => sum + bytes, 0);
  const cliffTotal = cliff.reduce((sum, bytes) => sum + bytes, 0);
  expect(cliff).toHaveLength(2);
  expect(cliffTotal).toBeLessThan(offTotal * 0.9);
  if (process.env.CLIFF_AUTO_PERF === "1") {
    console.info(
      JSON.stringify({ workload: "64k-tail-low-threshold", off, cliff, offTotal, cliffTotal }),
    );
  }
});

it("leaves automatic provider context unchanged when Cliff is off or shadow", async () => {
  await runSdkBoundary("off");
  await runSdkBoundary("shadow");
});

it("denies an automatic cut when the protected input cannot fit the model", async () => {
  await runSdkBoundary("cliff", 1_200);
});

it("cancels Pi native threshold without invoking its model summarizer", async () => {
  await runSdkBoundary("native-cancel");
});

it("supplies a mechanical cut at Pi's native automatic threshold", async () => {
  await runSdkBoundary("native-supply");
});

it("does not commit a boundary cut after length-stop or provider failure", async () => {
  await runSdkBoundary("length");
  await runSdkBoundary("error");
});

it("previews a current-branch assistant cut without mutating the session", () => {
  const manager = SessionManager.inMemory("/tmp/cliff-auto-cut-test");
  manager.appendMessage({
    role: "system",
    content: "System rules",
    toolsAdded: [
      {
        name: "probe_tool",
        description: "A tool with a measurable request schema",
        parameters: { type: "object", properties: { step: { type: "number" } } },
      },
    ],
    timestamp: 0,
  });
  manager.appendMessage({ role: "user", content: "Opening task", timestamp: 1 });
  const assistantIds: string[] = [];
  for (let step = 1; step <= 4; step++) {
    assistantIds.push(
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Step ${step}` }],
        api: "openai-completions",
        provider: "cliff-test",
        model: "probe",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: step + 1,
      }),
    );
    if (step === 1) {
      manager.appendMessage({
        role: "user",
        content: "Old observation ".repeat(3_000),
        timestamp: 10,
      });
    }
  }
  const projection = manager.buildSessionProjection();
  const snapshot = {
    cwd: manager.getCwd(),
    header: manager.getHeader(),
    branch: manager.getBranch(),
    entries: projection.entries,
    messages: projection.messages,
    model: { contextWindow: 128_000, maxTokens: 1_024 },
    signal: undefined,
  };
  const renderer = () => ({ ok: true as const, summary: "Opening task", head: [] });
  const config = { ...DEFAULT_CLIFF_CONFIG, thresholdTokens: 1 };
  expect(
    planCliffAutoCompaction(snapshot, DEFAULT_CLIFF_CONFIG, "completed-step", renderer),
  ).toEqual({
    kind: "keep",
    reason: "below-budget",
  });
  const decision = planCliffAutoCompaction(snapshot, config, "native-overflow", renderer);
  expect(decision).toMatchObject({ kind: "compact", firstKeptEntryId: assistantIds[1] });
  expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);

  const noToolBranch = manager
    .getBranch()
    .map((entry) =>
      entry.type === "message" && entry.message.role === "system"
        ? { ...entry, message: { ...entry.message, toolsAdded: [] } }
        : entry,
    );
  const header = manager.getHeader();
  if (header === null) {
    throw new Error("Cliff preview test has no session header");
  }
  const noToolManager = SessionManager.inMemory(manager.getCwd(), undefined, [
    header,
    ...noToolBranch,
  ]);
  const noToolProjection = noToolManager.buildSessionProjection();
  const noToolDecision = planCliffAutoCompaction(
    {
      ...snapshot,
      branch: noToolBranch,
      entries: noToolProjection.entries,
      messages: noToolProjection.messages,
    },
    config,
    "native-overflow",
    renderer,
  );
  if (decision.kind !== "compact" || noToolDecision.kind !== "compact") {
    throw new Error("Cliff preview test needs two reducing assistant-step cuts");
  }
  const systemWithTools = projection.messages.find((message) => message.role === "system");
  const systemWithoutTools = noToolProjection.messages.find((message) => message.role === "system");
  if (systemWithTools === undefined || systemWithoutTools === undefined) {
    throw new Error("Cliff preview test needs the Pi system and tool message");
  }
  expect(decision.beforeTokens).toBe(
    projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
  );
  expect(noToolDecision.beforeTokens).toBe(
    noToolProjection.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
  );
  expect(decision.beforeTokens - noToolDecision.beforeTokens).toBe(
    estimateTokens(systemWithTools) - estimateTokens(systemWithoutTools),
  );

  const unfit = planCliffAutoCompaction(
    { ...snapshot, model: { contextWindow: 1, maxTokens: 1 } },
    config,
    "completed-step",
    renderer,
  );
  expect(unfit).toEqual({
    kind: "deny",
    reason: "no assistant-step cut reduces the estimated input enough",
  });

  const entriesWithForeignIds = projection.entries.map((entry) =>
    entry.sourceEntry.type === "message" && entry.sourceEntry.message.role === "assistant"
      ? { ...entry, sourceEntry: { ...entry.sourceEntry, id: "foreign-assistant-id" } }
      : entry,
  );
  const invalid = planCliffAutoCompaction(
    { ...snapshot, entries: entriesWithForeignIds },
    config,
    "completed-step",
    renderer,
  );
  expect(invalid).toEqual({ kind: "keep", reason: "no-older-step" });

  const protectedBranch = manager.getBranch().map((entry) => {
    if (entry.type !== "message") return entry;
    if (
      entry.message.role === "user" &&
      typeof entry.message.content === "string" &&
      entry.message.content.startsWith("Old observation")
    ) {
      return { ...entry, message: { ...entry.message, content: "Short observation" } };
    }
    if (entry.id === assistantIds[1] && entry.message.role === "assistant") {
      return {
        ...entry,
        message: {
          ...entry.message,
          content: [{ type: "text" as const, text: "Large second step ".repeat(3_000) }],
        },
      };
    }
    return entry;
  });
  const protectedManager = SessionManager.inMemory(manager.getCwd(), undefined, [
    header,
    ...protectedBranch,
  ]);
  const protectedProjection = protectedManager.buildSessionProjection();
  const protectedDecision = planCliffAutoCompaction(
    {
      ...snapshot,
      branch: protectedBranch,
      entries: protectedProjection.entries,
      messages: protectedProjection.messages,
    },
    config,
    "completed-step",
    () => ({ ok: true, summary: "Summary framing ".repeat(80), head: [] }),
  );
  expect(protectedDecision).toEqual({ kind: "keep", reason: "protected-tail" });
});
