/**
 * Tests for `cliff.json`: what the parser accepts, what it rejects, and how the files combine.
 *
 * Every case that touches the filesystem runs against a temp directory, because the whole point of
 * `loadCliffConfig` taking explicit paths is that a test can prove Cliff reads what it is told and
 * nothing else. The host's real `~/.pi/agent/cliff.json` is never a fixture here.
 *
 * The policy tests pin the literal `unlimited` value and the uniform zero-means-no-content rule.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_POLICY, type CharacterLimit } from "../src/cliff.js";
import {
  CLIFF_CONFIG_FILE_NAME,
  CLIFF_CONFIG_OPTIONS,
  DEFAULT_CLIFF_CONFIG,
  formatCliffConfigHelp,
  loadCliffConfig,
  mergeCliffConfig,
  parseCliffConfig,
  type CliffConfigPaths,
  type EstimatedTokenLimit,
} from "../src/config.js";

/** Directories created by the current test, removed after it. */
let scratch = "";

beforeEach(async () => {
  scratch = await mkdtemp(join(await realpath(tmpdir()), "cliff-config-"));
});

afterEach(async () => {
  if (scratch !== "") {
    await rm(scratch, { recursive: true, force: true });
  }
});

/** A path inside the current test's scratch directory. */
function scratchPath(...parts: string[]): string {
  return join(scratch, ...parts);
}

/** Writes a `cliff.json` at `path`, creating its parent directory, and returns the path. */
async function writeConfigFile(path: string, contents: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  return path;
}

/** Writes a `cliff.json` holding these settings. */
async function writeConfigFileWith(path: string, settings: unknown): Promise<string> {
  return await writeConfigFile(path, JSON.stringify(settings));
}

function tokenLimitFromRenderer(limit: CharacterLimit): EstimatedTokenLimit {
  return limit === "unlimited" ? limit : limit / 4;
}

function paths(globalPath?: string, projectPath?: string): CliffConfigPaths {
  return {
    globalPath: globalPath ?? scratchPath("global", CLIFF_CONFIG_FILE_NAME),
    projectPath: projectPath ?? scratchPath("project", ".pi", CLIFF_CONFIG_FILE_NAME),
  };
}

describe("parseCliffConfig accepts the documented policy", () => {
  it("leaves defaults alone for an empty object", () => {
    const parsed = parseCliffConfig({});
    expect(parsed).toEqual({ ok: true, settings: {} });
    expect(mergeCliffConfig([{}])).toEqual(DEFAULT_CLIFF_CONFIG);
  });

  it("accepts each mode", () => {
    for (const mode of ["active", "shadow", "off"] as const) {
      expect(parseCliffConfig({ mode })).toEqual({ ok: true, settings: { mode } });
    }
  });

  it("accepts zero and the exact unlimited sentinel for all five limits", () => {
    const parsed = parseCliffConfig({
      assistantTextMaxTokens: 0,
      reasoningTextMaxTokens: "unlimited",
      toolCallMaxTokens: 1.25,
      toolResultMaxTokens: 0,
      userTextMaxTokens: "unlimited",
    });
    expect(parsed).toEqual({
      ok: true,
      settings: {
        assistantTextMaxTokens: 0,
        reasoningTextMaxTokens: "unlimited",
        toolCallMaxTokens: 1.25,
        toolResultMaxTokens: 0,
        userTextMaxTokens: "unlimited",
      },
    });
  });

  it("keeps zero and unlimited semantics for all five public limits", () => {
    for (const value of [0, "unlimited"] as const) {
      const settings = {
        assistantTextMaxTokens: value,
        reasoningTextMaxTokens: value,
        toolCallMaxTokens: value,
        toolResultMaxTokens: value,
        userTextMaxTokens: value,
      };
      expect(parseCliffConfig(settings)).toEqual({ ok: true, settings });
    }
  });

  it("accepts includeReasoning either way", () => {
    expect(parseCliffConfig({ includeReasoning: false })).toEqual({
      ok: true,
      settings: { includeReasoning: false },
    });
    expect(parseCliffConfig({ includeReasoning: true })).toEqual({
      ok: true,
      settings: { includeReasoning: true },
    });
  });

  it("reads all seven settings under their public names", () => {
    const document = {
      mode: "shadow",
      includeReasoning: false,
      assistantTextMaxTokens: 11,
      reasoningTextMaxTokens: 12,
      toolCallMaxTokens: 13,
      toolResultMaxTokens: 14,
      userTextMaxTokens: 15,
    };
    const parsed = parseCliffConfig(document);
    expect(parsed).toEqual({ ok: true, settings: document });
    expect(parsed.ok && Object.keys(parsed.settings)).toHaveLength(7);
  });

  it("formats one copyable strict JSON default object from the option metadata", () => {
    const help = formatCliffConfigHelp();
    const defaultBlock = help.match(/```json\n([\s\S]*?)\n```/)?.[1];

    expect(CLIFF_CONFIG_OPTIONS.map(({ key }) => key)).toEqual([
      "mode",
      "includeReasoning",
      "assistantTextMaxTokens",
      "reasoningTextMaxTokens",
      "toolCallMaxTokens",
      "toolResultMaxTokens",
      "userTextMaxTokens",
    ]);
    expect(defaultBlock).toBeDefined();
    expect(JSON.parse(defaultBlock ?? "")).toEqual(DEFAULT_CLIFF_CONFIG);
    expect(DEFAULT_CLIFF_CONFIG).toEqual({
      mode: "active",
      includeReasoning: true,
      assistantTextMaxTokens: "unlimited",
      reasoningTextMaxTokens: "unlimited",
      toolCallMaxTokens: 37.5,
      toolResultMaxTokens: 125,
      userTextMaxTokens: 5_000,
    });
    expect(DEFAULT_CLIFF_CONFIG.toolCallMaxTokens).toBe(
      tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.toolCallMaxChars),
    );
    expect(DEFAULT_CLIFF_CONFIG.toolResultMaxTokens).toBe(
      tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.toolResultMaxChars),
    );
    expect(DEFAULT_CLIFF_CONFIG.userTextMaxTokens).toBe(
      tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.userTextMaxChars),
    );
    expect(help).toContain("Config files: ~/.pi/agent/cliff.json or <project>/.pi/cliff.json");
    expect(help).toContain(
      "Precedence: built-in defaults, then the global file, then the project file.",
    );
    expect(help).toContain(
      "active: Cliff writes a mechanical summary; Pi does not call its model summarizer.",
    );
    expect(help).toContain(
      "shadow: Cliff computes a comparison summary, then Pi calls its model summarizer.",
    );
    expect(help).toContain("off: Cliff is disabled; Pi compacts with its model summarizer.");
    expect(help).toContain(
      'When a valid config file selects "off", errors in the other file do not block Pi; /cliff still reports them.',
    );
    expect(help).toContain(
      "reasoningTextMaxTokens: Estimated-token limit for reasoning text per assistant message; ignored when includeReasoning is false.",
    );
    expect(help).toContain("Unicode code points divided by 4, not tokenizer counts.");
    expect(help).toContain("exact quarter-token steps");
    expect(help).toContain("75 estimated tokens");
    expect(help).toContain("Pi owns the compaction trigger, cut, kept tail, and persistence");
  });
});

describe("parseCliffConfig rejects unsupported config", () => {
  it("rejects unknown names and suggests exact replacements for retired keys", () => {
    const unknown = parseCliffConfig({ modee: "active" });
    expect(!unknown.ok && unknown.errors[0]).toContain('unknown key "modee"');
    expect(!unknown.ok && unknown.errors[0]).toContain("includeReasoning");
    expect(!unknown.ok && unknown.errors[0]).toContain("toolResultMaxTokens");
    expect(parseCliffConfig({ Mode: "off" })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('unknown key "Mode"')],
    });

    const retired = [
      ["keepThinking", "includeReasoning", undefined],
      ["assistantTextMaxChars", "assistantTextMaxTokens", "Divide finite code-point values by 4"],
      ["thoughtMaxChars", "assistantTextMaxTokens", "legacy 0 meant unlimited"],
      ["reasoningTextMaxChars", "reasoningTextMaxTokens", "Divide finite code-point values by 4"],
      ["thinkingMaxChars", "reasoningTextMaxTokens", "legacy 0 meant unlimited"],
      ["toolCallMaxChars", "toolCallMaxTokens", "Divide finite code-point values by 4"],
      ["cmdMaxChars", "toolCallMaxTokens", "legacy 0 meant unlimited"],
      ["toolResultMaxChars", "toolResultMaxTokens", "Divide finite code-point values by 4"],
      ["resultMaxChars", "toolResultMaxTokens", "legacy 0 still drops every non-empty result"],
      ["userTextMaxChars", "userTextMaxTokens", "Divide finite code-point values by 4"],
      ["humanMaxChars", "userTextMaxTokens", "legacy 0 meant unlimited"],
    ] as const;
    for (const [retiredKey, replacement, hint] of retired) {
      const parsed = parseCliffConfig({ [retiredKey]: 0 });
      expect(!parsed.ok && parsed.errors[0]).toContain(`retired key "${retiredKey}"`);
      expect(!parsed.ok && parsed.errors[0]).toContain(`"${replacement}"`);
      if (hint !== undefined) {
        expect(!parsed.ok && parsed.errors[0]).toContain(hint);
      }
    }
  });

  it("rejects an unknown mode and lists the accepted modes", () => {
    const parsed = parseCliffConfig({ mode: "aggressive" });
    expect(!parsed.ok && parsed.errors[0]).toContain(
      '"mode" must be one of "active", "shadow", "off"',
    );
  });

  it("rejects negative, fractional, unsafe, null, and non-exact strings for every limit", () => {
    const limitKeys = [
      "assistantTextMaxTokens",
      "reasoningTextMaxTokens",
      "toolCallMaxTokens",
      "toolResultMaxTokens",
      "userTextMaxTokens",
    ] as const;
    const invalidValues: unknown[] = [
      -1,
      10.1,
      Number.MAX_SAFE_INTEGER,
      (Number.MAX_SAFE_INTEGER + 1) / 4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
      "150",
      "Unlimited",
    ];
    for (const key of limitKeys) {
      for (const value of invalidValues) {
        const parsed = parseCliffConfig({ [key]: value });
        expect(!parsed.ok && parsed.errors[0]).toContain(`"${key}"`);
      }
    }
    expect(parseCliffConfig({ userTextMaxTokens: -1 })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('"userTextMaxTokens" must not be negative')],
    });
  });

  it("accepts quarter-token steps including signed zero and the public default limits", () => {
    expect(
      parseCliffConfig({
        assistantTextMaxTokens: -0,
        reasoningTextMaxTokens: 0.25,
        toolCallMaxTokens: 37.5,
        toolResultMaxTokens: 125,
        userTextMaxTokens: 5_000,
      }),
    ).toEqual({
      ok: true,
      settings: {
        assistantTextMaxTokens: -0,
        reasoningTextMaxTokens: 0.25,
        toolCallMaxTokens: 37.5,
        toolResultMaxTokens: 125,
        userTextMaxTokens: 5_000,
      },
    });
    expect(parseCliffConfig({ assistantTextMaxTokens: 0.1 })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("exact quarter-token steps")],
    });
  });

  it("rejects a non-boolean includeReasoning value", () => {
    const parsed = parseCliffConfig({ includeReasoning: "yes" });
    expect(!parsed.ok && parsed.errors[0]).toContain('"includeReasoning" must be true or false');
  });

  it("describes an invalid object value as JSON instead of [object Object]", () => {
    const parsed = parseCliffConfig({ mode: { unexpected: true } });
    expect(!parsed.ok && parsed.errors[0]).toContain('not {"unexpected":true}');
  });

  it("rejects a document that is not an object, including an array", () => {
    for (const document of [null, 7, "active", ["mode"], true]) {
      const parsed = parseCliffConfig(document);
      expect(!parsed.ok && parsed.errors[0]).toContain("expected a JSON object");
    }
  });

  it("reports every problem in one pass with a config prefix", () => {
    const parsed = parseCliffConfig({
      mode: "slow",
      includeReasoning: 1,
      assistantTextMaxTokens: -2,
      unknown: 1,
    });
    expect(parsed).toMatchObject({ ok: false, errors: expect.any(Array) });
    if (!parsed.ok) {
      expect(parsed.errors).toHaveLength(4);
      expect(parsed.errors.join("\n")).toContain('"mode"');
      expect(parsed.errors.join("\n")).toContain('"includeReasoning"');
      expect(parsed.errors.join("\n")).toContain('"assistantTextMaxTokens"');
      expect(parsed.errors.join("\n")).toContain('unknown key "unknown"');
      expect(parsed.errors.every((error) => error.startsWith("Cliff config:"))).toBe(true);
    }
  });
});

describe("mergeCliffConfig", () => {
  it("returns token defaults derived from the unchanged renderer caps", () => {
    expect(mergeCliffConfig([])).toEqual(DEFAULT_CLIFF_CONFIG);
    expect(DEFAULT_CLIFF_CONFIG).toEqual({
      mode: "active",
      includeReasoning: DEFAULT_SUMMARY_POLICY.includeReasoning,
      assistantTextMaxTokens: tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.assistantTextMaxChars),
      reasoningTextMaxTokens: tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.reasoningTextMaxChars),
      toolCallMaxTokens: tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.toolCallMaxChars),
      toolResultMaxTokens: tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.toolResultMaxChars),
      userTextMaxTokens: tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.userTextMaxChars),
    });
  });

  it("applies layers in order, so the project file wins over the global one", () => {
    const resolved = mergeCliffConfig([
      { toolCallMaxTokens: 100 },
      { toolCallMaxTokens: 20, mode: "shadow" },
    ]);
    expect(resolved.toolCallMaxTokens).toBe(20);
    expect(resolved.mode).toBe("shadow");
  });

  it("keeps unnamed values when a layer overrides only one or two keys", () => {
    const resolved = mergeCliffConfig([
      { toolCallMaxTokens: 100, userTextMaxTokens: 500 },
      { mode: "off" },
    ]);
    expect(resolved).toEqual({
      mode: "off",
      includeReasoning: DEFAULT_SUMMARY_POLICY.includeReasoning,
      assistantTextMaxTokens: DEFAULT_SUMMARY_POLICY.assistantTextMaxChars,
      reasoningTextMaxTokens: DEFAULT_SUMMARY_POLICY.reasoningTextMaxChars,
      toolCallMaxTokens: 100,
      toolResultMaxTokens: tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.toolResultMaxChars),
      userTextMaxTokens: 500,
    });
  });

  it("does not mutate the defaults or its layers", () => {
    const globalSettings = { toolCallMaxTokens: 100 };
    mergeCliffConfig([globalSettings]);
    expect(DEFAULT_CLIFF_CONFIG.toolCallMaxTokens).toBe(
      tokenLimitFromRenderer(DEFAULT_SUMMARY_POLICY.toolCallMaxChars),
    );
    expect(globalSettings).toEqual({ toolCallMaxTokens: 100 });
  });
});

describe("loadCliffConfig reads the two files it is handed", () => {
  it("resolves the defaults when neither file exists, and reports no error for absence", async () => {
    const loaded = loadCliffConfig(paths());
    expect(loaded.errors).toEqual([]);
    expect(loaded.origins).toEqual([]);
    expect(loaded.config).toEqual(DEFAULT_CLIFF_CONFIG);
  });

  it("creates nothing when the config directories do not exist", async () => {
    const loaded = loadCliffConfig(paths());
    expect(loaded.errors).toEqual([]);
    expect(listScratch()).toEqual([]);
  });

  it("reads the global file on its own", async () => {
    const globalPath = await writeConfigFileWith(paths().globalPath, { mode: "shadow" });
    const loaded = loadCliffConfig(paths(globalPath));
    expect(loaded.config.mode).toBe("shadow");
    expect(loaded.origins).toEqual([{ key: "mode", path: globalPath }]);
  });

  it("lets the project file win key by key and records which file each value came from", async () => {
    const { globalPath, projectPath } = paths();
    await writeConfigFileWith(globalPath, { toolCallMaxTokens: 100, userTextMaxTokens: 900 });
    await writeConfigFileWith(projectPath, { toolCallMaxTokens: 20, mode: "off" });
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.config).toEqual({
      ...DEFAULT_CLIFF_CONFIG,
      mode: "off",
      toolCallMaxTokens: 20,
      userTextMaxTokens: 900,
    });
    expect(loaded.origins).toEqual([
      { key: "toolCallMaxTokens", path: projectPath },
      { key: "userTextMaxTokens", path: globalPath },
      { key: "mode", path: projectPath },
    ]);
  });

  it("names the offending file in every error", async () => {
    const { globalPath, projectPath } = paths();
    await writeConfigFile(globalPath, "{ not json");
    await writeConfigFileWith(projectPath, { mode: "mid" });
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.errors).toHaveLength(2);
    expect(loaded.errors[0]).toContain(globalPath);
    expect(loaded.errors[0]).toContain("is not valid JSON");
    expect(loaded.errors[1]).toContain(projectPath);
    expect(loaded.errors[1]).toContain('"mode" must be one of');
  });

  it("still reports a file that exists but cannot be read, rather than treating it as absent", async () => {
    const { globalPath, projectPath } = paths();
    mkdirSync(globalPath, { recursive: true });
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toContain(globalPath);
    expect(loaded.errors[0]).toContain("cannot be read");
  });

  it("reads both files even when the first is broken, so one report lists every mistake", async () => {
    const { globalPath, projectPath } = paths();
    await writeConfigFileWith(paths().globalPath, { toolCallMaxTokens: "wide" });
    await writeConfigFileWith(projectPath, { userTextMaxTokens: -1 });
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.errors).toHaveLength(2);
    expect(loaded.config).toEqual(DEFAULT_CLIFF_CONFIG);
  });

  it("reads a file written in the shape the README documents", async () => {
    const { globalPath, projectPath } = paths();
    const documented = `{
  "mode": "active",
  "includeReasoning": true,
  "assistantTextMaxTokens": "unlimited",
  "reasoningTextMaxTokens": "unlimited",
  "toolCallMaxTokens": 37.5,
  "toolResultMaxTokens": 125,
  "userTextMaxTokens": 5000
}
`;
    await writeConfigFile(globalPath, documented);
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.errors).toEqual([]);
    expect(loaded.config).toEqual(DEFAULT_CLIFF_CONFIG);
  });

  it("reads nothing outside the paths it was given", async () => {
    const { globalPath, projectPath } = paths();
    await writeConfigFileWith(globalPath, { mode: "shadow" });
    const before = listScratch();
    loadCliffConfig({ globalPath, projectPath });
    expect(listScratch()).toEqual(before);
  });
});

/** Paths under the scratch directory, relative to it, so a test can assert reading config creates nothing. */
function listScratch(): string[] {
  return walk(scratch).map((entry) => relative(scratch, entry));
}

function walk(directory: string): string[] {
  const entries: string[] = [];
  if (!existsSync(directory)) {
    return entries;
  }
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    entries.push(full);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    }
  }
  return entries.sort();
}
