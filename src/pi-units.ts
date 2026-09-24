/**
 * Projects pi's messages onto Cliff's content classes.
 *
 * This is the only module in the port that names a pi type. `cliff.ts` never sees one, which is what
 * keeps the render table reviewable against upstream without a pi harness, and it is why the
 * conversion lives here rather than making `AgentMessage` the domain type.
 *
 * Every text rule below folds the text pi showed the model. Ordinary content retains its existing
 * block-sensitive projection; Pi's `convertToLlm` is reused narrowly for bash and branch summaries,
 * which have no upstream role and must match Pi's user-text formatting exactly.
 */

import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { CliffJsonValue, SummaryUnit, ToolSignature } from "./cliff.js";

/**
 * pi's agent message union: the four provider roles plus the coding agent's custom roles.
 *
 * Derived from the public `convertToLlm` signature because pi does not re-export `AgentMessage` from
 * its package entry, and its own declaration of that type arrives through the module augmentation in
 * `core/messages.ts`.
 */
export type PiAgentMessage = Parameters<typeof convertToLlm>[0][number];

/** Thrown when a message has no content class, which cancels compaction rather than guessing. */
export class CliffMessageMappingError extends Error {
  override readonly name = "CliffMessageMappingError";
}

type PiUserMessage = Extract<PiAgentMessage, { role: "user" }>;
type PiAssistantMessage = Extract<PiAgentMessage, { role: "assistant" }>;
type PiToolResultMessage = Extract<PiAgentMessage, { role: "toolResult" }>;
type PiSystemMessage = Extract<PiAgentMessage, { role: "system" }>;
type PiBashExecutionMessage = Extract<PiAgentMessage, { role: "bashExecution" }>;
type PiBranchSummaryMessage = Extract<PiAgentMessage, { role: "branchSummary" }>;

/** The block types of a pi content array. Content that is only a string yields `never`. */
type PiBlocksOf<TContent> = TContent extends readonly (infer TBlock)[] ? TBlock : never;

/** Text and image blocks, the two kinds a user-role message, a custom message, or a tool result can
 * hold. pi types all three the same way. */
type PiUserBlock = PiBlocksOf<PiUserMessage["content"]>;
/** Text, thinking, and tool-call blocks, the three kinds an assistant message can hold. */
type PiAssistantBlock = PiBlocksOf<PiAssistantMessage["content"]>;
type PiToolCallBlock = Extract<PiAssistantBlock, { type: "toolCall" }>;

/**
 * Turns the messages pi is about to compact into the units the render table consumes.
 *
 * One message becomes at least one unit, and messages are never merged: an assistant message is one
 * `assistant` unit however many blocks it holds, while a user message contributes one `human` unit per
 * text block, because upstream caps each of those on its own and joins the assistant's before one cap.
 * Nothing is filtered here. Whether text survives is the render rule's decision, so the drop tallies
 * describe one set of rules rather than two.
 */
export function toSummaryUnits(messages: readonly PiAgentMessage[]): SummaryUnit[] {
  const units: SummaryUnit[] = [];
  for (const message of messages) {
    units.push(...unitsForMessage(message));
  }
  return units;
}

/** The content classes one pi message becomes, one case per role pi can put in the array. */
function unitsForMessage(message: PiAgentMessage): SummaryUnit[] {
  switch (message.role) {
    case "user":
      return humanUnits(message.content);
    case "assistant":
      return assistantUnits(message.content);
    case "toolResult":
      return resultUnits(message);
    case "system":
      return [{ kind: "system", text: systemText(message) }];
    case "bashExecution":
      return piCustomTextUnits(message);
    case "custom":
      // An extension-injected message. pi gives it the same content shape as a user message and sends
      // it to the model the same way, so it folds the same way.
      return humanUnits(message.content);
    case "branchSummary":
      return piCustomTextUnits(message);
    case "compactionSummary":
      // A summary an earlier cycle wrote. Upstream drops it rather than merging summaries forward, and
      // `preparation.previousSummary` is never read as content either.
      return [{ kind: "omitted", reason: "previousSummary" }];
    default: {
      const unmappable: never = message;
      throw new CliffMessageMappingError(
        `Cliff cannot project a pi message onto a content class: ${String(unmappable)}`,
      );
    }
  }
}

/** One `human` unit per text block, with images counted, as upstream folds a user message. */
function humanUnits(content: string | PiUserBlock[]): SummaryUnit[] {
  if (!Array.isArray(content)) {
    return [{ kind: "human", text: content }];
  }
  const units: SummaryUnit[] = [];
  for (const block of content) {
    if (block.type === "text") {
      units.push({ kind: "human", text: block.text });
    } else {
      units.push({ kind: "omitted", reason: "image" });
    }
  }
  return units;
}

/**
 * One `assistant` unit for the message, plus the omissions its blocks produced.
 *
 * The group is what lets the render rule join thinking, text, and tool signatures into the single part
 * upstream writes, in that order. Omitted units carry no text, so emitting them after the group cannot
 * change the rendered bytes.
 */
function assistantUnits(content: readonly PiAssistantBlock[]): SummaryUnit[] {
  const thoughts: string[] = [];
  const thinking: string[] = [];
  const calls: ToolSignature[] = [];
  const omissions: SummaryUnit[] = [];
  for (const block of content) {
    if (block.type === "text") {
      thoughts.push(block.text);
    } else if (block.type === "toolCall") {
      calls.push(toolSignature(block));
    } else if (block.redacted) {
      // An encrypted thinking block holds no foldable text, and its payload is not for the summary.
      omissions.push({ kind: "omitted", reason: "redactedThinking" });
    } else {
      thinking.push(block.thinking);
    }
  }
  return [{ kind: "assistant", thoughts, thinking, calls }, ...omissions];
}

/**
 * Names a call the way upstream's wire does.
 *
 * pi carries an OpenAI Responses namespace separately from the tool name; upstream's `tool_use` block
 * has one name field, and the fixture format flattens `namespace.name` the same way, so both sides
 * write the signature identically.
 */
function toolSignature(call: PiToolCallBlock): ToolSignature {
  const name = call.namespace === undefined ? call.name : `${call.namespace}.${call.name}`;
  return { name, args: call.arguments satisfies CliffJsonValue };
}

/** One `result` unit per tool result, with its text blocks folded into one observation. */
function resultUnits(message: PiToolResultMessage): SummaryUnit[] {
  const texts: string[] = [];
  const omissions: SummaryUnit[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      texts.push(block.text);
    } else {
      omissions.push({ kind: "omitted", reason: "image" });
    }
  }
  // Upstream `_result_text` joins an observation's text parts with newlines, because a tool result is
  // one thing the model saw rather than a list of results.
  return [{ kind: "result", text: texts.join("\n") }, ...omissions];
}

/**
 * Reads a system message as an instruction.
 *
 * Only `content` is folded. `sections` holds the standing prompt pi re-sends on every request, the
 * thing the summary is not supposed to restate, so it is left out rather than summarised.
 */
function systemText(message: PiSystemMessage): string {
  if (!Array.isArray(message.content)) {
    return message.content;
  }
  return message.content.map((block) => block.text).join("\n");
}

/** Converts Pi-only text roles using the exact user text Pi sends to the model. */
function piCustomTextUnits(
  message: PiBashExecutionMessage | PiBranchSummaryMessage,
): SummaryUnit[] {
  const converted = convertToLlm([message]);
  const projected = converted[0];
  if (projected === undefined) {
    if (message.role === "bashExecution" && message.excludeFromContext) {
      return [{ kind: "omitted", reason: "excludedFromContext" }];
    }
    throw new CliffMessageMappingError(
      "Cliff Pi conversion omitted a bash or branch summary that belongs in context",
    );
  }
  if (projected.role !== "user") {
    throw new CliffMessageMappingError(
      `Cliff Pi conversion returned role ${projected.role} for a user-context message`,
    );
  }
  return humanUnits(projected.content);
}
