import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendMoreTurns,
  cliffDetails,
  latestCompaction,
  makeSession,
  measure,
  OPENING_TASK,
  withHarness,
} from "../test-utils/pi-host-harness.js";

describe("real Pi SDK compaction integration", () => {
  it("dispatches /cliff help through Pi when config is malformed without calling a model", async () => {
    await withHarness(async (harness) => {
      const host = await makeSession(harness, {
        configText: "{ invalid json",
        throwingNotify: true,
      });
      let output = "";
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      try {
        const before = measure(harness);
        await host.session.prompt("/cliff help");
        const defaultJson = output.match(/```json\n([\s\S]*?)\n```/)?.[1];

        expect(output).toContain("Cliff configuration");
        expect(output).toContain('"unlimited" disables the limit');
        expect(output).not.toContain("is not valid JSON");
        expect(defaultJson).toBeDefined();
        expect(JSON.parse(defaultJson ?? "")).toEqual({
          mode: "active",
          workingTokens: 120_000,
          keepRecentTurns: 3,
          includeReasoning: true,
          assistantTextMaxTokens: "unlimited",
          reasoningTextMaxTokens: "unlimited",
          toolCallMaxTokens: 37.5,
          toolResultMaxTokens: 125,
          userTextMaxTokens: 5_000,
        });
        expect(measure(harness)).toEqual(before);
        expect(harness.network.fetch).toEqual([]);
        expect(harness.network.sockets).toEqual([]);
      } finally {
        stderr.mockRestore();
        host.session.dispose();
      }
    });
  });
  it("dispatches /cliff status through Pi with every effective token value and origin", async () => {
    await withHarness(async (harness) => {
      const projectPath = join(harness.root, `project-${harness.nextProject}`, ".pi", "cliff.json");
      const globalPath = join(harness.agentDir, "cliff.json");
      await writeFile(globalPath, JSON.stringify({ reasoningTextMaxTokens: 1.25 }), "utf8");
      const host = await makeSession(harness, {
        configText: JSON.stringify({
          assistantTextMaxTokens: 37.5,
          toolCallMaxTokens: 12.5,
          toolResultMaxTokens: 125,
          userTextMaxTokens: 5_000,
        }),
        throwingNotify: true,
      });
      let output = "";
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      try {
        const before = measure(harness);
        await host.session.prompt("/cliff");

        expect(output).toContain("Cliff configuration:");
        expect(output).toContain("mode = active (origin: built-in default)");
        expect(output).toContain("includeReasoning = true (origin: built-in default)");
        expect(output).toContain(`assistantTextMaxTokens = 37.5 (origin: ${projectPath})`);
        expect(output).toContain(`reasoningTextMaxTokens = 1.25 (origin: ${globalPath})`);
        expect(output).toContain(`toolCallMaxTokens = 12.5 (origin: ${projectPath})`);
        expect(output).toContain(`toolResultMaxTokens = 125 (origin: ${projectPath})`);
        expect(output).toContain(`userTextMaxTokens = 5000 (origin: ${projectPath})`);
        expect(output).toContain(`file ${globalPath}: read`);
        expect(output).toContain(`file ${projectPath}: read`);
        expect(output).toContain("Last compaction on this branch: none yet");
        expect(output).toContain("Last Cliff receipt: none on this branch");
        expect(measure(harness)).toEqual(before);
        expect(harness.network.fetch).toEqual([]);
        expect(harness.network.sockets).toEqual([]);
      } finally {
        stderr.mockRestore();
        host.session.dispose();
      }
    });
  });

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

  it("applies zero and unlimited policy values through the real Pi compaction hook", async () => {
    await withHarness(async (harness) => {
      const host = await makeSession(harness, {
        configText: JSON.stringify({
          includeReasoning: false,
          assistantTextMaxTokens: 0,
          reasoningTextMaxTokens: "unlimited",
          toolCallMaxTokens: 0,
          toolResultMaxTokens: 0,
          userTextMaxTokens: "unlimited",
        }),
      });
      try {
        const before = measure(harness);
        const result = await host.session.compact();
        const entry = latestCompaction(host.sessionManager);

        expect(result.summary).toContain(`user: ${OPENING_TASK}`);
        expect(result.summary).not.toContain("assistant:");
        expect(result.summary).not.toContain("thinking:");
        expect(result.summary).not.toContain("[read]");
        expect(result.summary).not.toContain("[bash]");
        expect(result.summary).not.toContain("result:");
        expect(cliffDetails(entry)).toEqual({
          version: 1,
          head: [{ kind: "human", text: OPENING_TASK }],
        });
        expect(measure(harness)).toEqual(before);
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

      const malformedDetails = [
        JSON.parse(
          '{"cliff":{"__proto__":{"version":1,"head":[{"kind":"human","text":"injected opening"}]}}}',
        ),
        JSON.parse(
          '{"cliff":{"version":1,"head":[{"__proto__":{"kind":"human","text":"injected opening"}}]}}',
        ),
      ];
      for (const priorDetails of malformedDetails) {
        const malformedJsonHead = await makeSession(harness, { priorDetails });
        try {
          const before = measure(harness);
          const outcome = await malformedJsonHead.session.compact().then(
            () => "resolved",
            () => "rejected",
          );
          expect(outcome).toBe("rejected");
          expect(measure(harness)).toEqual(before);
        } finally {
          malformedJsonHead.session.dispose();
        }
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
