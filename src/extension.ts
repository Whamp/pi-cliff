/**
 * Pi's native compaction hook, durable opening head, and `/cliff` status command.
 *
 * Pi supplies the compaction cut and token count. Cliff renders only the messages Pi selected and
 * stores only its carried opening head in the compaction details; reports and receipts are optional.
 */

import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getLatestCompactionEntry,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  assembleSummary,
  headRegionEnd,
  renderSummary,
  type SummaryPolicy,
  type SummaryUnit,
} from "./cliff.js";
import {
  CLIFF_CONFIG_FILE_NAME,
  CLIFF_CONFIG_OPTIONS,
  DEFAULT_CLIFF_CONFIG,
  describeCliffConfigValue,
  formatCliffConfigHelp,
  loadCliffConfig,
  type CliffConfig,
  type CliffConfigLoad,
  type CliffConfigPaths,
  type CliffMode,
} from "./config.js";
import { toSummaryUnits, type PiAgentMessage } from "./pi-units.js";

/** Namespace inside a compaction entry's `details` where Cliff stores its carried opening head. */
export const CLIFF_DETAILS_KEY = "cliff";

/** Version of the minimal persisted Cliff head record. */
export const CLIFF_DETAILS_VERSION = 1;

/** Session-entry type for optional shadow and cancellation receipts. */
const CLIFF_OUTCOME_ENTRY_TYPE = "cliff.outcome";

/** Slash command for showing the resolved configuration and current branch status. */
export const CLIFF_COMMAND_NAME = "cliff";

type CliffHeadUnit = Extract<SummaryUnit, { kind: "human" | "system" }>;
type CliffOutcomeStage = "config" | "aborted" | "projection" | "render";
type CliffDiagnosticKind = "info" | "warning" | "error";

interface CliffHeadRecord {
  version: number;
  head: readonly CliffHeadUnit[];
}

interface CliffOutcomeReceipt {
  version: number;
  outcome: "shadow" | "cancelled";
  stage: CliffOutcomeStage;
  mode: CliffMode;
  reason: "manual" | "threshold" | "overflow";
  message: string;
}

interface CliffReportTarget {
  hasUI: boolean;
  ui: { notify?: (message: string, kind?: CliffDiagnosticKind) => void };
}

interface CliffBranchSource {
  getBranch(): SessionEntry[];
}

interface CliffHostContext extends CliffReportTarget {
  cwd: string;
  sessionManager: CliffBranchSource;
}

interface CliffOutcomeRecorder {
  appendEntry(customType: string, data?: CliffOutcomeReceipt): void;
}

/** Host adapters for locating and reading Cliff config; no estimator or token budget is accepted. */
export interface CliffExtensionDependencies {
  resolveConfigPaths: (cwd: string) => CliffConfigPaths;
  loadConfig: (paths: CliffConfigPaths) => CliffConfigLoad;
}

/** Pi methods this extension uses to register hooks, commands, and optional outcome receipts. */
export type CliffExtensionAPI = Pick<ExtensionAPI, "on" | "registerCommand" | "appendEntry">;

/** Registers Cliff's compaction hook, post-compaction notice, and `/cliff` status command. */
export function createCliffExtension(
  pi: CliffExtensionAPI,
  dependencies: CliffExtensionDependencies,
): void {
  pi.on("session_before_compact", (event, ctx) => runCompactionHook(event, ctx, dependencies, pi));
  pi.on("session_compact", (event, ctx) => {
    reportCommittedCompaction(event, ctx);
  });
  pi.registerCommand(CLIFF_COMMAND_NAME, {
    description: "Show Cliff's resolved config and the current branch's compaction head",
    handler: async (args, ctx) => {
      reportCliffCommand(ctx, dependencies, args);
    },
  });
}

/** Config paths and file reading used by the installed Pi extension. */
export const DEFAULT_CLIFF_EXTENSION_DEPENDENCIES: CliffExtensionDependencies = {
  resolveConfigPaths: (cwd) => ({
    globalPath: join(getAgentDir(), CLIFF_CONFIG_FILE_NAME),
    projectPath: join(cwd, CONFIG_DIR_NAME, CLIFF_CONFIG_FILE_NAME),
  }),
  loadConfig: loadCliffConfig,
};

/** Pi's extension loader calls this default export to register Cliff. */
export default function cliffExtension(pi: ExtensionAPI): void {
  createCliffExtension(pi, DEFAULT_CLIFF_EXTENSION_DEPENDENCIES);
}

type CliffAttempt =
  | { ok: true; summary: string; head: readonly CliffHeadUnit[] }
  | { ok: false; stage: CliffOutcomeStage; message: string };

type CliffHeadSource = "first-cycle" | "restored" | "foreign-compaction";

type CliffConfigRead =
  | { ok: true; mode: CliffMode; loaded: CliffConfigLoad }
  | { ok: false; message: string };

type CliffHeadRead =
  | { state: "ready"; source: CliffHeadSource; units: readonly CliffHeadUnit[] }
  | { state: "invalid" };

type CliffRecordRead =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "record"; record: CliffHeadRecord };

/** Contains the entire hook boundary so unexpected reporting failures cannot invoke Pi's model path. */
function runCompactionHook(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  dependencies: CliffExtensionDependencies,
  recorder: CliffOutcomeRecorder,
): SessionBeforeCompactResult | undefined {
  let mode = DEFAULT_CLIFF_CONFIG.mode;
  try {
    const host: CliffHostContext = ctx;
    const read = readCliffConfig(host, dependencies);
    if (!read.ok) {
      return reportFailure(host, recorder, "config", read.message, mode, event.reason);
    }
    mode = read.mode;
    if (mode === "off") {
      return undefined;
    }
    if (read.loaded.errors.length > 0) {
      return reportFailure(
        host,
        recorder,
        "config",
        read.loaded.errors.join(" "),
        mode,
        event.reason,
      );
    }

    if (event.customInstructions !== undefined && event.customInstructions.trim() !== "") {
      reportCliffDiagnostic(
        host,
        "Cliff ignored the /compact instructions: a mechanical summary cannot follow them. The compaction went ahead with the normal rules.",
        "warning",
      );
    }
    const attempt = attemptCliffSummary(event, read.loaded.config);
    if (!attempt.ok) {
      return reportFailure(host, recorder, attempt.stage, attempt.message, mode, event.reason);
    }
    if (mode === "shadow") {
      recordOutcome(recorder, {
        version: CLIFF_DETAILS_VERSION,
        outcome: "shadow",
        stage: "render",
        mode,
        reason: event.reason,
        message: "Cliff rendered a comparison summary; Pi owns this compaction",
      });
      reportCliffDiagnostic(
        host,
        "Cliff rendered a comparison summary; Pi will compact normally.",
        "info",
      );
      return undefined;
    }

    return {
      compaction: {
        summary: attempt.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          [CLIFF_DETAILS_KEY]: {
            version: CLIFF_DETAILS_VERSION,
            head: attempt.head,
          } satisfies CliffHeadRecord,
        },
      },
    };
  } catch (error) {
    const message = `unexpected hook failure: ${describeError(error)}`;
    reportCliffDiagnostic(ctx, message, mode === "active" ? "error" : "warning");
    return mode === "active" ? { cancel: true } : undefined;
  }
}

/** Reads and resolves config without changing the active-mode safety default on failure. */
function readCliffConfig(
  host: CliffHostContext,
  dependencies: CliffExtensionDependencies,
): CliffConfigRead {
  try {
    const loaded = dependencies.loadConfig(dependencies.resolveConfigPaths(host.cwd));
    return { ok: true, mode: loaded.config.mode, loaded };
  } catch (error) {
    return { ok: false, message: `config could not be read: ${describeError(error)}` };
  }
}

/** Renders exactly Pi's selected range, carrying Cliff's opening head without a budget estimate. */
function attemptCliffSummary(event: SessionBeforeCompactEvent, config: CliffConfig): CliffAttempt {
  if (event.signal.aborted) {
    return { ok: false, stage: "aborted", message: "the compaction abort signal was raised" };
  }

  const summarized: readonly PiAgentMessage[] = [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ];
  let units: SummaryUnit[];
  try {
    units = toSummaryUnits(summarized);
  } catch (error) {
    return { ok: false, stage: "projection", message: describeError(error) };
  }

  const carried = readCarriedHead(event.branchEntries);
  if (carried.state === "invalid") {
    return {
      ok: false,
      stage: "projection",
      message: "the latest Cliff compaction has an invalid opening head; refusing to replace it",
    };
  }
  const head = carried.source === "restored" ? carried.units : leadingHeadUnits(units);
  const renderUnits: readonly SummaryUnit[] =
    carried.source === "restored" ? [...head, HEAD_REGION_BOUNDARY, ...units] : units;

  let rendered;
  try {
    rendered = renderSummary(renderUnits, toSummaryPolicy(config), event.reason);
  } catch (error) {
    return { ok: false, stage: "render", message: describeError(error) };
  }

  return {
    ok: true,
    summary: assembleSummary(rendered.headSection, rendered.actionParts),
    head,
  };
}

/** Converts public estimated-token limits to renderer code-point caps at the sole unit boundary. */
function toSummaryPolicy(config: CliffConfig): SummaryPolicy {
  return {
    includeReasoning: config.includeReasoning,
    assistantTextMaxChars:
      config.assistantTextMaxTokens === "unlimited"
        ? "unlimited"
        : config.assistantTextMaxTokens * 4,
    reasoningTextMaxChars:
      config.reasoningTextMaxTokens === "unlimited"
        ? "unlimited"
        : config.reasoningTextMaxTokens * 4,
    toolCallMaxChars:
      config.toolCallMaxTokens === "unlimited" ? "unlimited" : config.toolCallMaxTokens * 4,
    toolResultMaxChars:
      config.toolResultMaxTokens === "unlimited" ? "unlimited" : config.toolResultMaxTokens * 4,
    userTextMaxChars:
      config.userTextMaxTokens === "unlimited" ? "unlimited" : config.userTextMaxTokens * 4,
  };
}

/** Separates a restored opening head from this cycle's messages without changing their order. */
const HEAD_REGION_BOUNDARY: SummaryUnit = { kind: "omitted", reason: "previousSummary" };

/** Extracts only human and system units that Pi placed in the opening head region. */
function leadingHeadUnits(units: readonly SummaryUnit[]): CliffHeadUnit[] {
  const head: CliffHeadUnit[] = [];
  for (const unit of units.slice(0, headRegionEnd(units))) {
    if (unit.kind === "human" || unit.kind === "system") {
      head.push(unit);
    }
  }
  return head;
}

/** Reads the newest compaction's Cliff head; foreign summaries are never treated as recovered heads. */
function readCarriedHead(branchEntries: SessionEntry[]): CliffHeadRead {
  const latest = getLatestCompactionEntry(branchEntries);
  if (latest === null) {
    return { state: "ready", source: "first-cycle", units: [] };
  }
  const read = readCliffHeadRecord(latest.details);
  if (read.state === "invalid") {
    return { state: "invalid" };
  }
  if (read.state === "absent") {
    return { state: "ready", source: "foreign-compaction", units: [] };
  }
  return { state: "ready", source: "restored", units: read.record.head };
}

/** Decodes the minimal `details.cliff` head record independently of optional reporting fields. */
function readCliffHeadRecord(details: unknown): CliffRecordRead {
  const container = asRecord(details);
  if (container === undefined || !Object.hasOwn(container, CLIFF_DETAILS_KEY)) {
    return { state: "absent" };
  }
  const record = asRecord(container[CLIFF_DETAILS_KEY]);
  if (
    record === undefined ||
    !Object.hasOwn(record, "version") ||
    !Object.hasOwn(record, "head") ||
    record["version"] !== CLIFF_DETAILS_VERSION
  ) {
    return { state: "invalid" };
  }
  const head = readHeadUnits(record["head"]);
  return head === undefined
    ? { state: "invalid" }
    : { state: "record", record: { version: CLIFF_DETAILS_VERSION, head } };
}

/** Parses human and system head units while preserving an explicitly empty head. */
function readHeadUnits(value: unknown): CliffHeadUnit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const head: CliffHeadUnit[] = [];
  for (const entry of value) {
    const unit = asRecord(entry);
    if (unit === undefined || !Object.hasOwn(unit, "kind") || !Object.hasOwn(unit, "text")) {
      return undefined;
    }
    const kind = unit["kind"];
    const text = unit["text"];
    if ((kind !== "human" && kind !== "system") || typeof text !== "string") {
      return undefined;
    }
    head.push(kind === "human" ? { kind: "human", text } : { kind: "system", text });
  }
  return head;
}

/** Writes a compact outcome receipt as best-effort reporting that cannot gate compaction. */
function recordOutcome(recorder: CliffOutcomeRecorder, receipt: CliffOutcomeReceipt): void {
  try {
    recorder.appendEntry(CLIFF_OUTCOME_ENTRY_TYPE, receipt);
  } catch {
    // Receipts are optional; the compaction outcome never depends on writing one.
  }
}

/** Records and reports a failed attempt, cancelling only when Cliff owns the summary. */
function reportFailure(
  host: CliffHostContext,
  recorder: CliffOutcomeRecorder,
  stage: CliffOutcomeStage,
  message: string,
  mode: CliffMode,
  reason: SessionBeforeCompactEvent["reason"],
): SessionBeforeCompactResult | undefined {
  recordOutcome(recorder, {
    version: CLIFF_DETAILS_VERSION,
    outcome: mode === "active" ? "cancelled" : "shadow",
    stage,
    mode,
    reason,
    message,
  });
  reportCliffDiagnostic(
    host,
    mode === "active"
      ? `Cliff cancelled this compaction (${stage} stage): ${message}. Set mode "off" to use Pi's summariser.`
      : `Cliff could not render a comparison summary (${stage} stage): ${message}`,
    mode === "active" ? "error" : "warning",
  );
  return mode === "active" ? { cancel: true } : undefined;
}

/** Reports only a compaction Pi actually committed and whose Cliff head is readable. */
function reportCommittedCompaction(event: SessionCompactEvent, ctx: ExtensionContext): void {
  if (!event.fromExtension) {
    return;
  }
  const read = readCliffHeadRecord(event.compactionEntry.details);
  if (read.state !== "record") {
    return;
  }
  reportCliffDiagnostic(
    ctx,
    `Cliff: mechanical ${event.reason} compaction committed · ${String(read.record.head.length)} carried head units`,
    "info",
  );
}

/** Writes the `/cliff` command report through UI when available, or stderr without stdout pollution. */
function reportCliffCommand(
  ctx: ExtensionCommandContext,
  dependencies: CliffExtensionDependencies,
  args: string,
): void {
  const commandArgs = args.trim();
  if (commandArgs === "help") {
    reportCliffDiagnostic(ctx, formatCliffConfigHelp(), "info");
    return;
  }
  if (commandArgs !== "") {
    reportCliffDiagnostic(ctx, "Usage: /cliff [help]", "warning");
    return;
  }
  try {
    reportCliffDiagnostic(ctx, buildCliffReport(ctx, dependencies), "info");
  } catch (error) {
    reportCliffDiagnostic(
      ctx,
      `Cliff status report failed: ${describeError(error)}\nUse /cliff help for settings and a JSON example.`,
      "error",
    );
  }
}

/** Builds a minimal config and head-status report for the active branch. */
function buildCliffReport(
  host: CliffHostContext,
  dependencies: CliffExtensionDependencies,
): string {
  let loaded: CliffConfigLoad;
  try {
    loaded = dependencies.loadConfig(dependencies.resolveConfigPaths(host.cwd));
  } catch (error) {
    return `Cliff config could not be read: ${describeError(error)}\nUse /cliff help for settings and a JSON example.`;
  }

  const originByKey = new Map(loaded.origins.map(({ key, path }) => [key, path]));
  const lines = ["Cliff configuration:"];
  for (const { key } of CLIFF_CONFIG_OPTIONS) {
    const value = describeCliffConfigValue(loaded.config, key);
    const origin = originByKey.get(key) ?? "built-in default";
    lines.push(`  ${key} = ${value} (origin: ${origin})`);
  }
  for (const file of loaded.files) {
    lines.push(`  file ${file.path}: ${file.state}`);
  }
  for (const error of loaded.errors) {
    lines.push(`  error: ${error}`);
  }
  const branch = host.sessionManager.getBranch();
  lines.push(describeBranchHead(branch));
  lines.push(describeLastReceipt(branch));
  lines.push("Use /cliff help for settings and a JSON example.");
  return lines.join("\n");
}

/** Describes whether the latest branch compaction has a valid carried Cliff head. */
function describeBranchHead(branch: SessionEntry[]): string {
  const latest = getLatestCompactionEntry(branch);
  if (latest === null) {
    return "Last compaction on this branch: none yet";
  }
  const read = readCliffHeadRecord(latest.details);
  if (read.state === "absent") {
    return "Last compaction on this branch: foreign summary; no Cliff head recovery is claimed";
  }
  if (read.state === "invalid") {
    return "Last compaction on this branch: Cliff head is malformed; active compaction will cancel safely";
  }
  return `Last compaction on this branch: Cliff head restored · ${String(read.record.head.length)} units`;
}

/** Finds the latest optional shadow or cancellation receipt on the current branch. */
function describeLastReceipt(branch: SessionEntry[]): string {
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "custom" || entry.customType !== CLIFF_OUTCOME_ENTRY_TYPE) {
      continue;
    }
    const receipt = readOutcomeReceipt(entry.data);
    return receipt === undefined
      ? "Last Cliff receipt: one this build cannot read"
      : `Last Cliff receipt: ${receipt.outcome} at ${receipt.stage} (${receipt.mode}, ${receipt.reason}) · ${receipt.message}`;
  }
  return "Last Cliff receipt: none on this branch";
}

/** Parses optional outcome data without using it to recover the durable head. */
function readOutcomeReceipt(data: unknown): CliffOutcomeReceipt | undefined {
  const record = asRecord(data);
  if (
    record === undefined ||
    !["version", "outcome", "stage", "mode", "reason", "message"].every((key) =>
      Object.hasOwn(record, key),
    ) ||
    record["version"] !== CLIFF_DETAILS_VERSION
  ) {
    return undefined;
  }
  const outcome = record["outcome"];
  const stage = record["stage"];
  const mode = record["mode"];
  const reason = record["reason"];
  const message = record["message"];
  if (
    (outcome !== "shadow" && outcome !== "cancelled") ||
    !isOutcomeStage(stage) ||
    !isCliffMode(mode) ||
    !isSummaryProfile(reason) ||
    typeof message !== "string"
  ) {
    return undefined;
  }
  return { version: CLIFF_DETAILS_VERSION, outcome, stage, mode, reason, message };
}

/** Delivers diagnostics only to a UI Pi says is available; headless output always uses stderr. */
function reportCliffDiagnostic(
  target: CliffReportTarget,
  message: string,
  kind: CliffDiagnosticKind,
): void {
  try {
    if (target.hasUI && target.ui.notify !== undefined) {
      target.ui.notify(message, kind);
      return;
    }
  } catch {
    // A broken notification channel cannot turn active mode into Pi's model fallback.
  }
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // A diagnostic sink is optional, including when stderr itself is unavailable.
  }
}

/** Narrows JSON objects without copying special keys such as `__proto__` into a new object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSummaryProfile(value: unknown): value is "manual" | "threshold" | "overflow" {
  return value === "manual" || value === "threshold" || value === "overflow";
}

function isOutcomeStage(value: unknown): value is CliffOutcomeStage {
  return value === "config" || value === "aborted" || value === "projection" || value === "render";
}

function isCliffMode(value: unknown): value is CliffMode {
  return value === "active" || value === "shadow" || value === "off";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
