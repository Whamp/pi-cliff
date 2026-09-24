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
import { DEFAULT_SUMMARY_POLICY, type CharacterLimit, type SummaryPolicy } from "./cliff.js";

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

/** Rendering defaults that preserve upstream output, with `active` ownership when no file exists. */
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
  includeReasoning?: boolean;
  assistantTextMaxChars?: CharacterLimit;
  reasoningTextMaxChars?: CharacterLimit;
  toolCallMaxChars?: CharacterLimit;
  toolResultMaxChars?: CharacterLimit;
  userTextMaxChars?: CharacterLimit;
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
  key: keyof CliffConfig;
  path: string;
}

/** What Cliff did with one of the two files, so `/cliff` can name the source of every value. */
export interface CliffConfigFileState {
  path: string;
  state: "absent" | "read" | "invalid";
}

/** What reading the config files produced. Errors never suppress the config; the caller decides. */
export interface CliffConfigLoad {
  config: CliffConfig;
  origins: CliffConfigOrigin[];
  files: CliffConfigFileState[];
  errors: string[];
}

/** One documented config key, its command-help meaning, and any retired spelling to diagnose. */
type CliffConfigOption<Key extends keyof CliffConfig = keyof CliffConfig> = {
  key: Key;
  description: string;
  retiredKey?: string;
  migrationHint?: string;
};

/**
 * Ordered `cliff.json` keys for validation, `/cliff`, help, and default reporting.
 *
 * The tuple makes each resolved config key appear exactly once. Retired spellings are diagnostics
 * only; they are never accepted as aliases.
 */
export const CLIFF_CONFIG_OPTIONS = [
  { key: "mode", description: 'Compaction owner: "active", "shadow", or "off".' },
  {
    key: "includeReasoning",
    description: "Include assistant reasoning text.",
    retiredKey: "keepThinking",
  },
  {
    key: "assistantTextMaxChars",
    description: "Visible assistant text limit per message.",
    retiredKey: "thoughtMaxChars",
    migrationHint: 'Legacy 0 meant unlimited; use "unlimited" to preserve it.',
  },
  {
    key: "reasoningTextMaxChars",
    description: "Reasoning text limit per assistant message.",
    retiredKey: "thinkingMaxChars",
    migrationHint: 'Legacy 0 meant unlimited; use "unlimited" to preserve it.',
  },
  {
    key: "toolCallMaxChars",
    description: "Serialized tool-call argument limit, excluding the [toolName] wrapper.",
    retiredKey: "cmdMaxChars",
    migrationHint: 'Legacy 0 meant unlimited; use "unlimited" to preserve it.',
  },
  {
    key: "toolResultMaxChars",
    description: "Drop tool results whole when they exceed this limit.",
    retiredKey: "resultMaxChars",
    migrationHint: "Legacy 0 still drops every non-empty result.",
  },
  {
    key: "userTextMaxChars",
    description: "User and system text limit per block, including the carried opening head.",
    retiredKey: "humanMaxChars",
    migrationHint: 'Legacy 0 meant unlimited; use "unlimited" to preserve it.',
  },
] as const satisfies readonly [
  CliffConfigOption<"mode">,
  CliffConfigOption<"includeReasoning">,
  CliffConfigOption<"assistantTextMaxChars">,
  CliffConfigOption<"reasoningTextMaxChars">,
  CliffConfigOption<"toolCallMaxChars">,
  CliffConfigOption<"toolResultMaxChars">,
  CliffConfigOption<"userTextMaxChars">,
];

type CliffConfigKey = (typeof CLIFF_CONFIG_OPTIONS)[number]["key"];
const CLIFF_CONFIG_KEYS: readonly CliffConfigKey[] = CLIFF_CONFIG_OPTIONS.map(({ key }) => key);

/** The mode values, in the order the error message lists them. */
const CLIFF_MODE_VALUES = ["active", "shadow", "off"] as const satisfies readonly CliffMode[];

/**
 * Validates a parsed `cliff.json` document and returns only the keys the file named.
 *
 * The parameter is `unknown` because this is the decode boundary for a JSON file; everything
 * downstream works on {@link CliffConfigSettings}. Every problem is collected rather than thrown, so
 * one report names each mistake in the file instead of only the first.
 *
 * Limits accept nonnegative safe integers or the exact `"unlimited"` sentinel. Zero is valid and
 * retains no content in its category; positive tool-result limits drop oversized results whole.
 */
export function parseCliffConfig(document: unknown): CliffConfigParse {
  return parseCliffConfigDocument(document, "");
}

/** Formats one resolved config value as text for `/cliff`; only documented keys fit. */
export function describeCliffConfigValue(config: CliffConfig, key: CliffConfigKey): string {
  return String(config[key]);
}

/** Formats the documented keys and strict JSON defaults for `/cliff help`. */
export function formatCliffConfigHelp(): string {
  const lines = ["Cliff configuration", "Keys: ~/.pi/agent/cliff.json or <project>/.pi/cliff.json"];
  for (const option of CLIFF_CONFIG_OPTIONS) {
    lines.push(
      `  ${option.key}: ${option.description} Default: ${describeCliffConfigValue(DEFAULT_CLIFF_CONFIG, option.key)}`,
    );
  }
  lines.push(
    'Character limits count Unicode code points. A limit of 0 retains no content in that category; "unlimited" disables the limit.',
    "Zero omits whole tool-call lines and user/system labels. Positive text limits append an ellipsis after the configured number of code points.",
    "toolCallMaxChars caps serialized arguments, not the [toolName] wrapper; oversized tool results are dropped whole.",
    "Precedence: built-in defaults, then the global file, then the project file.",
    "Pi owns the compaction trigger, cut, kept tail, and persistence; Cliff only renders the summary.",
    "Default cliff.json:",
    "```json",
    JSON.stringify(DEFAULT_CLIFF_CONFIG, null, 2),
    "```",
    "Use /cliff to show effective values and their source.",
  );
  return lines.join("\n");
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
    if (settings.includeReasoning !== undefined) {
      config.includeReasoning = settings.includeReasoning;
    }
    if (settings.assistantTextMaxChars !== undefined) {
      config.assistantTextMaxChars = settings.assistantTextMaxChars;
    }
    if (settings.reasoningTextMaxChars !== undefined) {
      config.reasoningTextMaxChars = settings.reasoningTextMaxChars;
    }
    if (settings.toolCallMaxChars !== undefined) {
      config.toolCallMaxChars = settings.toolCallMaxChars;
    }
    if (settings.toolResultMaxChars !== undefined) {
      config.toolResultMaxChars = settings.toolResultMaxChars;
    }
    if (settings.userTextMaxChars !== undefined) {
      config.userTextMaxChars = settings.userTextMaxChars;
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
  const files: CliffConfigFileState[] = [];
  const originByKey = new Map<keyof CliffConfig, string>();
  for (const path of [paths.globalPath, paths.projectPath]) {
    const read = readCliffConfigFile(path);
    if (read.state === "absent") {
      files.push({ path, state: "absent" });
      continue;
    }
    if (read.state === "invalid") {
      files.push({ path, state: "invalid" });
      errors.push(...read.errors);
      continue;
    }
    files.push({ path, state: "read" });
    layers.push(read.settings);
    for (const { key } of CLIFF_CONFIG_OPTIONS) {
      if (Object.hasOwn(read.settings, key)) {
        originByKey.set(key, path);
      }
    }
  }
  return {
    config: mergeCliffConfig(layers),
    origins: [...originByKey.entries()].map(([key, path]) => ({ key, path })),
    files,
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
      const retiredOption = CLIFF_CONFIG_OPTIONS.find(
        (option) => "retiredKey" in option && option.retiredKey === key,
      );
      errors.push(
        retiredOption === undefined
          ? cliffProblem(label, `unknown key "${key}"; Cliff knows ${CLIFF_CONFIG_KEYS.join(", ")}`)
          : retiredCliffConfigKeyProblem(key, retiredOption, label),
      );
    }
  }
  const settings: CliffConfigSettings = {};
  for (const { key } of CLIFF_CONFIG_OPTIONS) {
    if (!Object.hasOwn(document, key)) {
      continue;
    }
    Object.assign(settings, readCliffConfigSetting(key, document[key], label, errors));
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, settings };
}

/** One known key's contribution to a settings patch, or nothing plus a recorded error. */
function readCliffConfigSetting(
  key: CliffConfigKey,
  raw: unknown,
  label: string,
  errors: string[],
): CliffConfigSettings {
  switch (key) {
    case "mode": {
      const mode = readCliffMode(raw, label, errors);
      return mode === undefined ? {} : { mode };
    }
    case "includeReasoning": {
      const includeReasoning = readCliffBoolean(key, raw, label, errors);
      return includeReasoning === undefined ? {} : { includeReasoning };
    }
    case "assistantTextMaxChars": {
      const cap = readCliffCharacterLimit(key, raw, label, errors);
      return cap === undefined ? {} : { assistantTextMaxChars: cap };
    }
    case "reasoningTextMaxChars": {
      const cap = readCliffCharacterLimit(key, raw, label, errors);
      return cap === undefined ? {} : { reasoningTextMaxChars: cap };
    }
    case "toolCallMaxChars": {
      const cap = readCliffCharacterLimit(key, raw, label, errors);
      return cap === undefined ? {} : { toolCallMaxChars: cap };
    }
    case "toolResultMaxChars": {
      const cap = readCliffCharacterLimit(key, raw, label, errors);
      return cap === undefined ? {} : { toolResultMaxChars: cap };
    }
    case "userTextMaxChars": {
      const cap = readCliffCharacterLimit(key, raw, label, errors);
      return cap === undefined ? {} : { userTextMaxChars: cap };
    }
    default: {
      // A documented option without an explicit decoder lands here, which keeps parsing exhaustive.
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
 * Reads one character limit: a nonnegative safe integer or the exact `unlimited` sentinel.
 */
function readCliffCharacterLimit(
  key: string,
  raw: unknown,
  label: string,
  errors: string[],
): CharacterLimit | undefined {
  if (raw === "unlimited") {
    return raw;
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    errors.push(
      cliffProblem(
        label,
        `"${key}" must be a nonnegative safe integer or exact "unlimited", not ${describeValue(raw)}`,
      ),
    );
    return undefined;
  }
  if (raw < 0) {
    errors.push(cliffProblem(label, `"${key}" must not be negative`));
    return undefined;
  }
  return raw;
}

/** Gives a retired setting's exact replacement and zero migration guidance. */
function retiredCliffConfigKeyProblem(
  key: string,
  option: CliffConfigOption,
  label: string,
): string {
  const migration = option.migrationHint === undefined ? "" : ` ${option.migrationHint}`;
  return cliffProblem(label, `retired key "${key}"; use "${option.key}" instead.${migration}`);
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
  if (typeof value === "object") {
    return JSON.stringify(value) ?? "an object";
  }
  switch (typeof value) {
    case "number":
    case "boolean":
    case "bigint":
      return `${value}`;
    case "symbol":
      return value.description === undefined ? "a symbol" : `Symbol(${value.description})`;
    case "function":
      return "a function";
    case "undefined":
      return "undefined";
  }
  return "an unsupported value";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for the error a path that does not exist produces, which is the only absence Cliff accepts. */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
