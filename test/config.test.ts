/**
 * Tests for `cliff.json`: what the parser accepts, what it rejects, and how the files combine.
 *
 * Every case that touches the filesystem runs against a temp directory, because the whole point of
 * `loadCliffConfig` taking explicit paths is that a test can prove Cliff reads what it is told and
 * nothing else. The host's real `~/.pi/agent/cliff.json` is never a fixture here.
 *
 * The zero-semantics cases are pinned rather than assumed: `0` is unlimited for a text cap and "drop
 * every non-empty result" for `resultMaxChars`, so the parser must accept `0` everywhere and leave the
 * meaning to the render rules, which `test/cliff.test.ts` covers against upstream's own goldens.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_POLICY } from "../src/cliff.js";
import {
  CLIFF_CONFIG_FILE_NAME,
  DEFAULT_CLIFF_CONFIG,
  loadCliffConfig,
  mergeCliffConfig,
  parseCliffConfig,
  type CliffConfigPaths,
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

function paths(globalPath?: string, projectPath?: string): CliffConfigPaths {
  return {
    globalPath: globalPath ?? scratchPath("global", CLIFF_CONFIG_FILE_NAME),
    projectPath: projectPath ?? scratchPath("project", ".pi", CLIFF_CONFIG_FILE_NAME),
  };
}

describe("parseCliffConfig accepts what the documentation allows", () => {
  it("names no settings for an empty document, so the defaults stand", () => {
    const parsed = parseCliffConfig({});
    if (!parsed.ok) {
      throw new Error(`Cliff test: ${parsed.errors.join("; ")}`);
    }
    expect(parsed.settings).toEqual({});
    expect(mergeCliffConfig([parsed.settings])).toEqual(DEFAULT_CLIFF_CONFIG);
  });

  it("accepts each mode by name", () => {
    for (const mode of ["active", "shadow", "off"] as const) {
      const parsed = parseCliffConfig({ mode });
      expect(parsed.ok ? parsed.settings : parsed.errors).toEqual({ mode });
    }
  });

  it("accepts 0 for every text cap, which means unlimited", () => {
    const parsed = parseCliffConfig({
      thoughtMaxChars: 0,
      thinkingMaxChars: 0,
      cmdMaxChars: 0,
      humanMaxChars: 0,
    });
    if (!parsed.ok) {
      throw new Error(`Cliff test: ${parsed.errors.join("; ")}`);
    }
    expect(parsed.settings).toEqual({
      thoughtMaxChars: 0,
      thinkingMaxChars: 0,
      cmdMaxChars: 0,
      humanMaxChars: 0,
    });
  });

  it("accepts resultMaxChars 0, which is upstream's drop-every-result value, not an error", () => {
    const parsed = parseCliffConfig({ resultMaxChars: 0 });
    if (!parsed.ok) {
      throw new Error(`Cliff test: resultMaxChars 0 was rejected: ${parsed.errors.join("; ")}`);
    }
    expect(parsed.settings.resultMaxChars).toBe(0);
  });

  it("accepts keepThinking either way", () => {
    expect(parseCliffConfig({ keepThinking: false })).toEqual({
      ok: true,
      settings: { keepThinking: false },
    });
    expect(parseCliffConfig({ keepThinking: true })).toEqual({
      ok: true,
      settings: { keepThinking: true },
    });
  });

  it("reads every documented key, which is the guard against a key accepted but never applied", () => {
    const document = {
      mode: "shadow",
      keepThinking: false,
      thoughtMaxChars: 11,
      thinkingMaxChars: 12,
      cmdMaxChars: 13,
      resultMaxChars: 14,
      humanMaxChars: 15,
    };
    const parsed = parseCliffConfig(document);
    if (!parsed.ok) {
      throw new Error(`Cliff test: ${parsed.errors.join("; ")}`);
    }
    expect(parsed.settings).toEqual(document);
    expect(Object.keys(parsed.settings)).toHaveLength(7);
  });
});

describe("parseCliffConfig rejects what it cannot honour", () => {
  it("rejects an unknown key and names the keys it knows", () => {
    const parsed = parseCliffConfig({ modee: "active" });
    if (parsed.ok) {
      throw new Error("Cliff test: an unknown key was accepted");
    }
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('unknown key "modee"');
    expect(parsed.errors[0]).toContain("keepThinking");
    expect(parsed.errors[0]).toContain("resultMaxChars");
  });

  it("rejects a key whose only mistake is its case, because a silently ignored cap is worse", () => {
    const parsed = parseCliffConfig({ Mode: "off" });
    expect(!parsed.ok && parsed.errors[0]?.includes('unknown key "Mode"')).toBe(true);
  });

  it("rejects a mode outside the three documented ones and lists them", () => {
    const parsed = parseCliffConfig({ mode: "aggressive" });
    if (parsed.ok) {
      throw new Error("Cliff test: an unknown mode was accepted");
    }
    expect(parsed.errors[0]).toContain('"mode" must be one of "active", "shadow", "off"');
    expect(parsed.errors[0]).toContain('"aggressive"');
  });

  it("rejects a negative cap", () => {
    const parsed = parseCliffConfig({ cmdMaxChars: -1 });
    if (parsed.ok) {
      throw new Error("Cliff test: a negative cap was accepted");
    }
    expect(parsed.errors[0]).toContain('"cmdMaxChars" must not be negative');
  });

  it("rejects a fractional cap, because a cap is a count of characters", () => {
    const parsed = parseCliffConfig({ humanMaxChars: 10.5 });
    expect(!parsed.ok && parsed.errors[0]?.includes('"humanMaxChars" must be a whole number')).toBe(
      true,
    );
  });

  it("rejects the numbers JSON cannot hold, which a caller building settings in code could pass", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const parsed = parseCliffConfig({ thoughtMaxChars: value });
      expect(!parsed.ok && parsed.errors[0]?.includes('"thoughtMaxChars"')).toBe(true);
    }
  });

  it("rejects a cap that is not a number, naming what was found", () => {
    expect(parseCliffConfig({ cmdMaxChars: "150" })).toEqual({
      ok: false,
      errors: [
        'Cliff config: "cmdMaxChars" must be a whole number of characters, 0 for unlimited, not "150"',
      ],
    });
    expect(parseCliffConfig({ humanMaxChars: null })).toEqual({
      ok: false,
      errors: [
        'Cliff config: "humanMaxChars" must be a whole number of characters, 0 for unlimited, not null',
      ],
    });
  });

  it("rejects a keepThinking that is not a boolean", () => {
    const parsed = parseCliffConfig({ keepThinking: "yes" });
    expect(!parsed.ok && parsed.errors[0]?.includes('"keepThinking" must be true or false')).toBe(
      true,
    );
  });

  it("rejects a document that is not an object, including an array", () => {
    for (const document of [null, 7, "active", ["mode"], true]) {
      const parsed = parseCliffConfig(document);
      expect(!parsed.ok && parsed.errors[0]?.includes("expected a JSON object")).toBe(true);
    }
  });

  it("reports every problem in one pass, so one report lists all of the user's mistakes", () => {
    const parsed = parseCliffConfig({ mode: "slow", keepThinking: 1, thoughtMaxChars: -2, x: 1 });
    if (parsed.ok) {
      throw new Error("Cliff test: an invalid document was accepted");
    }
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors.join("\n")).toContain('"mode"');
    expect(parsed.errors.join("\n")).toContain('"keepThinking"');
    expect(parsed.errors.join("\n")).toContain('"thoughtMaxChars"');
    expect(parsed.errors.join("\n")).toContain('unknown key "x"');
  });

  it("prefixes every message so a diagnostic greps back to the config module", () => {
    const parsed = parseCliffConfig({ mode: "slow" });
    expect(!parsed.ok && parsed.errors[0]?.startsWith("Cliff config:")).toBe(true);
  });
});

describe("mergeCliffConfig", () => {
  it("returns upstream's defaults when no layer names anything", () => {
    expect(mergeCliffConfig([])).toEqual(DEFAULT_CLIFF_CONFIG);
    expect(mergeCliffConfig([])).toEqual({ mode: "active", ...DEFAULT_SUMMARY_POLICY });
  });

  it("applies layers in order, so the project file wins over the global one", () => {
    const resolved = mergeCliffConfig([{ cmdMaxChars: 100 }, { cmdMaxChars: 20, mode: "shadow" }]);
    expect(resolved.cmdMaxChars).toBe(20);
    expect(resolved.mode).toBe("shadow");
  });

  it("keeps the other caps when a layer names only one, which is what a one-key project file needs", () => {
    const resolved = mergeCliffConfig([{ cmdMaxChars: 100, humanMaxChars: 500 }, { mode: "off" }]);
    expect(resolved).toEqual({
      mode: "off",
      keepThinking: DEFAULT_SUMMARY_POLICY.keepThinking,
      thoughtMaxChars: DEFAULT_SUMMARY_POLICY.thoughtMaxChars,
      thinkingMaxChars: DEFAULT_SUMMARY_POLICY.thinkingMaxChars,
      cmdMaxChars: 100,
      resultMaxChars: DEFAULT_SUMMARY_POLICY.resultMaxChars,
      humanMaxChars: 500,
    });
  });

  it("does not mutate the defaults or its layers", () => {
    const globalSettings = { cmdMaxChars: 100 };
    mergeCliffConfig([globalSettings]);
    expect(DEFAULT_CLIFF_CONFIG.cmdMaxChars).toBe(DEFAULT_SUMMARY_POLICY.cmdMaxChars);
    expect(globalSettings).toEqual({ cmdMaxChars: 100 });
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
    await writeConfigFileWith(globalPath, { cmdMaxChars: 100, humanMaxChars: 900 });
    await writeConfigFileWith(projectPath, { cmdMaxChars: 20, mode: "off" });
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.config).toEqual({
      ...DEFAULT_CLIFF_CONFIG,
      mode: "off",
      cmdMaxChars: 20,
      humanMaxChars: 900,
    });
    expect(loaded.origins).toEqual([
      { key: "cmdMaxChars", path: projectPath },
      { key: "humanMaxChars", path: globalPath },
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
    await writeConfigFileWith(paths().globalPath, { cmdMaxChars: "wide" });
    await writeConfigFileWith(projectPath, { humanMaxChars: -1 });
    const loaded = loadCliffConfig({ globalPath, projectPath });
    expect(loaded.errors).toHaveLength(2);
    expect(loaded.config).toEqual(DEFAULT_CLIFF_CONFIG);
  });

  it("reads a file written in the shape the README documents", async () => {
    const { globalPath, projectPath } = paths();
    const documented = `{
  "mode": "active",
  "keepThinking": true,
  "thoughtMaxChars": 0,
  "thinkingMaxChars": 0,
  "cmdMaxChars": 150,
  "resultMaxChars": 500,
  "humanMaxChars": 20000
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
