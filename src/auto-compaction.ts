import {
  estimateTokens,
  SessionManager,
  type ProjectedSessionEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { SummaryUnit } from "./cliff.js";
import type { CliffConfig } from "./config.js";
import type { PiAgentMessage } from "./pi-units.js";

type CliffHeadUnit = Extract<SummaryUnit, { kind: "human" | "system" }>;
type AutoTrigger = "completed-step" | "native-threshold" | "native-overflow";

interface CliffAutoSnapshot {
  cwd: string;
  header: SessionHeader | null;
  branch: SessionEntry[];
  entries: readonly ProjectedSessionEntry[];
  messages: readonly PiAgentMessage[];
  model: { contextWindow: number; maxTokens: number } | undefined;
  signal: AbortSignal | undefined;
}

type CliffAutoRenderer = (
  messages: readonly PiAgentMessage[],
  branch: SessionEntry[],
  config: CliffConfig,
  reason: "threshold" | "overflow",
  signal?: AbortSignal,
) => { ok: true; summary: string; head: readonly CliffHeadUnit[] } | { ok: false; message: string };

type CliffAutoDecision =
  | { kind: "keep"; reason: "below-budget" | "no-older-step" | "protected-tail" }
  | { kind: "deny"; reason: string }
  | {
      kind: "compact";
      firstKeptEntryId: string;
      summary: string;
      head: readonly CliffHeadUnit[];
      beforeTokens: number;
      afterTokens: number;
    };

interface CliffAutoCut {
  firstKeptEntryId: string;
  summarized: PiAgentMessage[];
}

function selectCliffAutoCut(
  snapshot: CliffAutoSnapshot,
  keepRecentTurns: number,
): CliffAutoCut | undefined {
  const recentCompaction = snapshot.entries.findLastIndex(
    (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
  );
  const live = snapshot.entries.slice(recentCompaction + 1);
  const assistants = live.flatMap((entry, index) =>
    entry.messages.some((message) => message.role === "assistant") ? [index] : [],
  );
  if (assistants.length <= keepRecentTurns) {
    return undefined;
  }
  const firstKeptIndex = assistants[assistants.length - keepRecentTurns];
  const firstKept = firstKeptIndex === undefined ? undefined : live[firstKeptIndex];
  if (
    firstKept === undefined ||
    firstKept.sourceEntry.type !== "message" ||
    firstKept.sourceEntry.message.role !== "assistant" ||
    !snapshot.branch.some((entry) => entry.id === firstKept.sourceEntry.id)
  ) {
    return undefined;
  }
  const summarized = live
    .slice(0, firstKeptIndex)
    .flatMap((entry) => entry.messages)
    .filter((message) => message.role !== "system");
  if (!summarized.some((message) => message.role === "assistant")) {
    return undefined;
  }
  return { firstKeptEntryId: firstKept.sourceEntry.id, summarized };
}

/** Chooses one reducing native Pi compaction without consulting Pi's retained-token cut. The completed-step trigger measures the compressible middle only: the system/tools head and the retained tail never spend the working budget. */
export function planCliffAutoCompaction(
  snapshot: CliffAutoSnapshot,
  config: CliffConfig,
  trigger: AutoTrigger,
  render: CliffAutoRenderer,
): CliffAutoDecision {
  if (!snapshot.messages.some((message) => message.role === "system")) {
    return {
      kind: "deny",
      reason: "the current system prompt and tool declarations are unavailable",
    };
  }
  if (snapshot.header === null) {
    return { kind: "deny", reason: "the current session has no header" };
  }
  const protectedCut = selectCliffAutoCut(snapshot, config.keepRecentTurns);
  if (protectedCut === undefined) {
    return { kind: "keep", reason: "no-older-step" };
  }
  const workingTokens = protectedCut.summarized.reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
  if (trigger === "completed-step" && workingTokens <= config.workingTokens) {
    return { kind: "keep", reason: "below-budget" };
  }
  const beforeTokens = snapshot.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const modelLimit =
    snapshot.model === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, snapshot.model.contextWindow - snapshot.model.maxTokens);
  const keepCounts = config.keepRecentTurns === 1 ? [1] : [config.keepRecentTurns, 1];
  for (const keepRecentTurns of keepCounts) {
    const cut =
      keepRecentTurns === config.keepRecentTurns
        ? protectedCut
        : selectCliffAutoCut(snapshot, keepRecentTurns);
    if (cut === undefined) {
      continue;
    }
    const rendered = render(
      cut.summarized,
      snapshot.branch,
      config,
      trigger === "native-overflow" ? "overflow" : "threshold",
      snapshot.signal,
    );
    if (!rendered.ok) {
      return { kind: "deny", reason: rendered.message };
    }
    const preview = SessionManager.inMemory(snapshot.cwd, undefined, [
      snapshot.header,
      ...snapshot.branch,
    ]);
    preview.appendCompaction(rendered.summary, cut.firstKeptEntryId, beforeTokens, undefined, true);
    const previewMessages = preview.buildSessionProjection().messages;
    if (!previewMessages.some((message) => message.role === "system")) {
      return { kind: "deny", reason: "the preview lost the system prompt and tool declarations" };
    }
    const afterTokens = previewMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
    if (afterTokens <= modelLimit) {
      if (afterTokens >= beforeTokens) {
        if (keepRecentTurns === config.keepRecentTurns) {
          return { kind: "keep", reason: "protected-tail" };
        }
        continue;
      }
      return {
        kind: "compact",
        firstKeptEntryId: cut.firstKeptEntryId,
        summary: rendered.summary,
        head: rendered.head,
        beforeTokens,
        afterTokens,
      };
    }
  }
  return { kind: "deny", reason: "no assistant-step cut reduces the estimated input enough" };
}
