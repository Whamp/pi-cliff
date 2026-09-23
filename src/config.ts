/**
 * Cliff's configuration: the two `cliff.json` files, what they may say, and how they combine.
 *
 * Files rather than pi settings keys, because pi's settings schema is not ours to extend and
 * `ExtensionContext` exposes no settings accessor. Precedence is the built-in defaults, then the
 * global file in pi's agent directory, then the project file, so one project can tighten one cap
 * without resetting the others and without touching anyone else's session.
 *
 * Nothing here derives a path. `parseCliffConfig` reads no files, and `loadCliffConfig` reads only the
 * two paths it is handed, so a test can point Cliff at a temp directory and the host's real `~/.pi`
 * and working directory stay untouched.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_SUMMARY_POLICY, type SummaryPolicy } from "./cliff.js";

/**
 * Who owns the compaction summary.
 *
 * `active` writes Cliff's summary and skips pi's model call. `shadow` computes and reports what Cliff
 * would have written, then leaves the compaction to pi, which is what makes the two comparable on the
 * same trigger and the same cut. `off` hands ownership back to pi and produces no Cliff output at all.
 */
export type CliffMode = "active" | "shadow" | "off";

/**
 * Everything `cliff.json` configures: the mode switch plus the render policy knobs.
 *
 * The policy half is {@link SummaryPolicy} unchanged, so the resolved config is exactly what
 * `renderSummary` takes and there is no second copy of the caps to keep in step.
 */
export interface CliffConfig extends SummaryPolicy {
  /** See {@link CliffMode}. */
  mode: CliffMode;
}

/** Upstream's defaults plus `active`, which is what a session with no `cliff.json` anywhere gets. */
export const DEFAULT_CLIFF_CONFIG: CliffConfig = { mode: "active", ...DEFAULT_SUMMARY_POLICY };

/** File name Cliff looks for in both directories; deriving the directories is the host glue's job. */
export const CLIFF_CONFIG_FILE_NAME = "cliff.json";

/**
 * What one `cliff.json` states explicitly.
 *
 * A key that is absent here is inherited from the layer below, so the patch rather than the resolved
 * config is what carries a file's provenance for `/cliff`.
 */
export interface CliffConfigSettings {
  mode?: CliffMode;
  keepThinking?: boolean;
  thoughtMaxChars?: number;
  thinkingMaxChars?: number;
  cmdMaxChars?: number;
  resultMaxChars?: number;
  humanMaxChars?: number;
}

/** A document that parsed cleanly, carrying only the keys the file actually named. */
export interface CliffConfigParseOk {
  ok: true;
  settings: CliffConfigSettings;
}

/** A document Cliff refuses, with every problem found in one pass so one report lists them all. */
export interface CliffConfigParseErrors {
  ok: false;
  errors: string[];
}

/** Outcome of {@link parseCliffConfig}. */
export type CliffConfigParse = CliffConfigParseOk | CliffConfigParseErrors;

/** The two files Cliff reads. Deriving them is the caller's job, so this module can stay pure. */
export interface CliffConfigPaths {
  globalPath: string;
  projectPath: string;
}

/** One resolved value that came from a file rather than from the defaults, for `/cliff` to name. */
export interface CliffConfigOrigin {
  key: string;
  path: string;
}

/** What reading the config files produced. Errors never suppress the config; the caller decides. */
export interface CliffConfigLoad {
  config: CliffConfig;
  origins: CliffConfigOrigin[];
  errors: string[];
}

/**
 * Every key a `cliff.json` may name, and therefore the whole grammar of the file.
 *
 * An unknown key is an error, so this list is what rejects a misspelling instead of ignoring it.
 * {@link readCliffConfigSetting} switches over exactly these names, which is what ties the list to the
 * readers: a name added here without a reader stops compiling.
 */
const CLIFF_CONFIG_KEYS = [
  "mode",
  "keepThinking",
  "thoughtMaxChars",
  "thinkingMaxChars",
  "cmdMaxChars",
  "resultMaxChars",
  "humanMaxChars",
] as const;

/** The mode values, in the order the error message lists them. */
const CLIFF_MODE_VALUES = ["active", "shadow", "off"] as const satisfies readonly CliffMode[];

/**
 * Validates a parsed `cliff.json` document and returns only the keys the file named.
 *
 * The parameter is `unknown` because this is the decode boundary for a JSON file; everything
 * downstream works on {@link CliffConfigSettings}. Every problem is collected rather than thrown, so
 * one report names each mistake in the file instead of only the first.
 *
 * `0` is a valid value for every cap, and each cap means something different by it: for the text caps
 * it is unlimited, and for `resultMaxChars` it drops every non-empty tool result. That is upstream's
 * meaning, not a typo, so a `0` is never reported as an error.
 */
export function parseCliffConfig(document: unknown): CliffConfigParse {
  return parseCliffConfigDocument(document, "");
}

/**
 * Resolves config layers in precedence order, earliest first.
 *
 * `mergeCliffConfig([globalSettings, projectSettings])` is the documented order of defaults, global
 * file, then project file. Layers apply key by key, so a project that names one cap inherits the rest
 * rather than resetting them to upstream's defaults.
 */
export function mergeCliffConfig(layers: readonly CliffConfigSettings[]): CliffConfig {
  const config: CliffConfig = { ...DEFAULT_CLIFF_CONFIG };
  for (const settings of layers) {
    if (settings.mode !== undefined) {
      config.mode = settings.mode;
    }
    if (settings.keepThinking !== undefined) {
      config.keepThinking = settings.keepThinking;
    }
    if (settings.thoughtMaxChars !== undefined) {
      config.thoughtMaxChars = settings.thoughtMaxChars;
    }
    if (settings.thinkingMaxChars !== undefined) {
      config.thinkingMaxChars = settings.thinkingMaxChars;
    }
    if (settings.cmdMaxChars !== undefined) {
      config.cmdMaxChars = settings.cmdMaxChars;
    }
    if (settings.resultMaxChars !== undefined) {
      config.resultMaxChars = settings.resultMaxChars;
    }
    if (settings.humanMaxChars !== undefined) {
      config.humanMaxChars = settings.humanMaxChars;
    }
  }
  return config;
}

/**
 * Reads the two config files from paths the caller owns and resolves them over the defaults.
 *
 * Absence is ordinary, because configuration is optional: a missing file is not an error. A file that
 * is present and wrong is an error, and the caller cancels compaction on it rather than falling back
 * to pi's model summariser. Both files are read even when the first is broken, so one report names
 * every mistake the user has to fix.
 */
export function loadCliffConfig(paths: CliffConfigPaths): CliffConfigLoad {
  const layers: CliffConfigSettings[] = [];
  const errors: string[] = [];
  const originByKey = new Map<string, string>();
  for (const path of [paths.globalPath, paths.projectPath]) {
    const read = readCliffConfigFile(path);
    if (read.state === "absent") {
      continue;
    }
    if (read.state === "invalid") {
      errors.push(...read.errors);
      continue;
    }
    layers.push(read.settings);
    for (const key of Object.keys(read.settings)) {
      originByKey.set(key, path);
    }
  }
  return {
    config: mergeCliffConfig(layers),
    origins: [...originByKey.entries()].map(([key, path]) => ({ key, path })),
    errors,
  };
}

/** What reading one config file produced. Absence is normal; everything else is reportable. */
type CliffConfigFileRead =
  | { state: "absent" }
  | { state: "invalid"; errors: string[] }
  | { state: "read"; settings: CliffConfigSettings };

/** Reads one file, treating only "no such file" as absence, so a permissions problem is reported. */
function readCliffConfigFile(path: string): CliffConfigFileRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { state: "absent" };
    }
    return {
      state: "invalid",
      errors: [cliffProblem(path, `cannot be read: ${describeError(error)}`)],
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return {
      state: "invalid",
      errors: [cliffProblem(path, `is not valid JSON: ${describeError(error)}`)],
    };
  }
  const parsed = parseCliffConfigDocument(document, path);
  if (parsed.ok) {
    return { state: "read", settings: parsed.settings };
  }
  return { state: "invalid", errors: parsed.errors };
}

/**
 * Builds every config diagnostic, so a message seen in a log or a notification greps back to this
 * module. `label` names the file when one is known, and is empty for the pure parser.
 */
function cliffProblem(label: string, detail: string): string {
  if (label === "") {
    return `Cliff config: ${detail}`;
  }
  return `Cliff config ${label}: ${detail}`;
}

function parseCliffConfigDocument(document: unknown, label: string): CliffConfigParse {
  if (!isDocumentObject(document)) {
    return {
      ok: false,
      errors: [
        cliffProblem(
          label,
          `expected a JSON object of Cliff settings, not ${describeValue(document)}`,
        ),
      ],
    };
  }
  const errors: string[] = [];
  for (const key of Object.keys(document)) {
    if (!CLIFF_CONFIG_KEYS.some((known) => known === key)) {
      errors.push(
        cliffProblem(label, `unknown key "${key}"; Cliff knows ${CLIFF_CONFIG_KEYS.join(", ")}`),
      );
    }
  }
  const settings: CliffConfigSettings = {};
  for (const key of CLIFF_CONFIG_KEYS) {
    const raw = document[key];
    if (raw === undefined) {
      continue;
    }
    Object.assign(settings, readCliffConfigSetting(key, raw, label, errors));
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, settings };
}

/** One known key's contribution to a settings patch, or nothing plus a recorded error. */
function readCliffConfigSetting(
  key: (typeof CLIFF_CONFIG_KEYS)[number],
  raw: unknown,
  label: string,
  errors: string[],
): CliffConfigSettings {
  switch (key) {
    case "mode": {
      const mode = readCliffMode(raw, label, errors);
      return mode === undefined ? {} : { mode };
    }
    case "keepThinking": {
      const keepThinking = readCliffBoolean(key, raw, label, errors);
      return keepThinking === undefined ? {} : { keepThinking };
    }
    case "thoughtMaxChars": {
      const cap = readCliffCharCap(key, raw, label, errors);
      return cap === undefined ? {} : { thoughtMaxChars: cap };
    }
    case "thinkingMaxChars": {
      const cap = readCliffCharCap(key, raw, label, errors);
      return cap === undefined ? {} : { thinkingMaxChars: cap };
    }
    case "cmdMaxChars": {
      const cap = readCliffCharCap(key, raw, label, errors);
      return cap === undefined ? {} : { cmdMaxChars: cap };
    }
    case "resultMaxChars": {
      const cap = readCliffCharCap(key, raw, label, errors);
      return cap === undefined ? {} : { resultMaxChars: cap };
    }
    case "humanMaxChars": {
      const cap = readCliffCharCap(key, raw, label, errors);
      return cap === undefined ? {} : { humanMaxChars: cap };
    }
    default: {
      // A name in CLIFF_CONFIG_KEYS with no reader lands here, which is the whole point of the list.
      const unhandled: never = key;
      throw new Error(`Cliff config has no reader for the key ${String(unhandled)}`);
    }
  }
}

function readCliffMode(raw: unknown, label: string, errors: string[]): CliffMode | undefined {
  for (const mode of CLIFF_MODE_VALUES) {
    if (raw === mode) {
      return mode;
    }
  }
  errors.push(
    cliffProblem(label, `"mode" must be one of ${quotedModes()}, not ${describeValue(raw)}`),
  );
  return undefined;
}

function readCliffBoolean(
  key: string,
  raw: unknown,
  label: string,
  errors: string[],
): boolean | undefined {
  if (raw === true || raw === false) {
    return raw;
  }
  errors.push(cliffProblem(label, `"${key}" must be true or false, not ${describeValue(raw)}`));
  return undefined;
}

/**
 * Reads one `*MaxChars` cap: a whole number of characters, where `0` is a value rather than an error.
 *
 * The text caps read `0` as unlimited and `resultMaxChars` reads it as "drop every non-empty result",
 * so the validator accepts zero everywhere and leaves the meaning to the render rules.
 */
function readCliffCharCap(
  key: string,
  raw: unknown,
  label: string,
  errors: string[],
): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    errors.push(
      cliffProblem(
        label,
        `"${key}" must be a whole number of characters, 0 for unlimited, not ${describeValue(raw)}`,
      ),
    );
    return undefined;
  }
  if (raw < 0) {
    errors.push(cliffProblem(label, `"${key}" must not be negative; 0 means unlimited`));
    return undefined;
  }
  return raw;
}

function quotedModes(): string {
  return CLIFF_MODE_VALUES.map((mode) => `"${mode}"`).join(", ");
}

/**
 * True when the parsed document is a JSON object, which is the only shape a `cliff.json` can have.
 *
 * A type predicate rather than a cast, so nothing downstream inherits an asserted shape.
 */
function isDocumentObject(document: unknown): document is Record<string, unknown> {
  return typeof document === "object" && document !== null && !Array.isArray(document);
}

/** Names a wrong value the way the user wrote it, so the message points at the line to fix. */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return String(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for the error a path that does not exist produces, which is the only absence Cliff accepts. */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
