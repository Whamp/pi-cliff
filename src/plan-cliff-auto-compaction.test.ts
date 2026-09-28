import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { DEFAULT_CLIFF_CONFIG } from "./config.js";
import { planCliffAutoCompaction } from "./plan-cliff-auto-compaction.js";
import { runSdkBoundary } from "../test-utils/run-sdk-boundary.js";

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
    process.stderr.write(
      `${JSON.stringify({ workload: "64k-tail-low-threshold", off, cliff, offTotal, cliffTotal })}\n`,
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
  };
  const renderer = () => ({ ok: true as const, summary: "Opening task", head: [] });
  const config = { ...DEFAULT_CLIFF_CONFIG, workingTokens: 1 };
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
    if (entry.type !== "message") {
      return entry;
    }
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

it("triggers on the compressible middle, not on head or tail growth", () => {
  const renderer = () => ({ ok: true as const, summary: "Opening task", head: [] });
  const config = { ...DEFAULT_CLIFF_CONFIG, workingTokens: 1_000 };
  const assistantMessage = (text: string, timestamp: number) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
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
    stopReason: "stop" as const,
    timestamp,
  });

  const headManager = SessionManager.inMemory("/tmp/cliff-auto-head-test");
  headManager.appendMessage({
    role: "system",
    content: "rule ".repeat(180_000),
    toolsAdded: [],
    timestamp: 0,
  });
  headManager.appendMessage({ role: "user", content: "Opening task", timestamp: 1 });
  for (let step = 1; step <= 4; step++) {
    headManager.appendMessage(assistantMessage(`Step ${step}`, step + 1));
  }
  const headProjection = headManager.buildSessionProjection();
  const headHeader = headManager.getHeader();
  if (headHeader === null) {
    throw new Error("head-growth fixture has no session header");
  }
  const headDecision = planCliffAutoCompaction(
    {
      cwd: headManager.getCwd(),
      header: headHeader,
      branch: headManager.getBranch(),
      entries: headProjection.entries,
      messages: headProjection.messages,
    },
    config,
    "completed-step",
    renderer,
  );
  expect(headDecision).toEqual({ kind: "keep", reason: "below-budget" });

  const tailManager = SessionManager.inMemory("/tmp/cliff-auto-tail-test");
  tailManager.appendMessage({
    role: "system",
    content: "System rules",
    toolsAdded: [],
    timestamp: 0,
  });
  tailManager.appendMessage({ role: "user", content: "Opening task", timestamp: 1 });
  for (let step = 1; step <= 4; step++) {
    const text = step === 1 ? `Step ${step}` : "turn ".repeat(80_000);
    tailManager.appendMessage(assistantMessage(text, step + 1));
  }
  const tailProjection = tailManager.buildSessionProjection();
  const tailHeader = tailManager.getHeader();
  if (tailHeader === null) {
    throw new Error("tail-growth fixture has no session header");
  }
  const tailDecision = planCliffAutoCompaction(
    {
      cwd: tailManager.getCwd(),
      header: tailHeader,
      branch: tailManager.getBranch(),
      entries: tailProjection.entries,
      messages: tailProjection.messages,
    },
    config,
    "completed-step",
    renderer,
  );
  expect(tailDecision).toEqual({ kind: "keep", reason: "below-budget" });
});
