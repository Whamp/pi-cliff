/**
 * Tests for the pi projection, one case per role pi can put in `messagesToSummarize`.
 *
 * These use real pi objects, typed as pi's own message union, so pi's required fields and block
 * shapes are checked by the compiler rather than by a fixture someone maintained.
 *
 * Three of pi's roles have no upstream analogue at all: `bashExecution`, `custom`, and
 * `branchSummary`. For those, the oracle is pi itself: `convertToLlm` is what pi hands the model, so
 * the text this module folds must be the text pi would have sent. `compactionSummary` is the one role
 * where the port deliberately disagrees with pi's projection, because a summary an earlier cycle wrote
 * is dropped rather than merged forward, and that is asserted too.
 */

import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  assembleSummary,
  DEFAULT_SUMMARY_POLICY,
  renderSummary,
  SUMMARY_HEADER,
  type SummaryUnit,
} from "../src/cliff.js";
import { CliffMessageMappingError, toSummaryUnits, type PiAgentMessage } from "../src/pi-units.js";

const TIMESTAMP = 1_700_000_000_000;

/** Required by pi's assistant messages; the summary does not read any of it. */
const USAGE = {
  input: 1200,
  output: 80,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1280,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The text pi would have sent for a message, with its text blocks folded as one observation. */
function piContextText(message: PiAgentMessage): string {
  const [converted] = convertToLlm([message]);
  if (converted === undefined) {
    throw new Error("Cliff test: pi projects this message to nothing");
  }
  if (converted.role !== "user") {
    throw new Error(`Cliff test: pi projects this message to role ${converted.role}`);
  }
  if (typeof converted.content === "string") {
    return converted.content;
  }
  return converted.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** The text of every unit that carries a single text, in order. */
function textOfUnits(units: readonly SummaryUnit[]): string[] {
  return units.flatMap((unit) =>
    unit.kind === "assistant" || unit.kind === "omitted" ? [] : [unit.text],
  );
}

function renderUnits(units: readonly SummaryUnit[]): string {
  const rendered = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual");
  return assembleSummary(rendered.headSection, rendered.actionParts);
}

describe("system messages", () => {
  it("folds a string directive as one instruction", () => {
    const message = {
      role: "system",
      content: "directive: be careful",
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    expect(toSummaryUnits([message])).toEqual([{ kind: "system", text: "directive: be careful" }]);
  });

  it("joins text blocks and leaves the standing prompt sections out", () => {
    const message = {
      role: "system",
      content: [
        { type: "text", text: "first instruction" },
        { type: "text", text: "second instruction" },
      ],
      sections: { "project-context": "the standing prompt pi re-sends anyway" },
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([message]);
    expect(units).toEqual([{ kind: "system", text: "first instruction\nsecond instruction" }]);
    expect(renderUnits(toSummaryUnits([message]))).not.toContain("standing prompt");
  });

  it("renders as an instruction, not as an observation", () => {
    expect(
      renderUnits(
        toSummaryUnits([{ role: "system", content: "be careful", timestamp: TIMESTAMP }]),
      ),
    ).toBe(`${SUMMARY_HEADER}\n\nsystem: be careful`);
  });
});

describe("user messages", () => {
  it("keeps each text block as its own unit", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "first thing" },
        { type: "text", text: "second thing" },
      ],
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    expect(toSummaryUnits([message])).toEqual([
      { kind: "human", text: "first thing" },
      { kind: "human", text: "second thing" },
    ]);
  });

  it("accepts the string form of content", () => {
    const message = {
      role: "user",
      content: "just the task",
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    expect(toSummaryUnits([message])).toEqual([{ kind: "human", text: "just the task" }]);
  });

  it("counts an image as a counted omission and keeps its text sibling", () => {
    const message = {
      role: "user",
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "see the screenshot" },
      ],
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    expect(toSummaryUnits([message])).toEqual([
      { kind: "omitted", reason: "image" },
      { kind: "human", text: "see the screenshot" },
    ]);
  });

  it("caps the two blocks on their own, so the first cannot starve the second", () => {
    const units = toSummaryUnits([
      {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        api: "anthropic",
        provider: "anthropic",
        model: "m",
        usage: USAGE,
        stopReason: "stop",
        timestamp: TIMESTAMP,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(30) },
          { type: "text", text: "short" },
        ],
        timestamp: TIMESTAMP,
      },
    ]);
    const policy = { ...DEFAULT_SUMMARY_POLICY, userTextMaxChars: 10 };
    const rendered = renderSummary(units, policy, "manual");
    expect(rendered.actionParts).toEqual([
      "assistant: working",
      `user: ${"a".repeat(10)}...`,
      "user: short",
    ]);
  });
});

describe("assistant messages", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "the mock is the real bug" },
      { type: "text", text: "inspecting the test" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pytest -x" } },
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "claude-test",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: TIMESTAMP,
  } satisfies PiAgentMessage;

  it("groups one message into one unit carrying all three content classes", () => {
    expect(toSummaryUnits([message])).toEqual([
      {
        kind: "assistant",
        thoughts: ["inspecting the test"],
        thinking: ["the mock is the real bug"],
        calls: [{ name: "bash", args: { command: "pytest -x" } }],
      },
    ]);
  });

  it("renders thinking, then text, then the tool signature, as one part", () => {
    const units: SummaryUnit[] = [
      ...toSummaryUnits([{ role: "user", content: "task", timestamp: TIMESTAMP }]),
      ...toSummaryUnits([message]),
    ];
    expect(renderUnits(units)).toBe(
      `${SUMMARY_HEADER}\n\nuser: task\n\n---\n\nthinking: the mock is the real bug\nassistant: inspecting the test\n[bash] {"command":"pytest -x"}`,
    );
  });

  it("counts redacted thinking as an omission and never leaks its payload", () => {
    const redacted = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "ENCRYPTED-BLOB", redacted: true },
        { type: "text", text: "visible text" },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-test",
      usage: USAGE,
      stopReason: "stop",
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([redacted]);
    expect(units).toEqual([
      { kind: "assistant", thoughts: ["visible text"], thinking: [], calls: [] },
      { kind: "omitted", reason: "redactedThinking" },
    ]);
    expect(renderUnits(units)).not.toContain("ENCRYPTED-BLOB");
  });

  it("joins a namespaced tool call into the one name upstream has", () => {
    const namespaced = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "search",
          namespace: "github",
          arguments: { query: "cliff" },
        },
      ],
      api: "openai",
      provider: "openai",
      model: "gpt-test",
      usage: USAGE,
      stopReason: "toolUse",
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([namespaced]);
    const parts = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual").actionParts;
    expect(parts).toEqual(['[github.search] {"query":"cliff"}']);
  });

  it("never merges blocks from separate messages", () => {
    const one = {
      ...message,
      content: [{ type: "text", text: "first turn" }],
    } satisfies PiAgentMessage;
    const two = {
      ...message,
      content: [{ type: "text", text: "second turn" }],
    } satisfies PiAgentMessage;
    const parts = renderSummary(
      toSummaryUnits([one, two]),
      DEFAULT_SUMMARY_POLICY,
      "manual",
    ).actionParts;
    expect(parts).toEqual(["assistant: first turn", "assistant: second turn"]);
  });
});

describe("tool results", () => {
  it("folds the text blocks of one result into one observation", () => {
    const message = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
      isError: false,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    expect(toSummaryUnits([message])).toEqual([
      { kind: "result", text: "first line\nsecond line" },
    ]);
  });

  it("counts an image attached to a result and keeps its text", () => {
    const message = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [
        { type: "text", text: "the text part" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    expect(toSummaryUnits([message])).toEqual([
      { kind: "result", text: "the text part" },
      { kind: "omitted", reason: "image" },
    ]);
  });

  it("drops a long result whole and keeps a short one", () => {
    const shortResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "test_1 passed" }],
      isError: false,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const longResult = {
      ...shortResult,
      content: [{ type: "text", text: "x".repeat(501) }],
    } satisfies PiAgentMessage;
    const rendered = renderSummary(
      toSummaryUnits([shortResult, longResult]),
      DEFAULT_SUMMARY_POLICY,
      "manual",
    );
    expect(rendered.actionParts).toEqual(["result: test_1 passed"]);
    expect(rendered.stats.omissions.longToolResult).toBe(1);
  });
});

describe("bash executions", () => {
  /** One `!` command, with every pi field named so the cases stay readable. */
  function bashExecution(fields: {
    output: string;
    exitCode: number;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath: string;
    excludeFromContext: boolean;
  }): PiAgentMessage {
    return { role: "bashExecution", command: "pytest -x", timestamp: TIMESTAMP, ...fields };
  }

  const shown = {
    output: "1 passed",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    fullOutputPath: "",
    excludeFromContext: false,
  };

  it("folds a shown execution into Pi's exact human text", () => {
    const message = bashExecution(shown);
    expect(toSummaryUnits([message])).toEqual([{ kind: "human", text: piContextText(message) }]);
  });

  it("reports the exit code and the truncation pointer the way pi does", () => {
    const message = bashExecution({
      ...shown,
      output: "",
      exitCode: 2,
      truncated: true,
      fullOutputPath: "/tmp/pi/out.txt",
    });
    expect(textOfUnits(toSummaryUnits([message]))).toEqual([piContextText(message)]);
  });

  it("notes a cancelled command the way pi does", () => {
    const message = bashExecution({ ...shown, cancelled: true });
    expect(textOfUnits(toSummaryUnits([message]))).toEqual([piContextText(message)]);
  });

  it("omits an execution the user kept out of context with !!", () => {
    const message = bashExecution({ ...shown, excludeFromContext: true });
    expect(toSummaryUnits([message])).toEqual([{ kind: "omitted", reason: "excludedFromContext" }]);
    expect(convertToLlm([message])).toEqual([]);
  });

  it("preserves Pi's bash text even when it exceeds the tool-result cap", () => {
    const message = bashExecution({ ...shown, output: "x".repeat(900) });
    const rendered = renderSummary(toSummaryUnits([message]), DEFAULT_SUMMARY_POLICY, "manual");
    expect(rendered.headSection).toBe(`user: ${piContextText(message)}`);
    expect(rendered.stats.omissions.longToolResult).toBe(0);
  });
});

describe("custom messages", () => {
  it("folds a string body as human text, as pi sends it", () => {
    const message = {
      role: "custom",
      customType: "note",
      content: "a note an extension injected",
      display: false,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([message]);
    expect(units).toEqual([{ kind: "human", text: "a note an extension injected" }]);
    expect(textOfUnits(units)).toEqual([piContextText(message)]);
  });

  it("keeps block content split the way a user message is", () => {
    const message = {
      role: "custom",
      customType: "note",
      content: [
        { type: "text", text: "first part" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "second part" },
      ],
      display: true,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([message]);
    expect(units).toEqual([
      { kind: "human", text: "first part" },
      { kind: "omitted", reason: "image" },
      { kind: "human", text: "second part" },
    ]);
    expect(textOfUnits(units).join("\n")).toBe(piContextText(message));
  });
});

describe("branch summaries", () => {
  it("keeps a branch summary as the framed text pi sends", () => {
    const message = {
      role: "branchSummary",
      summary: "explored the alternative branch and abandoned it",
      fromId: null,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([message]);
    expect(textOfUnits(units)).toEqual([piContextText(message)]);
    expect(renderUnits(units)).toContain("summary of a branch");
  });
});

describe("compaction summaries", () => {
  it("contributes nothing, which is the rule that stops summaries merging forward", () => {
    const message = {
      role: "compactionSummary",
      summary: "assistant: step 0 of the older cycle",
      tokensBefore: 90_000,
      timestamp: TIMESTAMP,
    } satisfies PiAgentMessage;
    const units = toSummaryUnits([message]);
    expect(units).toEqual([{ kind: "omitted", reason: "previousSummary" }]);
    expect(renderUnits(units)).toBe(SUMMARY_HEADER);
    // pi does send this text to the model, inside its own wrapper. Dropping it is the port's choice.
    expect(piContextText(message)).toContain("older cycle");
  });

  it("ends the head region, so a later cycle cannot absorb the new instructions", () => {
    const units = toSummaryUnits([
      { role: "user", content: "the original task", timestamp: TIMESTAMP },
      {
        role: "compactionSummary",
        summary: "an older summary",
        tokensBefore: 1,
        timestamp: TIMESTAMP,
      },
      { role: "user", content: "a newer instruction", timestamp: TIMESTAMP },
      {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        api: "anthropic",
        provider: "anthropic",
        model: "m",
        usage: USAGE,
        stopReason: "stop",
        timestamp: TIMESTAMP,
      },
    ]);
    const rendered = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual");
    expect(rendered.headSection).toBe("user: the original task");
    expect(rendered.actionParts).toEqual(["user: a newer instruction", "assistant: working"]);
  });
});

describe("a role this version cannot project", () => {
  it("throws a named error rather than guessing a content class", () => {
    const future = {
      role: "someNewRole",
      content: "text",
      timestamp: TIMESTAMP,
    } as unknown as PiAgentMessage;
    expect(() => toSummaryUnits([future])).toThrowError(CliffMessageMappingError);
  });
});

describe("a whole turn", () => {
  it("renders the parts in message order, with the opening instruction carried as the head", () => {
    const messages = [
      { role: "system", content: "stay in the sandbox", timestamp: TIMESTAMP },
      { role: "user", content: "fix the failing test", timestamp: TIMESTAMP },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "the fixture is stale" },
          { type: "text", text: "reading the test" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "test/app.test.ts" } },
        ],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-test",
        usage: USAGE,
        stopReason: "toolUse",
        timestamp: TIMESTAMP,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "assert value == 2" }],
        isError: false,
        timestamp: TIMESTAMP,
      },
      {
        role: "bashExecution",
        command: "pytest -x",
        output: "1 passed",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: TIMESTAMP,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "fixed, the fixture was stale" }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-test",
        usage: USAGE,
        stopReason: "stop",
        timestamp: TIMESTAMP,
      },
    ] satisfies PiAgentMessage[];

    expect(renderUnits(toSummaryUnits(messages))).toBe(
      `${SUMMARY_HEADER}\n\n` +
        "system: stay in the sandbox\n\nuser: fix the failing test\n\n---\n\n" +
        'thinking: the fixture is stale\nassistant: reading the test\n[read] {"path":"test/app.test.ts"}\n\n---\n\n' +
        "result: assert value == 2\n\n---\n\n" +
        "user: Ran `pytest -x`\n```\n1 passed\n```\n\n---\n\n" +
        "assistant: fixed, the fixture was stale",
    );
  });
});
