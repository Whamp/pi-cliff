#!/usr/bin/env node
// Inspect a pi session JSONL produced by scripts/verify-live.sh and assert the
// extension's end-to-end behaviour. Exit code 0 means every check passed.
//
// Usage: node scripts/inspect-session.mjs <session.jsonl> [opening-marker] [followup-user-marker] [followup-answer]

import { readFileSync } from "node:fs";
import process from "node:process";

const SUMMARY_HEADER =
  "The following is a summary of your previous actions (long observations omitted):";

const file = process.argv[2];
const openingMarker = process.argv[3];
const followupUserMarker = process.argv[4];
const followupAnswer = process.argv[5];
if (!file) {
  console.error(
    "usage: node scripts/inspect-session.mjs <session.jsonl> [opening-marker] [followup-user-marker] [followup-answer]",
  );
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
const messageText = (entry) => {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
};
const messageBlocks = (entry) =>
  Array.isArray(entry.message?.content) ? entry.message.content : [];

const compactions = entries.filter((entry) => entry.type === "compaction");
const messages = entries.filter((entry) => entry.type === "message");
const byId = new Map(entries.map((entry) => [entry.id, entry]));
const bashCalls = messages.flatMap((entry) =>
  entry.message?.role === "assistant"
    ? messageBlocks(entry)
        .filter((block) => block?.type === "toolCall" && block.name === "bash")
        .map((call) => ({ call, entry }))
    : [],
);
const bashResults = messages.filter((entry) => entry.message?.role === "toolResult");
const resultIds = new Set(bashResults.map((entry) => entry.message?.toolCallId));
const callCommands = bashCalls.map((item) =>
  typeof item.call.arguments?.command === "string" ? item.call.arguments.command : "",
);
const requestedCommands = ["seq 1 500", "marker-odd", "echo done"].map((part) =>
  bashCalls.find(
    (item) =>
      typeof item.call.arguments?.command === "string" &&
      item.call.arguments.command.includes(part),
  ),
);

console.log(
  `entries=${entries.length} messages=${messages.length} compactions=${compactions.length} bashCalls=${bashCalls.length}`,
);
for (const entry of messages) {
  const message = entry.message ?? {};
  const blocks = Array.isArray(message.content)
    ? message.content.map((block) => block.type).join(",")
    : typeof message.content === "string"
      ? "string"
      : "-";
  console.log(`  ${message.role ?? entry.role ?? "?"} [${blocks}]`);
}

check("at least one compaction entry was written", compactions.length >= 1);
if (compactions.length === 0) {
  console.error("\nno compaction happened. The threshold may not have been reached.");
  process.exit(1);
}

const compaction = compactions.at(-1);
const summary = String(compaction.summary ?? "");
const details = compaction.details?.cliff;
const validHeadRecord =
  details !== undefined &&
  details !== null &&
  typeof details === "object" &&
  !Array.isArray(details) &&
  Object.hasOwn(details, "version") &&
  Object.hasOwn(details, "head") &&
  details.version === 1 &&
  Array.isArray(details.head) &&
  Object.keys(details).sort().join(",") === "head,version" &&
  details.head.every(
    (unit) =>
      unit !== null &&
      typeof unit === "object" &&
      Object.hasOwn(unit, "kind") &&
      Object.hasOwn(unit, "text") &&
      (unit.kind === "human" || unit.kind === "system") &&
      typeof unit.text === "string",
  );
check(
  "details.cliff is a minimal durable head record",
  validHeadRecord,
  JSON.stringify(details ?? null).slice(0, 200),
);
check("summary starts with upstream's header", summary.startsWith(SUMMARY_HEADER));
check(
  "summary carries mechanical markers, not prose",
  /^\s*(user|assistant|thinking|result|system):/m.test(summary) || /\n\[.+?\] /m.test(summary),
);
check("summary does not contain a long tool result verbatim", !/.{600,}/.test(summary));
if (openingMarker !== undefined) {
  check("the opening instruction survives inside the summary", summary.includes(openingMarker));
  check(
    "the original opening marker is in the persisted head",
    validHeadRecord && details.head.some((unit) => unit.text.includes(openingMarker)),
    openingMarker,
  );
}

check(
  "the model made three separate bash tool calls",
  bashCalls.length === 3,
  String(bashCalls.length),
);
check(
  "the requested command trio reached bash in separate calls",
  requestedCommands.every((item) => item !== undefined) &&
    new Set(requestedCommands.map((item) => item?.call.id)).size === requestedCommands.length,
  callCommands.join(" | ").slice(0, 500),
);
check(
  "each requested bash call has a persisted tool result",
  requestedCommands.every(
    (item) => item !== undefined && typeof item.call.id === "string" && resultIds.has(item.call.id),
  ),
);
const resultText = bashResults.map(messageText).join("\n");
check(
  "tool results contain the requested command outputs",
  /\b500\b/.test(resultText) && resultText.includes("marker-odd") && /\bdone\b/.test(resultText),
);

const boundary = compaction.firstKeptEntryId;
check(
  "a kept boundary was recorded",
  typeof boundary === "string" && boundary.length > 0,
  String(boundary),
);
const boundaryEntry = typeof boundary === "string" ? byId.get(boundary) : undefined;
check(
  "the kept boundary names a persisted user or assistant message",
  boundaryEntry?.type === "message" &&
    (boundaryEntry.message?.role === "user" || boundaryEntry.message?.role === "assistant"),
  String(boundaryEntry?.message?.role ?? boundaryEntry?.type ?? "missing"),
);
check(
  "Pi recorded a positive pre-compaction token count",
  typeof compaction.tokensBefore === "number" &&
    Number.isFinite(compaction.tokensBefore) &&
    compaction.tokensBefore > 0,
  String(compaction.tokensBefore),
);
const boundaryIndex =
  typeof boundary === "string" ? entries.findIndex((entry) => entry.id === boundary) : -1;
const kept =
  boundaryIndex >= 0
    ? entries.slice(boundaryIndex).filter((entry) => entry.type === "message")
    : [];
const keptRoles = kept.map((entry) => entry.message?.role ?? entry.role);
console.log(`\nprojected context: [summary] + ${keptRoles.join(",")}`);
check("the kept suffix is non-empty", kept.length > 0);
check("the kept suffix never starts at a tool result", keptRoles[0] !== "toolResult", keptRoles[0]);

if (followupUserMarker !== undefined && followupAnswer !== undefined) {
  const followupIndex = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry).includes(followupUserMarker),
  );
  const followupEntry = followupIndex >= 0 ? entries[followupIndex] : undefined;
  const followupText = followupEntry === undefined ? "" : messageText(followupEntry);
  check(
    "a distinct follow-up request occurs after compaction without restating the head marker",
    followupIndex >= 0 &&
      compactions.some((entry) => entries.indexOf(entry) < followupIndex) &&
      (openingMarker === undefined || !followupText.includes(openingMarker)),
    followupText.slice(0, 300),
  );
  const answers =
    followupIndex < 0
      ? []
      : entries
          .slice(followupIndex + 1)
          .filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
  const answerText = answers.map(messageText).join("\n");
  check(
    "the assistant retrieves the opening marker in its follow-up answer",
    answerText.includes(followupAnswer),
    answerText.slice(-500),
  );
  const followupToolCalls =
    followupIndex < 0
      ? []
      : entries
          .slice(followupIndex + 1)
          .filter((entry) => entry.type === "message")
          .flatMap((entry) => messageBlocks(entry).filter((block) => block?.type === "toolCall"));
  check("the retrieval follow-up needed no tool calls", followupToolCalls.length === 0);
}

console.log(`\nsummary text (${summary.length} chars):\n${summary.slice(0, 1200)}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nVERIFY_OK");
