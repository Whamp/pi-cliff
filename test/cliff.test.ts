/**
 * Fidelity tests for the Cliff render rules.
 *
 * Every expectation in the fixture table below is text written by upstream CliffCompaction's own
 * `compact()`, not by this port. `scripts/gen-fixtures.py` builds the Anthropic-dialect message dicts
 * behind `test/fixtures/inputs.json`, runs upstream over them, and stores the summary text in
 * `test/fixtures/expected.json`. Each case names the upstream test it mirrors.
 *
 * The comparison covers the summarised region only, with no head section, because upstream forwards
 * its leading messages verbatim instead of rendering them: `renderSummary` reports that region as
 * `headSection`, and `assembleSummary(null, actionParts)` reproduces upstream's text exactly. The
 * generator checks that assumption per case and refuses to write a fixture whose head disagrees.
 *
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assembleSummary,
  canonicalJson,
  countCodePoints,
  DEFAULT_SUMMARY_POLICY,
  renderSummary,
  stripPythonWhitespace,
  stripTaskNotifications,
  SUMMARY_HEADER,
  SUMMARY_HEADER_SEPARATOR,
  SUMMARY_PART_SEPARATOR,
  truncateToCodePoints,
  type CliffJsonValue,
  type OmitReason,
  type SummaryPolicy,
  type SummaryProfile,
  type SummaryUnit,
} from "../src/cliff.js";

/** Thrown when a fixture file does not hold the shape `scripts/gen-fixtures.py` and this file agree on. */
class FixtureParseError extends Error {
  override readonly name = "FixtureParseError";
}

interface FixtureCase {
  name: string;
  mirrors: string;
  units: SummaryUnit[];
  policy: SummaryPolicy;
  profile: SummaryProfile;
  expected: string;
}

interface FixtureSet {
  defaults: SummaryPolicy;
  cases: FixtureCase[];
}

// The functions below decode JSON files, which is the one place `unknown` is allowed to appear:
// everything downstream of them works on the named types above.

function parseObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FixtureParseError(`Cliff fixture ${where}: expected an object`);
  }
  // SAFETY: this is the decode boundary for a JSON file, and the check above established the shape.
  return value as Record<string, unknown>;
}

function parseList(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new FixtureParseError(`Cliff fixture ${where}: expected an array`);
  }
  return value;
}

function parseString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new FixtureParseError(`Cliff fixture ${where}: expected a string`);
  }
  return value;
}

function parseNumber(value: unknown, where: string): number {
  if (typeof value !== "number") {
    throw new FixtureParseError(`Cliff fixture ${where}: expected a number`);
  }
  return value;
}

function parseBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") {
    throw new FixtureParseError(`Cliff fixture ${where}: expected a boolean`);
  }
  return value;
}

function requiredField(object: Record<string, unknown>, key: string, where: string): unknown {
  const value = object[key];
  if (value === undefined) {
    throw new FixtureParseError(`Cliff fixture ${where}: missing ${key}`);
  }
  return value;
}

/** Reads a text node: a plain string, or the `{"$repeat": ["X", 3000]}` shorthand the inputs use. */
function parseText(value: unknown, where: string): string {
  if (typeof value === "string") {
    return value;
  }
  const parts = parseList(requiredField(parseObject(value, where), "$repeat", where), where);
  const [unit, count] = parts;
  return parseString(unit, `${where} $repeat unit`).repeat(
    Math.trunc(parseNumber(count, `${where} $repeat count`)),
  );
}

const NUMERIC_POLICY_KEYS = [
  "thoughtMaxChars",
  "thinkingMaxChars",
  "cmdMaxChars",
  "resultMaxChars",
  "humanMaxChars",
] as const;
const KNOWN_POLICY_KEYS: readonly string[] = [...NUMERIC_POLICY_KEYS, "keepThinking"];

/** Reads a policy overlay, starting from upstream's defaults and rejecting unknown keys. */
function parsePolicy(value: unknown, where: string): SummaryPolicy {
  const object = parseObject(value, where);
  const policy: SummaryPolicy = { ...DEFAULT_SUMMARY_POLICY };
  for (const key of NUMERIC_POLICY_KEYS) {
    const raw = object[key];
    if (raw !== undefined) {
      policy[key] = parseNumber(raw, `${where}.${key}`);
    }
  }
  const keepThinking = object["keepThinking"];
  if (keepThinking !== undefined) {
    policy.keepThinking = parseBoolean(keepThinking, `${where}.keepThinking`);
  }
  const unknown = Object.keys(object).filter((key) => !KNOWN_POLICY_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new FixtureParseError(
      `Cliff fixture ${where}: unknown config keys ${unknown.join(", ")}`,
    );
  }
  return policy;
}

/** Reads one JSON argument value, which is the shape `canonicalJson` is defined over. */
function parseJsonValue(value: unknown, where: string): CliffJsonValue {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      return value;
    case "string":
      return value;
    case "object":
      break;
    default:
      throw new FixtureParseError(`Cliff fixture ${where}: JSON value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${where}[${index}]`));
  }
  const object = parseObject(value, where);
  const members: { [key: string]: CliffJsonValue } = {};
  for (const [key, item] of Object.entries(object)) {
    members[key] = parseJsonValue(item, `${where}.${key}`);
  }
  return members;
}

/**
 * Turns one fixture message into units.
 *
 * This mirrors what `pi-units.ts` does to a real pi message, not the pi mapping itself, which
 * `test/pi-units.test.ts` covers. Keeping the two apart means a fixture mismatch points at a render
 * rule rather than at pi's message shapes.
 */
function parseFixtureMessage(value: unknown, where: string): SummaryUnit[] {
  const message = parseObject(value, where);
  const role = parseString(requiredField(message, "role", where), `${where}.role`);
  if (role === "previousSummary") {
    return [{ kind: "omitted", reason: "previousSummary" }];
  }
  if (role === "system") {
    const texts = parseBlocks(message, where).filter((block) => block.type === "text");
    return [{ kind: "system", text: texts.map((block) => block.text).join("\n") }];
  }
  if (role === "toolResult") {
    const blocks = parseContent(message["content"], `${where}.content`);
    const units: SummaryUnit[] = [{ kind: "result", text: textOf(blocks, where).join("\n") }];
    units.push(...imageOmissions(blocks, where));
    return units;
  }
  const blocks = parseContent(message["blocks"], `${where}.blocks`);
  if (role === "human") {
    const units: SummaryUnit[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        units.push({ kind: "human", text: block.text });
      } else {
        units.push({ kind: "omitted", reason: "image" });
      }
    }
    return units;
  }
  if (role !== "assistant") {
    throw new FixtureParseError(`Cliff fixture ${where}: unknown role ${role}`);
  }
  const thoughts: string[] = [];
  const thinking: string[] = [];
  const calls: { name: string; args: CliffJsonValue }[] = [];
  const units: SummaryUnit[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      thoughts.push(block.text);
    } else if (block.type === "thinking") {
      thinking.push(block.text);
    } else if (block.type === "toolCall") {
      const namespace = block.namespace;
      calls.push({
        name: namespace === undefined ? block.name : `${namespace}.${block.name}`,
        args: block.args,
      });
    } else if (block.type === "redactedThinking") {
      units.push({ kind: "omitted", reason: "redactedThinking" });
    } else {
      units.push({ kind: "omitted", reason: "image" });
    }
  }
  // One assistant message is one unit; the omissions it also produced ride alongside it. Omitted
  // units carry no text, so their position cannot change the rendered bytes.
  return [{ kind: "assistant", thoughts, thinking, calls }, ...units];
}

/** The block kinds the fixture format allows. */
type FixtureBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; name: string; namespace?: string; args: CliffJsonValue }
  | { type: "redactedThinking"; data: string }
  | { type: "image" };

function parseContent(value: unknown, where: string): FixtureBlock[] {
  const blocks: FixtureBlock[] = [];
  for (const [index, item] of parseList(value, where).entries()) {
    const block = parseObject(item, `${where}[${index}]`);
    const type = parseString(requiredField(block, "type", `${where}[${index}]`), `${where}.type`);
    const place = `${where}[${index}] ${type}`;
    if (type === "text") {
      blocks.push({ type: "text", text: parseText(requiredField(block, "text", place), place) });
    } else if (type === "thinking") {
      blocks.push({
        type: "thinking",
        text: parseText(requiredField(block, "text", place), place),
      });
    } else if (type === "toolCall") {
      const namespace = block["namespace"];
      blocks.push({
        type: "toolCall",
        name: parseString(requiredField(block, "name", place), `${place}.name`),
        ...(namespace === undefined
          ? {}
          : { namespace: parseString(namespace, `${place}.namespace`) }),
        args: parseJsonValue(requiredField(block, "args", place), `${place}.args`),
      });
    } else if (type === "redactedThinking") {
      blocks.push({
        type: "redactedThinking",
        data: parseString(requiredField(block, "data", place), `${place}.data`),
      });
    } else if (type === "image") {
      blocks.push({ type: "image" });
    } else {
      throw new FixtureParseError(`Cliff fixture ${place}: unknown block type`);
    }
  }
  return blocks;
}

function textOf(blocks: FixtureBlock[], where: string): string[] {
  void where;
  return blocks.filter((block) => block.type === "text").map((block) => block.text);
}

function imageOmissions(blocks: FixtureBlock[], where: string): SummaryUnit[] {
  void where;
  return blocks
    .filter((block) => block.type === "image")
    .map(() => ({ kind: "omitted", reason: "image" }) as SummaryUnit);
}

function parseBlocks(message: Record<string, unknown>, where: string): FixtureBlock[] {
  return parseContent(message["blocks"], `${where}.blocks`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

/** Loads both fixture files and pairs each case with the text upstream wrote for it. */
function loadFixtures(): FixtureSet {
  const inputs = parseObject(readJson("./fixtures/inputs.json"), "inputs.json");
  const expectations = parseObject(readJson("./fixtures/expected.json"), "expected.json");
  const expectedCases = parseObject(expectations["cases"], "expected.json cases");
  const defaults = parsePolicy(expectations["defaults"], "expected.json defaults");
  const cases: FixtureCase[] = [];
  for (const [index, item] of parseList(inputs["cases"], "inputs.json cases").entries()) {
    const where = `case ${index}`;
    const object = parseObject(item, where);
    const name = parseString(requiredField(object, "name", where), `${where}.name`);
    const config = object["config"] ?? {};
    const units = parseList(object["messages"], `${where}.messages`).flatMap(
      (message, messageIndex) => parseFixtureMessage(message, `${where} message ${messageIndex}`),
    );
    cases.push({
      name,
      mirrors: parseString(requiredField(object, "mirrors", where), `${where}.mirrors`),
      units,
      policy: parsePolicy(object["renderConfig"] ?? config, `${where}.renderConfig`),
      profile: parseString(object["profile"] ?? "manual", `${where}.profile`) as SummaryProfile,
      expected: parseString(requiredField(expectedCases, name, `expected.json ${name}`), name),
    });
  }
  return { defaults, cases };
}

const fixtures = loadFixtures();

describe("Cliff renders what upstream's compact() wrote", () => {
  for (const fixtureCase of fixtures.cases) {
    it(`${fixtureCase.name} mirrors ${fixtureCase.mirrors}`, () => {
      const rendered = renderSummary(fixtureCase.units, fixtureCase.policy, fixtureCase.profile);
      expect(assembleSummary(null, rendered.actionParts)).toBe(fixtureCase.expected);
    });
  }

  it("upstream's own Config defaults are the port's defaults", () => {
    expect(fixtures.defaults).toEqual(DEFAULT_SUMMARY_POLICY);
  });

  it("writes the header alone when no part survives", () => {
    const headerOnly = fixtures.cases.find(
      (item) => item.name === "header_only_when_no_part_survives",
    );
    if (headerOnly === undefined) {
      throw new FixtureParseError("Cliff fixture header_only_when_no_part_survives is missing");
    }
    expect(headerOnly.expected).toBe(SUMMARY_HEADER);
    expect(headerOnly.expected).not.toContain(SUMMARY_PART_SEPARATOR);
  });

  it("drops a previous compaction summary entirely", () => {
    const prior = fixtures.cases.find(
      (item) => item.name === "previous_summary_contributes_nothing",
    );
    if (prior === undefined) {
      throw new FixtureParseError("Cliff fixture previous_summary_contributes_nothing is missing");
    }
    expect(prior.expected).not.toContain("Step 0 of the older cycle");
    expect(prior.expected.split(SUMMARY_HEADER).length - 1).toBe(1);
  });
});

describe("the head section", () => {
  const units: SummaryUnit[] = [
    { kind: "human", text: "  Fix the failing test.\n" },
    { kind: "system", text: "directive: be careful" },
    { kind: "omitted", reason: "image" },
    { kind: "human", text: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>" },
    { kind: "assistant", thoughts: ["step"], thinking: [], calls: [] },
    { kind: "human", text: "later instruction" },
  ];

  it("carries the leading instructions as tagged text, untrimmed and unstripped", () => {
    const rendered = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual");
    // The opening message ends in a newline and head text is never trimmed, so its paragraph carries
    // it and the blank line between paragraphs becomes three newlines. Upstream forwards this message
    // verbatim, and the port keeps the bytes it was given.
    expect(rendered.headSection).toBe(
      "user:   Fix the failing test.\n\n\nsystem: directive: be careful\n\nuser: <task-notification>\n<task-id>abc</task-id>\n</task-notification>",
    );
  });

  it("keeps the head separate from this cycle's action parts", () => {
    const rendered = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual");
    expect(rendered.actionParts).toEqual(["assistant: step", "user: later instruction"]);
    expect(assembleSummary(rendered.headSection, rendered.actionParts)).toContain(
      "Fix the failing test.",
    );
  });

  it("ends the head at a previous compaction summary, which contributes nothing", () => {
    const recompaction: SummaryUnit[] = [
      { kind: "human", text: "the original task" },
      { kind: "omitted", reason: "previousSummary" },
      { kind: "human", text: "a new instruction after the last compaction" },
      { kind: "assistant", thoughts: ["step"], thinking: [], calls: [] },
    ];
    const rendered = renderSummary(recompaction, DEFAULT_SUMMARY_POLICY, "manual");
    expect(rendered.headSection).toBe("user: the original task");
    expect(rendered.actionParts).toEqual([
      "user: a new instruction after the last compaction",
      "assistant: step",
    ]);
    expect(rendered.stats.omissions.previousSummary).toBe(1);
  });

  it("bounds head text by humanMaxChars so one giant paste cannot be permanent", () => {
    const policy: SummaryPolicy = { ...DEFAULT_SUMMARY_POLICY, humanMaxChars: 10 };
    const rendered = renderSummary([{ kind: "human", text: "a".repeat(40) }], policy, "manual");
    expect(rendered.headSection).toBe(`user: ${"a".repeat(10)}...`);
  });

  it("is null when the region holds no text", () => {
    const rendered = renderSummary(
      [
        { kind: "omitted", reason: "image" },
        { kind: "assistant", thoughts: ["x"], thinking: [], calls: [] },
      ],
      DEFAULT_SUMMARY_POLICY,
      "manual",
    );
    expect(rendered.headSection).toBeNull();
    expect(rendered.stats.omissions.image).toBe(1);
  });
});

describe("drop statistics", () => {
  const units: SummaryUnit[] = [
    { kind: "human", text: "task" },
    {
      kind: "assistant",
      thoughts: [],
      thinking: [],
      calls: [{ name: "bash", args: { command: "ls" } }],
    },
    { kind: "result", text: "x".repeat(600) },
    { kind: "result", text: "   " },
    { kind: "omitted", reason: "image" },
    { kind: "omitted", reason: "image" },
    { kind: "omitted", reason: "redactedThinking" },
    { kind: "omitted", reason: "previousSummary" },
    { kind: "omitted", reason: "excludedFromContext" },
  ];
  const rendered = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual");

  it("counts every unit it was given", () => {
    expect(rendered.stats.units).toBe(units.length);
  });

  it("counts parts that survived the action region", () => {
    expect(rendered.stats.actionParts).toBe(rendered.actionParts.length);
    // The leading human unit is head text, and both results and every omission contribute nothing,
    // so only the tool signature survives.
    expect(rendered.stats.actionParts).toBe(1);
  });

  it("tallies each drop reason, including the ones the result rule decides", () => {
    const omissions: Record<OmitReason, number> = rendered.stats.omissions;
    expect(omissions).toEqual({
      image: 2,
      redactedThinking: 1,
      previousSummary: 1,
      excludedFromContext: 1,
      longToolResult: 1,
      emptyToolResult: 1,
    });
  });

  it("does not change the caller's units and is deterministic", () => {
    const copy = structuredClone(units);
    const again = renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual");
    expect(units).toEqual(copy);
    expect(again).toEqual(rendered);
  });
});

describe("caps count code points, not UTF-16 units", () => {
  const astral = "\u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}";

  it("counts astral characters as one character each", () => {
    expect(countCodePoints(astral)).toBe(5);
    expect(astral.length).toBe(10);
  });

  it("truncates between code points so an astral character is never split", () => {
    expect(truncateToCodePoints(astral, 3)).toBe("\u{1f600}\u{1f601}\u{1f602}...");
    expect(countCodePoints(truncateToCodePoints(astral, 3))).toBe(6);
  });

  it("leaves text at or below the cap alone, and treats 0 as unlimited", () => {
    expect(truncateToCodePoints(astral, 5)).toBe(astral);
    expect(truncateToCodePoints(astral, 0)).toBe(astral);
    expect(truncateToCodePoints(astral, -1)).toBe(astral);
  });

  it("applies the cap by code points through the render rules too", () => {
    const policy: SummaryPolicy = { ...DEFAULT_SUMMARY_POLICY, thoughtMaxChars: 2 };
    const rendered = renderSummary(
      [{ kind: "assistant", thoughts: [astral], thinking: [], calls: [] }],
      policy,
      "manual",
    );
    expect(rendered.actionParts).toEqual([`assistant: \u{1f600}\u{1f601}...`]);
  });
});

describe("Python's whitespace and escaping rules", () => {
  it("strips the characters Python strips that String.prototype.trim leaves", () => {
    expect(stripPythonWhitespace("\u001c\u0085 padded \u001f\u0085")).toBe("padded");
    expect(stripPythonWhitespace("\u00a0padded\u00a0")).toBe("padded");
    // JavaScript trims none of U+001C-U+001F or U+0085, so trim() returns this unchanged.
    expect("\u001c\u0085 padded \u001f\u0085".trim()).toBe("\u001c\u0085 padded \u001f\u0085");
  });

  it("does not strip U+FEFF, which Python's str.strip does not treat as space", () => {
    expect(stripPythonWhitespace("\ufeffpadded")).toBe("\ufeffpadded");
  });

  it("strips only the ends and keeps interior whitespace", () => {
    expect(stripPythonWhitespace("  a\tb  ")).toBe("a\tb");
  });

  it("removes task-notification blocks with their trailing whitespace", () => {
    expect(
      stripTaskNotifications(
        "<task-notification>\n<task-id>a</task-id>\n</task-notification>\nkept",
      ),
    ).toBe("kept");
  });

  it("applies notification stripping to human text only", () => {
    const notification = "<task-notification>\n<task-id>a</task-id>\n</task-notification>";
    const rendered = renderSummary(
      [
        { kind: "assistant", thoughts: ["working"], thinking: [], calls: [] },
        { kind: "human", text: `${notification}\nplease use the dev branch` },
        { kind: "system", text: `read ${notification} first` },
      ],
      DEFAULT_SUMMARY_POLICY,
      "manual",
    );
    expect(rendered.actionParts).toEqual([
      "assistant: working",
      "user: please use the dev branch",
      `system: read ${notification} first`,
    ]);
  });
});

describe("canonicalJson", () => {
  it("sorts keys by code point, including keys that UTF-16 order would get wrong", () => {
    const args: CliffJsonValue = { "\uffee": 1, "\u{1f600}": 2, b: 3, "10": 4, "2": 5 };
    // U+FFEE is one UTF-16 unit at 0xFFEE and U+1F600 leads with the surrogate 0xD83D, so a UTF-16
    // comparison puts the emoji first. Python's code-point order does not.
    expect(canonicalJson(args)).toBe('{"10":4,"2":5,"b":3,"\uffee":1,"\u{1f600}":2}');
  });

  it("drops the spaces JSON.stringify would keep and keeps non-ASCII raw", () => {
    expect(canonicalJson({ b: [1, "中", null, true, { c: 1 }], a: "café" })).toBe(
      '{"a":"café","b":[1,"中",null,true,{"c":1}]}',
    );
  });

  it("escapes only what Python escapes, in lowercase hex", () => {
    expect(canonicalJson('\b\t\n\f\r\u0000\u001f\u007f"\\{')).toBe(
      '"\\b\\t\\n\\f\\r\\u0000\\u001f\u007f\\"\\\\{"',
    );
  });

  it("writes a lone surrogate raw, as Python does, where JSON.stringify would escape it", () => {
    const lone = `a${String.fromCharCode(0xd800)}b`;
    expect(canonicalJson(lone)).toBe(`"${lone}"`);
    expect(JSON.stringify(lone)).toBe('"a\\ud800b"');
  });

  it("refuses a number with no JSON representation instead of writing one", () => {
    expect(() => canonicalJson(Number.NaN)).toThrowError(/non-finite number/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrowError(/non-finite number/);
    expect(() => canonicalJson([Number.NaN])).toThrowError(/non-finite number/);
  });

  it("writes integral values as integers and fractional ones the way repr does", () => {
    expect(canonicalJson(1)).toBe("1");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(2)).toBe("2");
    expect(canonicalJson(0.5)).toBe("0.5");
    expect(canonicalJson(-1.25)).toBe("-1.25");
  });
});

describe("assembleSummary", () => {
  it("puts the byte-exact header first, a blank line, then parts divided by rules", () => {
    expect(assembleSummary(null, ["a", "b"])).toBe(
      `${SUMMARY_HEADER}${SUMMARY_HEADER_SEPARATOR}a${SUMMARY_PART_SEPARATOR}b`,
    );
  });

  it("renders the header alone when nothing survives", () => {
    expect(assembleSummary(null, [])).toBe(SUMMARY_HEADER);
  });

  it("places the head section ahead of the action parts", () => {
    expect(assembleSummary("user: task", ["assistant: step"])).toBe(
      `${SUMMARY_HEADER}${SUMMARY_HEADER_SEPARATOR}user: task${SUMMARY_PART_SEPARATOR}assistant: step`,
    );
    expect(assembleSummary("user: task", [])).toBe(
      `${SUMMARY_HEADER}${SUMMARY_HEADER_SEPARATOR}user: task`,
    );
  });

  it("keeps the header byte-exact", () => {
    expect(SUMMARY_HEADER).toBe(
      "The following is a summary of your previous actions (long observations omitted):",
    );
  });
});

describe("profiles", () => {
  const units: SummaryUnit[] = [
    {
      kind: "assistant",
      thoughts: ["y".repeat(400)],
      thinking: ["reasoning that only the configured profile keeps"],
      calls: [{ name: "bash", args: { command: "make" } }],
    },
  ];

  it("treats manual and threshold the same, both on the configured rules", () => {
    expect(renderSummary(units, DEFAULT_SUMMARY_POLICY, "threshold")).toEqual(
      renderSummary(units, DEFAULT_SUMMARY_POLICY, "manual"),
    );
  });

  it("drops thinking and caps assistant text at 300 on overflow", () => {
    const overflow = renderSummary(units, DEFAULT_SUMMARY_POLICY, "overflow");
    expect(overflow.actionParts[0]).toContain(`${"y".repeat(300)}...`);
    expect(overflow.actionParts[0]).not.toContain("thinking:");
    expect(overflow.actionParts[0]).toContain('[bash] {"command":"make"}');
  });

  it("keeps a thought cap tighter than 300 when one is configured", () => {
    const policy: SummaryPolicy = { ...DEFAULT_SUMMARY_POLICY, thoughtMaxChars: 100 };
    const overflow = renderSummary(units, policy, "overflow");
    expect(overflow.actionParts[0]).toContain(`${"y".repeat(100)}...`);
  });

  it("keeps thinking caps independent of thought caps", () => {
    const policy: SummaryPolicy = {
      ...DEFAULT_SUMMARY_POLICY,
      thoughtMaxChars: 5,
      thinkingMaxChars: 9,
    };
    const rendered = renderSummary(units, policy, "manual");
    expect(rendered.actionParts[0]).toBe(
      `thinking: reasoning...\nassistant: yyyyy...\n[bash] {"command":"make"}`,
    );
  });
});
