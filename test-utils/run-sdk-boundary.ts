import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";
import { createCliffExtension } from "../src/extension.js";
import { loadCliffConfig } from "../src/config.js";

export async function runSdkBoundary(
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
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

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
          workingTokens: mode === "native-cancel" || mode === "native-supply" ? 200_000 : 3_500,
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
