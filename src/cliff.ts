/**
 * Cliff's pi-free summary core: the content-class render table, code-point caps, and canonical JSON.
 *
 * Rule sources are upstream CliffCompaction revision `b48d660` (see NOTICE.md), cited below by file
 * and function. This module imports nothing from pi, reads no files, and reads no clock, so the same
 * units always render to the same bytes.
 */

/**
 * Marker that opens every Cliff summary, and the token by which an earlier summary is recognised.
 *
 * Byte-exact upstream `SUMMARY_HEADER` (`dialects/base.py`), which upstream documents as frozen:
 * changing a byte breaks recognition of summaries written by earlier versions. `test/cliff.test.ts`
 * proves byte-exactness against text produced by upstream's own `compact()`.
 */
export const SUMMARY_HEADER =
  "The following is a summary of your previous actions (long observations omitted):";

/** Separator between summary parts, upstream `cliff.compact` (`"\n\n---\n\n"`). */
export const SUMMARY_PART_SEPARATOR = "\n\n---\n\n";

/**
 * What separates the header from the first part: a blank line, not a part separator.
 *
 * Upstream `cliff.compact` writes `SUMMARY_HEADER + "\n\n" + "\n\n---\n\n".join(parts)`, so the rule
 * line that divides two parts appears only between parts.
 */
export const SUMMARY_HEADER_SEPARATOR = "\n\n";

/**
 * Characters pi adds around a stored compaction summary when it rebuilds the model context.
 *
 * Measured, not invented: pi 0.87.1 `dist/core/messages.js` renders a `compactionSummary` message as
 * `COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX`, where the prefix is the 96
 * characters `"The conversation history before this point was compacted into the following
 * summary:\n\n<summary>\n"` and the suffix is the 11 characters `"\n</summary>"`. pi stores the
 * summary text untouched (`session-manager.js` `appendCompaction`), so this framing is the only
 * overhead between the text Cliff writes and the text the provider receives.
 */
export const PI_SUMMARY_WRAPPER_CHARS = 107;

/**
 * Upstream's per-part allowance in the rung-3 accounting: `used += len(part) + 9`
 * (`spec-proxy.md` §2, "Rung 3 exact arithmetic"). The literal separator is 7 characters; upstream
 * reserves 9 and does not explain the difference, so the number is carried over unchanged.
 */
const TRUNCATION_PART_OVERHEAD_CHARS = 9;

const HUMAN_PART_PREFIX = "user: ";
const SYSTEM_PART_PREFIX = "system: ";
const ASSISTANT_PART_PREFIX = "assistant: ";
const THINKING_PART_PREFIX = "thinking: ";
const RESULT_PART_PREFIX = "result: ";

/**
 * A reason a piece of content contributed nothing to the summary.
 *
 * `longToolResult` and `emptyToolResult` are counted by the `result` render rule, because only the
 * configured cap decides whether a `result` unit survives. The others arrive as `omitted` units from
 * `pi-units.ts`, where the content class itself is unrepresentable in a mechanical summary.
 */
export type OmitReason =
  | "image"
  | "redactedThinking"
  | "previousSummary"
  | "excludedFromContext"
  | "longToolResult"
  | "emptyToolResult";

/** Drop tallies keyed by reason, so a new reason cannot be silently missing from a report. */
export type OmissionCounts = { [reason in OmitReason]: number };

function emptyOmissionCounts(): OmissionCounts {
  return {
    image: 0,
    redactedThinking: 0,
    previousSummary: 0,
    excludedFromContext: 0,
    longToolResult: 0,
    emptyToolResult: 0,
  };
}

/** A JSON value, structural twin of pi's `JsonValue`, so the core needs no pi import. */
export type CliffJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CliffJsonValue[]
  | CliffJsonObject;

/** An object member of {@link CliffJsonValue}. Keys are always strings, as in JSON. */
export interface CliffJsonObject {
  [key: string]: CliffJsonValue;
}

/** One tool invocation, rendered as upstream's signature line `[name] {args}`. */
export interface ToolSignature {
  /** Tool name as the model saw it. pi namespaced calls arrive pre-joined as `namespace.name`. */
  name: string;
  /** Arguments, serialised to canonical JSON when the line is rendered. */
  args: CliffJsonValue;
}

/** One assistant message: its thinking blocks, its visible text blocks, and its tool calls. */
export interface AssistantUnit {
  kind: "assistant";
  /** Visible text blocks. Joined with newlines, then capped once by `thoughtMaxChars`. */
  readonly thoughts: readonly string[];
  /** Thinking-block text. Joined with newlines, then capped once by `thinkingMaxChars`. */
  readonly thinking: readonly string[];
  /** Tool calls in message order. Always rendered, whatever the caps on text. */
  readonly calls: readonly ToolSignature[];
}

/** One human text block. Each block of a multi-block message is its own unit and its own cap. */
export interface HumanUnit {
  kind: "human";
  text: string;
}

/** One in-array system directive, which folds as an instruction rather than an observation. */
export interface SystemUnit {
  kind: "system";
  text: string;
}

/** One tool result. Whether it survives is the `result` rule's decision, not the mapper's. */
export interface ResultUnit {
  kind: "result";
  text: string;
}

/** Content that a mechanical summary cannot carry, recorded so the loss is countable. */
export interface OmittedUnit {
  kind: "omitted";
  reason: OmitReason;
}

/**
 * One unit of summarisable content, one member per upstream content class.
 *
 * Upstream aggregates an assistant message's thinking, text, and tool signatures into a single part,
 * so that member is a group. Blocks from separate messages never merge.
 */
export type SummaryUnit = AssistantUnit | HumanUnit | SystemUnit | ResultUnit | OmittedUnit;

/** Caps and switches that decide how much of each content class survives. */
export interface SummaryPolicy {
  /** Assistant text budget per message. `0` means unlimited. */
  thoughtMaxChars: number;
  /** Thinking text budget per message, independent of `thoughtMaxChars`. `0` means unlimited. */
  thinkingMaxChars: number;
  /** Tool-call argument budget per call. `0` means unlimited. */
  cmdMaxChars: number;
  /** Tool results longer than this are dropped whole. `0` drops every non-empty result. */
  resultMaxChars: number;
  /** Human and system text budget per block. `0` means unlimited. */
  humanMaxChars: number;
  /** When false, thinking text is dropped entirely instead of capped. */
  keepThinking: boolean;
}

/** Upstream `Config` defaults for the summarisation knobs (`config.py`). */
export const DEFAULT_SUMMARY_POLICY: SummaryPolicy = {
  thoughtMaxChars: 0,
  thinkingMaxChars: 0,
  cmdMaxChars: 150,
  resultMaxChars: 500,
  humanMaxChars: 20_000,
  keepThinking: true,
};

/**
 * Which trigger produced this summary, matching pi's `session_before_compact` reason values.
 *
 * `overflow` is the only profile that changes the rules; see {@link resolveSummaryPolicy}.
 */
export type SummaryProfile = "manual" | "threshold" | "overflow";

/** Assistant text cap forced on the overflow profile when the configured cap is looser. */
const OVERFLOW_THOUGHT_MAX_CHARS = 300;

/** What one unit contributed: surviving parts, and the reasons anything was dropped. */
export interface RenderOutcome {
  /** Parts in upstream's order. Empty when the unit's content did not survive. */
  parts: string[];
  omissions: OmitReason[];
}

/** The rendered candidate summary, split so the head can never be evicted by truncation. */
export interface SummaryRender {
  /**
   * The opening instructions as tagged, capped text, or `null` when the head region held none.
   *
   * Kept out of `actionParts` because it is carried across compactions in the caller's own details,
   * and eviction on overflow must never take it.
   */
  headSection: string | null;
  actionParts: string[];
  stats: SummaryStats;
}

/** Counts for the post-compaction notification and for `details.cliff`. */
export interface SummaryStats {
  /** Units handed to the renderer, head region included. */
  units: number;
  /** Parts that survived from the action region. */
  actionParts: number;
  /** Drop tallies by reason, counted across the head and action regions alike. */
  omissions: OmissionCounts;
}

/**
 * Counts Unicode code points, which is what Python's `len()` counts and what every cap means.
 *
 * `String.prototype.length` counts UTF-16 units, so it overcounts every astral character by one.
 */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Truncates to `maxChars` Unicode code points and appends `...`, as upstream `truncate` does.
 *
 * `maxChars <= 0` means unlimited, which is upstream's meaning of `0` and of a falsy cap. The cut is
 * made between code points, so an astral character is never split into lone surrogates.
 */
export function truncateToCodePoints(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return text;
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) {
    return text;
  }
  return `${codePoints.slice(0, maxChars).join("")}...`;
}

/**
 * Strips the characters Python's `str.strip()` strips, which is not what `String.prototype.trim`
 * removes: Python also strips U+001C–U+001F and U+0085, and does not strip U+FEFF.
 *
 * Measured on Python 3.14: `chr(c).isspace()` is true exactly for U+0009–U+000D, U+001C–U+0020,
 * U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028–U+2029, U+202F, U+205F, and U+3000. Upstream strips
 * with `str.strip()` in `dialects/anthropic.py`, so a summary of text that leads with a record
 * separator would otherwise keep a character upstream drops.
 */
export function stripPythonWhitespace(text: string): string {
  return text.replace(PYTHON_LEADING_WHITESPACE, "").replace(PYTHON_TRAILING_WHITESPACE, "");
}

/** The characters Python's `str.strip()` removes, from the measured set above. One source, two anchors. */
const PYTHON_WHITESPACE_CLASS =
  "\\t-\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_LEADING_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE_CLASS}]+`);
const PYTHON_TRAILING_WHITESPACE = new RegExp(`[${PYTHON_WHITESPACE_CLASS}]+$`);

/** Matches one `<task-notification>` block and the whitespace after it, as upstream's regex does. */
const TASK_NOTIFICATION_PATTERN = /<task-notification>.*?<\/task-notification>\s*/gs;

/**
 * Removes harness-injected `<task-notification>` blocks, upstream `strip_task_notifications`.
 *
 * Upstream strips these from human text only: the assistant restates the result in its next message
 * and the notification's output paths are temporary. The port applies it to the same one class, so
 * system directives and carried head text keep their notification blocks.
 */
export function stripTaskNotifications(text: string): string {
  return text.replace(TASK_NOTIFICATION_PATTERN, "");
}

/**
 * Serialises a value the way `json.dumps(obj, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` does, because tool-call signatures in the summary are that exact text.
 *
 * Where Python and JavaScript cannot be made to agree, this function pins the JavaScript side:
 *
 * - Keys are sorted by Unicode code point. `Array.prototype.sort` on strings compares UTF-16 units,
 *   which orders astral characters before U+E000–U+FFFF, the opposite of Python.
 * - Non-ASCII is written raw, and only `"`, `\`, and U+0000–U+001F are escaped, with `\b \t \n \f \r`
 *   named and the rest as lowercase `\uXXXX`. `JSON.stringify` instead escapes lone surrogates, which
 *   Python writes raw (verified on Python 3.14).
 * - Numbers: an integral value is written as integer digits, because Python writes the `int` it
 *   parsed from the JSON literal that way. Exact for |value| <= 9007199254740991
 *   (`Number.MAX_SAFE_INTEGER`); above that the digits of the IEEE-754 double are written, which
 *   agrees with upstream only when the original JSON integer is exactly representable. A
 *   non-integral value is written with Python's `repr` rules: shortest round-tripping digits, which
 *   ECMAScript and CPython compute identically, in fixed notation unless the decimal exponent is
 *   <= -4 or > 16, then `d.dddde±XX` with a signed, two-digit-minimum exponent.
 * - A JSON literal that is integral but written with a fraction or exponent, such as `3.0`, is where
 *   the two languages genuinely cannot agree: a JavaScript number carries no int/float tag, so this
 *   writes `3` where upstream writes `3.0`. Every magnitude at or above 2^53 is in that class, because
 *   a double that large has no fractional part, so `1.0e+16` and `1.7976931348623157e308` are
 *   upstream's rendering, not ours. Such literals are excluded from the fixtures and the behaviour is
 *   documented here rather than hidden.
 * - Non-finite numbers cannot be represented in JSON at all. Upstream writes the non-JSON tokens
 *   `NaN` and `Infinity`; this throws, because a summary that is not parseable is worse than no
 *   summary, and {@link CliffCanonicalizationError} is a fail-open path.
 *
 * @throws {CliffCanonicalizationError} When a number has no JSON representation.
 */
export function canonicalJson(value: CliffJsonValue): string {
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatCanonicalJsonNumber(value);
    case "string":
      return encodeCanonicalJsonString(value);
    case "object": {
      if (value === null) {
        return "null";
      }
      if (Array.isArray(value)) {
        return `[${value.map((item: CliffJsonValue) => canonicalJson(item)).join(",")}]`;
      }
      const members: [string, CliffJsonValue][] = Object.entries(value);
      members.sort(([left], [right]) => compareCodePointOrder(left, right));
      const rendered = members.map(
        ([key, item]) => `${encodeCanonicalJsonString(key)}:${canonicalJson(item)}`,
      );
      return `{${rendered.join(",")}}`;
    }
    default: {
      const unhandled: never = value;
      throw new CliffCanonicalizationError(
        `Cliff canonical JSON encountered a value outside CliffJsonValue: ${String(unhandled)}`,
      );
    }
  }
}

/** Thrown when a tool-call value has no faithful JSON text, which cancels compaction upstream-style. */
export class CliffCanonicalizationError extends Error {
  override readonly name = "CliffCanonicalizationError";
}

/**
 * Writes a number the way `json.dumps` writes the value Python parsed from a JSON number literal.
 *
 * See {@link canonicalJson} for the supported range and the two places Python cannot be reproduced.
 */
function formatCanonicalJsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CliffCanonicalizationError(
      `Cliff canonical JSON cannot serialize the non-finite number ${String(value)}`,
    );
  }
  if (Number.isInteger(value)) {
    // Python writes the int it parsed, so write integer digits. `BigInt` keeps digits exact for the
    // whole double range, where `String(value)` would switch to exponent form at 1e21.
    return BigInt(value).toString();
  }
  return formatPythonFloatRepr(value);
}

/** Decimal digits and decimal exponent of a positive number, the way CPython's dtoa reports them. */
interface ShortestDigits {
  /** Significant digits with no leading zeros and no decimal point. */
  digits: string;
  /** Position of the decimal point relative to `digits`, so value = 0.digits * 10 ** decpt. */
  decpt: number;
}

/**
 * Splits a positive, non-integral double into shortest round-tripping digits and a decimal exponent.
 *
 * ECMAScript requires the same shortest round-tripping digits as CPython's `repr`, so reading them
 * out of `String(value)` and re-laying them out with Python's thresholds is enough.
 */
function shortestDigitsOf(value: number): ShortestDigits {
  const text = String(value);
  const exponentAt = text.indexOf("e");
  const mantissa = exponentAt < 0 ? text : text.slice(0, exponentAt);
  const exponent = exponentAt < 0 ? 0 : Number(text.slice(exponentAt + 1));
  const dotAt = mantissa.indexOf(".");
  const integerPart = dotAt < 0 ? mantissa : mantissa.slice(0, dotAt);
  const fractionPart = dotAt < 0 ? "" : mantissa.slice(dotAt + 1);
  let digits = `${integerPart}${fractionPart}`;
  let decpt = integerPart.length + exponent;
  while (digits.startsWith("0")) {
    digits = digits.slice(1);
    decpt -= 1;
  }
  return { digits, decpt };
}

/** Writes a non-integral double the way `repr()` writes it, including the trailing `.0` rule. */
function formatPythonFloatRepr(value: number): string {
  const negative = value < 0;
  const { digits, decpt } = shortestDigitsOf(negative ? -value : value);
  const body = pythonFloatBody(digits, decpt);
  return negative ? `-${body}` : body;
}

/**
 * Lays shortest digits out in Python's fixed or exponent form for the given decimal exponent.
 *
 * {@link canonicalJson} reaches this only for non-integral values, and a double with a fractional
 * part is below 2^53, so `decpt` can never exceed 16 and the digits always span the decimal point.
 * The upper exponent condition and the `.0` padding branch mirror Python's `repr` for completeness and
 * are not paths this port can take.
 */
function pythonFloatBody(digits: string, decpt: number): string {
  if (decpt <= -4 || decpt > 16) {
    const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    const exponent = decpt - 1;
    const sign = exponent < 0 ? "-" : "+";
    const magnitude = Math.abs(exponent).toString().padStart(2, "0");
    return `${mantissa}e${sign}${magnitude}`;
  }
  if (decpt <= 0) {
    return `0.${"0".repeat(-decpt)}${digits}`;
  }
  if (digits.length <= decpt) {
    return `${digits.padEnd(decpt, "0")}.0`;
  }
  return `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** Compares two strings by Unicode code point, the order Python's `sorted` gives JSON keys. */
/** The Unicode code points of `text`, so a comparison cannot fall back to UTF-16 code-unit order. */
function codePointsOf(text: string): number[] {
  const points: number[] = [];
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point !== undefined) {
      points.push(point);
    }
  }
  return points;
}

/**
 * Orders text the way Python compares `str`: by Unicode code point, and shorter first when one text
 * is a prefix of the other.
 *
 * JavaScript's `<` compares UTF-16 code units, which sorts an astral character such as U+1F600 below
 * the BMP character U+FFEE because its leading surrogate is 0xD83D. Python sorts those the other way
 * round, and `canonical_json` sorts object keys with Python's ordering.
 */
function compareCodePointOrder(left: string, right: string): number {
  const leftPoints = codePointsOf(left);
  const rightPoints = codePointsOf(right);
  let index = 0;
  for (const leftPoint of leftPoints) {
    // A code point this text has run out of is below every real one, which is what makes a prefix of
    // the other text sort first.
    const rightPoint = rightPoints[index] ?? -1;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
    index += 1;
  }
  return leftPoints.length < rightPoints.length ? -1 : 0;
}

/** Quotes a string with Python's escape set: `"`, `\`, the five named controls, and `\uXXXX`. */
function encodeCanonicalJsonString(value: string): string {
  // oxlint-disable-next-line no-control-regex -- the U+0000-U+001F range is exactly what CPython escapes.
  return `"${value.replace(/["\\\u0000-\u001f]/g, escapeJsonCharacter)}"`;
}

/** Escapes one matched character, lowercase hex like CPython's `\\u%04x`. */
function escapeJsonCharacter(character: string): string {
  switch (character) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case "\b":
      return "\\b";
    case "\t":
      return "\\t";
    case "\n":
      return "\\n";
    case "\f":
      return "\\f";
    case "\r":
      return "\\r";
    default:
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

/** Joins the blocks that hold text with newlines and strips the result, as upstream folds them. */
function foldBlocks(blocks: readonly string[]): string {
  return stripPythonWhitespace(
    blocks.filter((block) => stripPythonWhitespace(block) !== "").join("\n"),
  );
}

function renderAssistantUnit(unit: AssistantUnit, policy: SummaryPolicy): RenderOutcome {
  const lines: string[] = [];
  if (policy.keepThinking) {
    const thinking = truncateToCodePoints(foldBlocks(unit.thinking), policy.thinkingMaxChars);
    if (thinking !== "") {
      lines.push(`${THINKING_PART_PREFIX}${thinking}`);
    }
  }
  const thought = truncateToCodePoints(foldBlocks(unit.thoughts), policy.thoughtMaxChars);
  if (thought !== "") {
    lines.push(`${ASSISTANT_PART_PREFIX}${thought}`);
  }
  const signatures = unit.calls.map(
    (call) =>
      `[${call.name}] ${truncateToCodePoints(canonicalJson(call.args), policy.cmdMaxChars)}`,
  );
  if (signatures.length > 0) {
    lines.push(signatures.join("\n"));
  }
  return { parts: lines.length === 0 ? [] : [lines.join("\n")], omissions: [] };
}

function renderHumanUnit(unit: HumanUnit, policy: SummaryPolicy): RenderOutcome {
  const text = stripPythonWhitespace(stripTaskNotifications(unit.text));
  if (text === "") {
    // Notification-only and blank human messages fold to nothing, upstream _summarize_user.
    return { parts: [], omissions: [] };
  }
  return {
    parts: [`${HUMAN_PART_PREFIX}${truncateToCodePoints(text, policy.humanMaxChars)}`],
    omissions: [],
  };
}

function renderSystemUnit(unit: SystemUnit, policy: SummaryPolicy): RenderOutcome {
  // Upstream strips no notifications here: an injected directive is an instruction, not an
  // observation, and it is the one text class whose exact wording the model must keep.
  const text = stripPythonWhitespace(unit.text);
  if (text === "") {
    return { parts: [], omissions: [] };
  }
  return {
    parts: [`${SYSTEM_PART_PREFIX}${truncateToCodePoints(text, policy.humanMaxChars)}`],
    omissions: [],
  };
}

function renderResultUnit(unit: ResultUnit, policy: SummaryPolicy): RenderOutcome {
  const text = stripPythonWhitespace(unit.text);
  if (text === "") {
    return { parts: [], omissions: ["emptyToolResult"] };
  }
  if (countCodePoints(text) > policy.resultMaxChars) {
    // Dropped whole. Truncating an observation would leave a prefix that reads like the result.
    return { parts: [], omissions: ["longToolResult"] };
  }
  return { parts: [`${RESULT_PART_PREFIX}${text}`], omissions: [] };
}

function renderOmittedUnit(unit: OmittedUnit): RenderOutcome {
  return { parts: [], omissions: [unit.reason] };
}

/**
 * The render rule for one member of the union, taking only that member.
 *
 * A rule returns the parts upstream's `summarize_message` would return for it, so the table can be
 * read next to upstream's `_summarize_assistant` and `_summarize_user` and checked line by line.
 */
type RenderRule<TUnit extends SummaryUnit> = (unit: TUnit, policy: SummaryPolicy) => RenderOutcome;

/**
 * The closed render table: one rule per content class, keyed by `kind`.
 *
 * This is a review surface, not a registry. Adding a member to {@link SummaryUnit} makes this
 * object, {@link renderSummaryUnit}, and {@link headRegionEnd} fail to compile until the new class
 * has a rule and a place in the head rule.
 */
const RENDER_RULES: {
  [kind in SummaryUnit["kind"]]: RenderRule<Extract<SummaryUnit, { kind: kind }>>;
} = {
  assistant: renderAssistantUnit,
  human: renderHumanUnit,
  system: renderSystemUnit,
  result: renderResultUnit,
  omitted: renderOmittedUnit,
};

/**
 * One dispatch, one table lookup. The generic `kind` parameter is what lets TypeScript pair the rule
 * with its unit without an assertion; the union-typed call `RENDER_RULES[unit.kind](unit, ...)` does
 * not typecheck because the parameter collapses to an intersection.
 */
function renderSummaryUnit<kind extends SummaryUnit["kind"]>(
  kind: kind,
  unit: Extract<SummaryUnit, { kind: kind }>,
  policy: SummaryPolicy,
): RenderOutcome {
  return RENDER_RULES[kind](unit, policy);
}

/**
 * Index just past the head region: the opening instructions upstream keeps outside the compacted run.
 *
 * Upstream takes everything before the first assistant message (`cliff.compact`) and then trims a
 * trailing previous summary off it. Here the summary arrives as its own unit, so a
 * `previousSummary` omission ends the region: what came before it is the carried head, and what
 * comes after is this cycle's action text, which eviction may drop. Other omissions are transparent,
 * because an image or a `!!` command does not end the opening turn.
 */
function headRegionEnd(units: readonly SummaryUnit[]): number {
  for (const [index, unit] of units.entries()) {
    if (unit.kind === "human" || unit.kind === "system") {
      continue;
    }
    if (unit.kind === "omitted" && unit.reason !== "previousSummary") {
      continue;
    }
    return index;
  }
  return units.length;
}

/**
 * Renders one opening message as tagged, capped text.
 *
 * The head is text pi showed the model, not a summarised part: it is not trimmed, not stripped of
 * `<task-notification>` blocks, and never evicted. The speaker tag and the `humanMaxChars` bound are
 * shared with the action rules so that every text block in a summary reads the same way, and so that
 * one giant opening paste cannot become permanent, uncompactable context.
 */
function renderHeadUnit(unit: HumanUnit | SystemUnit, policy: SummaryPolicy): string | null {
  const prefix = unit.kind === "system" ? SYSTEM_PART_PREFIX : HUMAN_PART_PREFIX;
  if (stripPythonWhitespace(unit.text) === "") {
    return null;
  }
  return `${prefix}${truncateToCodePoints(unit.text, policy.humanMaxChars)}`;
}

/**
 * Applies the escalation profile to the configured rules.
 *
 * Upstream rung 2 (`spec-proxy.md` §2): drop thinking and cap assistant text at 300 characters,
 * keeping a configured cap when it is already tighter. `manual` and `threshold` use the config
 * unchanged. No other knob changes, and no profile changes what pi keeps.
 */
function resolveSummaryPolicy(policy: SummaryPolicy, profile: SummaryProfile): SummaryPolicy {
  if (profile !== "overflow") {
    return policy;
  }
  return {
    ...policy,
    keepThinking: false,
    thoughtMaxChars:
      policy.thoughtMaxChars === 0
        ? OVERFLOW_THOUGHT_MAX_CHARS
        : Math.min(policy.thoughtMaxChars, OVERFLOW_THOUGHT_MAX_CHARS),
  };
}

/**
 * Renders units into a head section and action parts, with drop tallies.
 *
 * Nothing here chooses a cut or a budget: pi owns when compaction happens and which messages reach
 * this call. Pass the head text recorded in an earlier cycle's details as the leading units, so the
 * opening task survives as many compactions as it takes.
 */
export function renderSummary(
  units: readonly SummaryUnit[],
  policy: SummaryPolicy,
  profile: SummaryProfile,
): SummaryRender {
  const effectivePolicy = resolveSummaryPolicy(policy, profile);
  const headEnd = headRegionEnd(units);
  const headParagraphs: string[] = [];
  const actionParts: string[] = [];
  const omissions = emptyOmissionCounts();

  for (const [index, unit] of units.entries()) {
    const outcome = renderSummaryUnit(unit.kind, unit, effectivePolicy);
    for (const reason of outcome.omissions) {
      omissions[reason] += 1;
    }
    if (index < headEnd) {
      if (unit.kind === "human" || unit.kind === "system") {
        const rendered = renderHeadUnit(unit, effectivePolicy);
        if (rendered !== null) {
          headParagraphs.push(rendered);
        }
      }
      continue;
    }
    actionParts.push(...outcome.parts);
  }

  return {
    headSection: headParagraphs.length === 0 ? null : headParagraphs.join("\n\n"),
    actionParts,
    stats: { units: units.length, actionParts: actionParts.length, omissions },
  };
}

/**
 * Builds the summary text: the byte-exact header, then the head section, then the action parts.
 *
 * Upstream `cliff.compact` writes `SUMMARY_HEADER + "\n\n" + "\n\n---\n\n".join(parts)` and writes
 * the header alone when no part survived. The head section joins ahead of the action parts as the
 * first part, so pi's single summary slot carries both, and pi wraps the result in its own
 * `<summary>` framing.
 */
export function assembleSummary(
  headSection: string | null,
  actionParts: readonly string[],
): string {
  const parts =
    headSection === null || headSection === "" ? [...actionParts] : [headSection, ...actionParts];
  if (parts.length === 0) {
    return SUMMARY_HEADER;
  }
  return `${SUMMARY_HEADER}${SUMMARY_HEADER_SEPARATOR}${parts.join(SUMMARY_PART_SEPARATOR)}`;
}

/**
 * Keeps the newest action parts that fit `budgetChars`, dropping from the oldest end.
 *
 * Upstream rung 3 (`spec-proxy.md` §2): walk from the newest part, keep whole parts, and stop at the
 * first part that does not fit instead of skipping it to reach an older short one, so the retained
 * text is always a contiguous recent run. Accounting is `used += part + 9`. If nothing fits the
 * result is the empty list, which {@link assembleSummary} renders as the header alone. The input is
 * returned unchanged when nothing would be dropped, matching upstream's rejection of a truncation
 * that is not shorter than the text it replaces. The head section is not a part and is never evicted.
 */
export function truncateActionParts(actionParts: readonly string[], budgetChars: number): string[] {
  const budget = Math.max(budgetChars, 0);
  const kept: string[] = [];
  let used = 0;
  for (const part of actionParts.slice().reverse()) {
    const length = countCodePoints(part);
    if (used + length > budget) {
      break;
    }
    kept.unshift(part);
    used += length + TRUNCATION_PART_OVERHEAD_CHARS;
  }
  if (kept.length === actionParts.length) {
    return [...actionParts];
  }
  return kept;
}

/**
 * Converts a token budget into the character budget {@link truncateActionParts} needs.
 *
 * Upstream computed `threshold_tokens * 4 - fixed - len(SUMMARY_HEADER) - 64`, where `fixed` was the
 * serialised cost of the rest of the request and the 64 was an unexplained reserve. Neither is
 * visible from inside pi, so both are replaced by what is measurable here: pi's own framing of the
 * summary, {@link PI_SUMMARY_WRAPPER_CHARS}. Everything else in the request, including the cost of
 * the head section and the kept tail, is the caller's to subtract from `budgetTokens`.
 *
 * May return a negative number; the budget is floored at zero where it is used, as upstream floors
 * it there.
 */
export function actionPartBudgetChars(budgetTokens: number): number {
  return budgetTokens * 4 - SUMMARY_HEADER.length - PI_SUMMARY_WRAPPER_CHARS;
}
