#!/usr/bin/env node
// Inspect a pi session JSONL produced by scripts/verify-live.sh and assert the
// extension's end-to-end behaviour. Exit code 0 means every check passed.
//
// Usage: node scripts/inspect-session.mjs <session.jsonl> [opening-marker]

import { readFileSync } from "node:fs";
import process from "node:process";

const SUMMARY_HEADER =
  "The following is a summary of your previous actions (long observations omitted):";

const file = process.argv[2];
const openingMarker = process.argv[3];
if (!file) {
  console.error("usage: node scripts/inspect-session.mjs <session.jsonl> [opening-marker]");
  process.exit(2);
}

const entries = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const compactions = entries.filter((entry) => entry.type === "compaction");
const messages = entries.filter((entry) => entry.type === "message");
const byId = new Map(entries.map((entry) => [entry.id, entry]));

console.log(
  `entries=${entries.length} messages=${messages.length} compactions=${compactions.length}`,
);
for (const entry of messages) {
  const message = entry.message ?? {};
  const blocks = Array.isArray(message.content)
    ? message.content.map((block) => block.type).join(",")
    : typeof message.content === "string"
      ? "string"
      : "-";
  console.log(
    `  ${message.role ?? entry.role ?? "?"} [${blocks}]${entry.type === "message" ? "" : ` ${entry.type}`}`,
  );
}

check("at least one compaction entry was written", compactions.length >= 1);
if (compactions.length === 0) {
  console.error("\nno compaction happened. The threshold may not have been reached.");
  process.exit(1);
}

const compaction = compactions.at(-1);
const summary = String(compaction.summary ?? "");
const details = compaction.details?.cliff;

check("summary starts with upstream's header", summary.startsWith(SUMMARY_HEADER));
const validHeadRecord =
  details !== undefined &&
  details !== null &&
  typeof details === "object" &&
  !Array.isArray(details) &&
  details.version === 1 &&
  Array.isArray(details.head) &&
  Object.keys(details).sort().join(",") === "head,version" &&
  details.head.every(
    (unit) =>
      unit !== null &&
      typeof unit === "object" &&
      (unit.kind === "human" || unit.kind === "system") &&
      typeof unit.text === "string",
  );
check(
  "details.cliff is a minimal durable head record",
  validHeadRecord,
  JSON.stringify(details ?? null).slice(0, 200),
);
check(
  "summary carries mechanical markers, not prose",
  /^\s*(user|assistant|thinking|result|system):/m.test(summary) || /\n\[.+?\] /m.test(summary),
);
check("summary does not contain a long tool result verbatim", !/.{600,}/.test(summary));

if (openingMarker !== undefined) {
  check(
    "the opening instruction survives inside the summary",
    summary.includes(openingMarker),
    openingMarker,
  );
}

const boundary = compaction.firstKeptEntryId;
check(
  "a kept boundary was recorded",
  typeof boundary === "string" && boundary.length > 0,
  String(boundary),
);
if (typeof boundary === "string") {
  check("the kept boundary exists on the branch", byId.has(boundary));
}

// The projected context is the summary followed by the contiguous kept suffix.
const boundaryIndex = byId.size > 0 ? entries.findIndex((entry) => entry.id === boundary) : -1;
const kept =
  boundaryIndex >= 0 ? entries.slice(boundaryIndex).filter((e) => e.type === "message") : [];
const keptRoles = kept.map((entry) => entry.message?.role ?? entry.role);
console.log(`\nprojected context: [summary] + ${keptRoles.join(",")}`);
check("the kept suffix is non-empty", kept.length > 0);
check("the kept suffix never starts at a tool result", keptRoles[0] !== "toolResult", keptRoles[0]);

console.log(`\nsummary text (${summary.length} chars):\n${summary.slice(0, 1200)}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nVERIFY_OK");
