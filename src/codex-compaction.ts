import { randomUUID } from "node:crypto";
import {
  convertToLlm,
  getLatestCompactionEntry,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import type { CliffExtensionAPI } from "./extension.js";
import type { PiAgentMessage } from "./pi-units.js";

interface CodexNativeItem {
  type: "compaction";
  encrypted_content: string;
}

interface CodexUserItem {
  role: "user";
  content: unknown;
}

interface CodexCheckpoint {
  version: 1;
  provider: "openai-codex";
  model: string;
  item: CodexNativeItem;
  users: CodexUserItem[];
}

interface CodexRequest {
  input: unknown[];
  client_metadata?: unknown;
}

interface PreparedCheckpoint {
  checkpoint: CodexCheckpoint;
  summaryText: string;
}

/** Session metadata containing the native item and its bounded retained user messages. */
export const CODEX_CHECKPOINT_KEY = "cliffCodexCheckpoint";

type CompactionUsage = NonNullable<NonNullable<SessionBeforeCompactResult["compaction"]>["usage"]>;
const RETAINED_USER_BYTES = 64_000;
const COMPACTION_METADATA = JSON.stringify({
  request_kind: "compaction",
  compaction: {
    trigger: "manual",
    reason: "user_requested",
    implementation: "responses_compaction_v2",
    phase: "standalone_turn",
    strategy: "memento",
  },
});

/** Registers native checkpoint replay without changing ordinary message serialization. */
export function createCodexCompaction(pi: CliffExtensionAPI) {
  let prepared: PreparedCheckpoint | undefined;

  pi.on("context_with_system", (event, ctx) =>
    guardCodexReplay(ctx, () => {
      prepared = undefined;
      const checkpoint = readCodexCheckpoint(ctx);
      if (checkpoint === undefined) return;
      requireCheckpointModel(checkpoint, ctx);
      const marker = `Cliff native checkpoint ${randomUUID()}`;
      let summaries = 0;
      const messages = event.messages.map((message) => {
        if (message.role !== "compactionSummary") return message;
        summaries += 1;
        const replacement = { ...message, summary: marker };
        const converted = convertToLlm([replacement])[0];
        if (converted?.role !== "user") {
          throw new Error("Cliff Codex checkpoint could not identify its summary message");
        }
        const content = converted.content;
        const summaryText =
          typeof content === "string"
            ? content
            : content.length === 1 && content[0]?.type === "text"
              ? content[0].text
              : undefined;
        if (summaryText === undefined) {
          throw new Error("Cliff Codex checkpoint summary has unsupported content blocks");
        }
        prepared = { checkpoint, summaryText };
        return replacement;
      });
      if (summaries !== 1) {
        throw new Error("Cliff Codex checkpoint requires exactly one active compaction summary");
      }
      return { messages };
    }),
  );

  pi.on("before_provider_request", (event, ctx) =>
    guardCodexReplay(ctx, () => {
      const checkpoint = readCodexCheckpoint(ctx);
      if (checkpoint === undefined) return;
      requireCheckpointModel(checkpoint, ctx);
      if (
        prepared === undefined ||
        prepared.checkpoint.item.encrypted_content !== checkpoint.item.encrypted_content
      ) {
        throw new Error("Cliff Codex checkpoint was not prepared for this request");
      }
      const request = readCodexRequest(event.payload);
      const summaryText = prepared.summaryText;
      let replacements = 0;
      const input = request.input.flatMap((item) => {
        if (!isSummaryItem(item, summaryText)) return [item];
        replacements += 1;
        return [...checkpoint.users, checkpoint.item];
      });
      if (replacements !== 1) {
        throw new Error("Cliff Codex checkpoint summary was changed or removed before replay");
      }
      return { ...request, input };
    }),
  );

  return (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    result: SessionBeforeCompactResult | undefined,
  ): SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult> => {
    const previous = readCodexCheckpoint(ctx);
    if (previous !== undefined) {
      requireCheckpointModel(previous, ctx);
      if (result === undefined) {
        throw new Error(
          "Cliff Codex checkpoint requires active mode; text-only compaction was cancelled",
        );
      }
    }
    const compaction = result?.compaction;
    if (compaction === undefined || !supportsCodexCompaction(ctx)) return result;
    return requestCodexCheckpoint(event, ctx, previous).then(({ checkpoint, usage }) => ({
      compaction: {
        ...compaction,
        summary: checkpointSummary(checkpoint),
        usage,
        details: {
          ...(isObject(compaction.details) ? compaction.details : {}),
          [CODEX_CHECKPOINT_KEY]: checkpoint,
        },
      },
    }));
  };
}

function supportsCodexCompaction(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

function guardCodexReplay<T>(ctx: ExtensionContext, action: () => T): T {
  try {
    return action();
  } catch (error) {
    // Pi reports hook exceptions and continues, so throwing alone would discard the checkpoint.
    ctx.abort();
    throw error;
  }
}

function requireCheckpointModel(checkpoint: CodexCheckpoint, ctx: ExtensionContext): void {
  if (!supportsCodexCompaction(ctx) || ctx.model?.id !== checkpoint.model) {
    throw new Error(
      "Cliff Codex checkpoint belongs to a different model; switch back before continuing",
    );
  }
}

function readCodexCheckpoint(ctx: ExtensionContext): CodexCheckpoint | undefined {
  const details = getLatestCompactionEntry(ctx.sessionManager.getBranch())?.details;
  if (!isObject(details) || !Object.hasOwn(details, CODEX_CHECKPOINT_KEY)) return undefined;
  const value = details[CODEX_CHECKPOINT_KEY];
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.provider !== "openai-codex" ||
    typeof value.model !== "string" ||
    !isNativeItem(value.item) ||
    !Array.isArray(value.users) ||
    !value.users.every(isUserItem)
  ) {
    throw new Error("Cliff Codex checkpoint is invalid; refusing text-only continuation");
  }
  return {
    version: 1,
    provider: "openai-codex",
    model: value.model,
    item: value.item,
    users: value.users,
  };
}

async function requestCodexCheckpoint(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  previous: CodexCheckpoint | undefined,
): Promise<{ checkpoint: CodexCheckpoint; usage: CompactionUsage }> {
  const model = ctx.model;
  if (
    model === undefined ||
    !supportsCodexCompaction(ctx) ||
    model.baseUrl !== "https://chatgpt.com/backend-api"
  ) {
    throw new Error("Cliff Codex compaction requires the configured ChatGPT subscription endpoint");
  }
  const signal = AbortSignal.any([event.signal, AbortSignal.timeout(120_000)]);
  const messages: PiAgentMessage[] = [
    ...event.preparation.messagesToSummarize,
    ...event.preparation.turnPrefixMessages,
  ].filter((message) => message.role !== "compactionSummary");
  if (previous === undefined && event.preparation.previousSummary) {
    messages.unshift({
      role: "user",
      content: event.preparation.previousSummary,
      timestamp: Date.now(),
    });
  }
  let retainedUsers: CodexUserItem[] | undefined;
  let nativeItem: CodexNativeItem | undefined;
  const requestFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://chatgpt.com/backend-api/codex/responses") {
      throw new Error("Cliff Codex compaction refused a different provider endpoint");
    }
    const response = await fetch(input, { ...init, redirect: "error" });
    if (!response.ok)
      throw new Error(`Cliff Codex compaction request failed with HTTP ${response.status}`);
    nativeItem = readCompactionResponse(await response.clone().text());
    return response;
  };
  const stream = ctx.modelRegistry.streamSimple(
    model,
    {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(messages),
    },
    {
      signal,
      transport: "sse",
      maxRetries: 0,
      timeoutMs: 120_000,
      fetch: requestFetch,
      headers: {
        "x-codex-beta-features": "remote_compaction_v2",
        "x-codex-turn-metadata": COMPACTION_METADATA,
      },
      onPayload(payload) {
        const request = readCodexRequest(payload);
        const input =
          previous === undefined
            ? request.input
            : [...previous.users, previous.item, ...request.input];
        retainedUsers = retainCodexUsers(input);
        return {
          ...request,
          input: [...input, { type: "compaction_trigger" }],
          client_metadata: {
            ...(isObject(request.client_metadata) ? request.client_metadata : {}),
            "x-codex-turn-metadata": COMPACTION_METADATA,
          },
        };
      },
    },
  );
  const response = await stream.result();
  if (
    signal.aborted ||
    response.stopReason !== "stop" ||
    nativeItem === undefined ||
    retainedUsers === undefined
  ) {
    throw new Error(
      "Cliff Codex compaction did not return a completed native checkpoint; history was not compacted",
    );
  }
  return {
    checkpoint: {
      version: 1,
      provider: "openai-codex",
      model: model.id,
      item: nativeItem,
      users: retainedUsers,
    },
    usage: response.usage,
  };
}

function readCompactionResponse(text: string): CodexNativeItem {
  const items: unknown[] = [];
  let completed = false;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") continue;
    const event: unknown = JSON.parse(data);
    if (!isObject(event)) continue;
    if (event.type === "response.output_item.done") items.push(event.item);
    if (event.type === "response.completed" || event.type === "response.done") {
      completed = isObject(event.response) && event.response.status === "completed";
    }
  }
  const item = items[0];
  if (!completed || items.length !== 1 || !isNativeItem(item)) {
    throw new Error(
      "Cliff Codex compaction response did not contain exactly one completed native checkpoint",
    );
  }
  return item;
}

function retainCodexUsers(input: unknown[]): CodexUserItem[] {
  const retained: CodexUserItem[] = [];
  let bytes = 0;
  for (const item of input.filter(isUserItem).reverse()) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + size > RETAINED_USER_BYTES) continue;
    retained.unshift(item);
    bytes += size;
  }
  return retained;
}

function checkpointSummary(checkpoint: CodexCheckpoint): string {
  return [
    "Provider-native Codex checkpoint. Retained user context follows.",
    ...checkpoint.users.map((item) => JSON.stringify(item)),
  ].join("\n");
}

function readCodexRequest(value: unknown): CodexRequest {
  if (!isObject(value) || !Array.isArray(value.input)) {
    throw new Error("Cliff Codex request has no provider input array");
  }
  return { ...value, input: value.input };
}

function isSummaryItem(value: unknown, text: string): boolean {
  if (!isUserItem(value) || !Array.isArray(value.content) || value.content.length !== 1)
    return false;
  const block: unknown = value.content[0];
  return isObject(block) && block.type === "input_text" && block.text === text;
}

function isNativeItem(value: unknown): value is CodexNativeItem {
  return (
    isObject(value) &&
    Object.hasOwn(value, "type") &&
    value.type === "compaction" &&
    Object.hasOwn(value, "encrypted_content") &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

function isUserItem(value: unknown): value is CodexUserItem {
  return isObject(value) && value.role === "user" && Object.hasOwn(value, "content");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
