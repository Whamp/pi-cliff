import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionUIContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "cliff-probe";
const MODEL_ID = "offline-probe";
const OPENING_TASK = "HOST-PROBE-OPENING-TASK-TEAL-7";
const FOLLOWUP = "the deployment restarted after the new worker was enabled";
const CREDENTIAL_ENV_PATTERN =
  /(API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|SECRET|_KEY$|_TOKEN$|MANAGEMENT_KEY)/;

interface HookObservation {
  reason: SessionBeforeCompactEvent["reason"];
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary: string | null;
  hasUI: boolean;
}

interface NetworkAttempts {
  fetch: string[];
  sockets: string[];
}

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiSessionManager = ReturnType<PiSdk["SessionManager"]["create"]>;
type PiAgentSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>["session"];

interface PiHarness {
  root: string;
  agentDir: string;
  nextProject: number;
  sdk: PiSdk;
  registerCliff: (typeof import("../src/extension.js"))["default"];
  observations: HookObservation[];
  network: NetworkAttempts;
  modelCalls(): number;
  restore(): Promise<void>;
}

interface TestSession {
  session: PiAgentSession;
  sessionManager: PiSessionManager;
  observations: HookObservation[];
  notificationAttempts: () => number;
}

function usage() {
  return {
    input: 40,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 52,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function createHarness(): Promise<PiHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-cliff-host-test-"));
  const agentDir = join(root, "agent-dir");
  await mkdir(agentDir, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const removedCredentials = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key !== "PI_CODING_AGENT_DIR" && CREDENTIAL_ENV_PATTERN.test(key)) {
      removedCredentials.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }

  const network: NetworkAttempts = { fetch: [], sockets: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    network.fetch.push(url);
    throw new Error(`NETWORK TRIPWIRE: fetch(${url})`);
  };

  const connectDescriptor = Object.getOwnPropertyDescriptor(net.Socket.prototype, "connect");
  Object.defineProperty(net.Socket.prototype, "connect", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      const target = args[0];
      const description =
        typeof target === "string"
          ? target
          : target instanceof URL
            ? target.href
            : "socket options";
      network.sockets.push(description);
      throw new Error(`NETWORK TRIPWIRE: Socket.connect(${description})`);
    },
  });

  const sdk = await import("@earendil-works/pi-coding-agent");
  const { default: registerCliff } = await import("../src/extension.js");
  const modelMethods = ["stream", "complete", "streamSimple", "completeSimple"] as const;
  const modelSpies = modelMethods.map((method) => vi.spyOn(sdk.ModelRuntime.prototype, method));
  const observations: HookObservation[] = [];

  const restore = async () => {
    for (const spy of modelSpies) spy.mockRestore();
    globalThis.fetch = originalFetch;
    if (connectDescriptor !== undefined) {
      Object.defineProperty(net.Socket.prototype, "connect", connectDescriptor);
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const [key, value] of removedCredentials) process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  };

  return {
    root,
    agentDir,
    nextProject: 0,
    sdk,
    registerCliff,
    observations,
    network,
    modelCalls: () => modelSpies.reduce((count, spy) => count + spy.mock.calls.length, 0),
    restore,
  };
}

function measure(harness: PiHarness) {
  return {
    models: harness.modelCalls(),
    networks: harness.network.fetch.length + harness.network.sockets.length,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function latestCompaction(sessionManager: PiSessionManager) {
  const entry = sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "compaction")
    .at(-1);
  if (entry === undefined || entry.type !== "compaction") {
    throw new Error("Pi host test expected a persisted compaction entry");
  }
  return entry;
}

function cliffDetails(entry: SessionEntry): Record<string, unknown> {
  if (entry.type !== "compaction") throw new Error("expected compaction entry");
  const cliff = record(record(entry.details)?.["cliff"]);
  if (cliff === undefined) throw new Error("expected details.cliff head record");
  return cliff;
}

function appendHistory(sessionManager: PiSessionManager) {
  sessionManager.appendModelChange(PROVIDER, MODEL_ID);
  sessionManager.appendThinkingLevelChange("off");
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: OPENING_TASK }],
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect the worker configuration." },
      {
        type: "toolCall",
        id: "probe-read-config",
        name: "read",
        arguments: { path: "worker/config.json" },
      },
    ],
    api: "openai-completions",
    provider: PROVIDER,
    model: MODEL_ID,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "probe-read-config",
    toolName: "read",
    content: [{ type: "text", text: '{ "restart": true, "maxRestarts": 3 }' }],
    isError: false,
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "probe-read-log",
        name: "bash",
        arguments: { command: "tail -n 40 run.log" },
      },
    ],
    api: "openai-completions",
    provider: PROVIDER,
    model: MODEL_ID,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "probe-read-log",
    toolName: "bash",
    content: [{ type: "text", text: `log entry ${"worker-restart ".repeat(120)}` }],
    isError: false,
    timestamp: Date.now(),
  });
  const firstFollowupId = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: FOLLOWUP }],
    timestamp: Date.now(),
  });
  return { firstFollowupId };
}

function appendTurn(sessionManager: PiSessionManager, number: number, resultChars = 800): void {
  const callId = `probe-turn-${number}`;
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: `Checking worker restart evidence ${number}.` },
      {
        type: "toolCall",
        id: callId,
        name: "bash",
        arguments: { command: `probe-step-${number}` },
      },
    ],
    api: "openai-completions",
    provider: PROVIDER,
    model: MODEL_ID,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [
      {
        type: "text",
        text: `output ${number}: ${"detail ".repeat(resultChars).slice(0, resultChars)}`,
      },
    ],
    isError: false,
    timestamp: Date.now(),
  });
}

function appendMoreTurns(sessionManager: PiSessionManager, firstNumber: number): void {
  appendTurn(sessionManager, firstNumber);
  sessionManager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: `Follow-up question ${firstNumber}: show the restart sequence.` },
    ],
    timestamp: Date.now(),
  });
  appendTurn(sessionManager, firstNumber + 1);
}

async function makeSession(
  harness: PiHarness,
  options: {
    mode?: "active" | "shadow" | "off";
    configText?: string;
    priorHead?: unknown;
    priorStats?: unknown;
    throwingNotify?: boolean;
  } = {},
): Promise<TestSession> {
  const cwd = join(harness.root, `project-${harness.nextProject++}`);
  const projectPiDir = join(cwd, ".pi");
  await mkdir(projectPiDir, { recursive: true });
  if (options.configText !== undefined) {
    await writeFile(join(projectPiDir, "cliff.json"), options.configText, "utf8");
  } else if (options.mode !== undefined) {
    await writeFile(
      join(projectPiDir, "cliff.json"),
      JSON.stringify({ mode: options.mode }),
      "utf8",
    );
  }

  const sessionManager = harness.sdk.SessionManager.create(cwd, join(harness.root, "sessions"));
  const { firstFollowupId } = appendHistory(sessionManager);
  if (options.priorHead !== undefined) {
    sessionManager.appendCompaction(
      "previous host compaction summary",
      firstFollowupId,
      1000,
      {
        cliff: {
          version: 1,
          head: options.priorHead,
          summaryChars: options.priorStats,
        },
      },
      true,
    );
    appendMoreTurns(sessionManager, 3);
  }

  const settings = harness.sdk.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 300 },
    retry: { enabled: false },
  });
  const runtime = await harness.sdk.ModelRuntime.create({
    authPath: join(harness.root, "offline-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(PROVIDER, {
    name: "Pi Cliff offline tripwire",
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    // A deliberately fake key only lets Pi reach the localhost network tripwire in shadow mode.
    apiKey: "stub-key-not-real",
    models: [
      {
        id: MODEL_ID,
        name: "Offline probe model",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
  });
  const model = runtime.getModel(PROVIDER, MODEL_ID);
  if (model === undefined) throw new Error("Pi host test could not register its offline model");

  let notificationAttempts = 0;
  const uiContext = new Proxy(
    {
      notify() {
        notificationAttempts += 1;
        throw new Error("synthetic notification failure");
      },
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return () => undefined;
      },
    },
  ) as unknown as ExtensionUIContext;

  const loader = new harness.sdk.DefaultResourceLoader({
    cwd,
    agentDir: harness.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "host-test-observer",
        factory: (pi) => {
          pi.on("session_before_compact", (event, ctx) => {
            harness.observations.push({
              reason: event.reason,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              previousSummary: event.preparation.previousSummary ?? null,
              hasUI: ctx.hasUI,
            });
          });
        },
      },
      { name: "shipped-cliff", factory: harness.registerCliff },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const extensionNames = loader.getExtensions().extensions.map((extension) => extension.path);
  expect(extensionNames).toHaveLength(2);
  expect(extensionNames.some((path) => path.includes("host-test-observer"))).toBe(true);
  expect(extensionNames.some((path) => path.includes("shipped-cliff"))).toBe(true);

  const { session } = await harness.sdk.createAgentSession({
    cwd,
    agentDir: harness.agentDir,
    model,
    modelRuntime: runtime,
    settingsManager: settings,
    sessionManager,
    resourceLoader: loader,
    noTools: "all",
  });
  await session.bindExtensions(options.throwingNotify ? { mode: "rpc", uiContext } : {});

  return {
    session,
    sessionManager,
    observations: harness.observations,
    notificationAttempts: () => notificationAttempts,
  };
}

async function withHarness(test: (harness: PiHarness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await test(harness);
  } finally {
    await harness.restore();
  }
}

describe("real Pi SDK compaction integration", () => {
  it("uses Pi's cut and count and preserves its projected tail and opening head over three cycles", async () => {
    await withHarness(async (harness) => {
      const host = await makeSession(harness);
      try {
        const originalBranch = host.sessionManager.getBranch();
        const firstObservationIndex = host.observations.length;
        const beforeFirst = measure(harness);
        const firstResult = await host.session.compact();
        const firstObservation = host.observations[firstObservationIndex];
        const firstEntry = latestCompaction(host.sessionManager);
        const cliff = cliffDetails(firstEntry);

        expect(firstObservation?.reason).toBe("manual");
        expect(firstObservation).toMatchObject({
          firstKeptEntryId: firstResult.firstKeptEntryId,
          tokensBefore: firstResult.tokensBefore,
        });
        expect(firstResult.firstKeptEntryId).toBe(firstEntry.firstKeptEntryId);
        expect(firstResult.tokensBefore).toBe(firstEntry.tokensBefore);
        expect(cliff).toEqual({
          version: 1,
          head: [{ kind: "human", text: OPENING_TASK }],
        });
        expect(Object.keys(cliff).sort()).toEqual(["head", "version"]);
        expect(firstResult.summary).toContain(OPENING_TASK);

        const boundaryIndex = originalBranch.findIndex(
          (entry) => entry.id === firstObservation?.firstKeptEntryId,
        );
        expect(boundaryIndex).toBeGreaterThanOrEqual(0);
        expect(originalBranch[boundaryIndex]?.type).toBe("message");
        const keptMessages = originalBranch
          .slice(boundaryIndex)
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        const projected = host.sessionManager.buildSessionProjection().messages;
        expect(projected[0]?.role).toBe("compactionSummary");
        expect(projected.slice(1)).toEqual(harness.sdk.convertToLlm(keptMessages));
        expect(projected.map((message) => message.role)).toEqual([
          "compactionSummary",
          ...harness.sdk.convertToLlm(keptMessages).map((message) => message.role),
        ]);

        appendMoreTurns(host.sessionManager, 5);
        const secondIndex = host.observations.length;
        const secondResult = await host.session.compact();
        const secondObservation = host.observations[secondIndex];
        const secondEntry = latestCompaction(host.sessionManager);
        expect(secondObservation?.previousSummary).toBe(firstResult.summary);
        expect(secondObservation?.firstKeptEntryId).toBe(secondResult.firstKeptEntryId);
        expect(secondObservation?.tokensBefore).toBe(secondResult.tokensBefore);
        expect(cliffDetails(secondEntry)).toEqual(cliff);
        expect(secondResult.summary).toContain(OPENING_TASK);

        appendMoreTurns(host.sessionManager, 7);
        const thirdIndex = host.observations.length;
        const thirdResult = await host.session.compact();
        const thirdObservation = host.observations[thirdIndex];
        const thirdEntry = latestCompaction(host.sessionManager);
        expect(thirdObservation?.previousSummary).toBe(secondResult.summary);
        expect(thirdObservation?.firstKeptEntryId).toBe(thirdResult.firstKeptEntryId);
        expect(thirdObservation?.tokensBefore).toBe(thirdResult.tokensBefore);
        expect(cliffDetails(thirdEntry)).toEqual(cliff);
        expect(thirdResult.summary).toContain(OPENING_TASK);

        expect(measure(harness)).toEqual(beforeFirst);
        expect(harness.network.fetch).toEqual([]);
        expect(harness.network.sockets).toEqual([]);
      } finally {
        host.session.dispose();
      }
    });
  });

  it("restores a valid empty head despite corrupt optional historical stats", async () => {
    await withHarness(async (harness) => {
      const host = await makeSession(harness, {
        priorHead: [],
        priorStats: "not a number",
      });
      try {
        const before = measure(harness);
        const result = await host.session.compact();
        const entry = latestCompaction(host.sessionManager);
        const cliff = cliffDetails(entry);

        expect(result.summary).not.toContain(OPENING_TASK);
        expect(cliff).toEqual({ version: 1, head: [] });
        expect(Object.keys(cliff).sort()).toEqual(["head", "version"]);
        expect(measure(harness)).toEqual(before);
      } finally {
        host.session.dispose();
      }
    });
  });

  it("cancels malformed heads and malformed config without invoking Pi's default model", async () => {
    await withHarness(async (harness) => {
      const malformedHead = await makeSession(harness, {
        priorHead: [{ kind: "toolResult", text: "not a valid head unit" }],
      });
      try {
        const before = measure(harness);
        const outcome = await malformedHead.session.compact().then(
          () => "resolved",
          () => "rejected",
        );
        expect(outcome).toBe("rejected");
        expect(measure(harness)).toEqual(before);
      } finally {
        malformedHead.session.dispose();
      }

      const malformedConfig = await makeSession(harness, { configText: "{ invalid json" });
      try {
        const before = measure(harness);
        const outcome = await malformedConfig.session.compact().then(
          () => "resolved",
          () => "rejected",
        );
        expect(outcome).toBe("rejected");
        expect(measure(harness)).toEqual(before);
      } finally {
        malformedConfig.session.dispose();
      }
    });
  });

  it("isolates a throwing Pi UI notification from active compaction and model fallback", async () => {
    await withHarness(async (harness) => {
      const host = await makeSession(harness, { throwingNotify: true });
      try {
        const before = measure(harness);
        const result = await host.session.compact("instructions should be ignored");

        expect(host.observations.at(-1)?.hasUI).toBe(true);
        expect(host.notificationAttempts()).toBeGreaterThan(0);
        expect(result.summary).toContain(OPENING_TASK);
        expect(latestCompaction(host.sessionManager).fromHook).toBe(true);
        expect(measure(harness)).toEqual(before);
      } finally {
        host.session.dispose();
      }
    });
  });

  it("proves shadow delegates to Pi's default model through the tripwire", async () => {
    await withHarness(async (harness) => {
      const host = await makeSession(harness, { mode: "shadow" });
      try {
        const before = measure(harness);
        const outcome = await host.session.compact().then(
          () => "resolved",
          () => "rejected",
        );

        expect(outcome).toBe("rejected");
        expect(measure(harness).models).toBeGreaterThan(before.models);
        expect(measure(harness).networks).toBeGreaterThan(before.networks);
        expect(
          harness.network.fetch.some((url) => url.includes("/chat/completions")) ||
            harness.network.sockets.length > 0,
        ).toBe(true);
      } finally {
        host.session.dispose();
      }
    });
  });
});
