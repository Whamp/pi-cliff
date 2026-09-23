# Design

A pi extension that ports [CliffCompaction](https://github.com/nguyenvuthientrang/cliffcompaction) (MIT, © Trang Nguyen, upstream revision `b48d660`) into pi's compaction subsystem.

This document is the contract for the implementation. It records what carries over, what pi cannot express, and what the port deliberately refuses to do.

## Problem

Upstream is a transparent HTTP proxy. It rewrites the outgoing message array of every request so a coding agent stays under a token budget, and it does the work with no model call. The summary is mechanical, built by content class.

pi already has the half of that product an agent needs from the inside. It decides when context is too big, it picks where to cut, it persists the result, and it rebuilds the model context. `session_before_compact` lets an extension replace the summary text and skip pi's model call entirely.

What does not carry over is the reason upstream looks the way it does. The proxy is stateless and its client resends the full original history on every request, so upstream needs a hash-chain store to recognise a prefix it already compacted, a chars/4 estimator because it cannot see real token counts, a cut rule based on counting assistant turns, and a per-dialect wire parser. pi hands us typed messages, real token accounting, a persisted projection, and its own cut. Rebuilding those parts here would duplicate host behaviour and fight the host that owns it.

The shape problem is pi's single summary slot. `buildContextEntries` in `session-manager.js:201-228` projects the newest compaction entry plus one contiguous suffix, and it drops system messages inside the retained range. So the compacted context can be `[summary] + [contiguous tail]`. It cannot be `[head] + [summary] + [tail]`, which is what upstream forwards.

## Usage

```bash
pi install /home/will/projects/pi-cliff
```

Reload pi. Cliff now owns the summary for every compaction: `/compact`, the automatic threshold, and overflow recovery. No proxy, no daemon, no base-URL change, no model call.

Config is optional. Upstream's defaults apply when nothing is present.

```jsonc
// ~/.pi/agent/cliff.json, and <cwd>/.pi/cliff.json for a per-project override
{
  "mode": "active",
  "keepThinking": true,
  "thoughtMaxChars": 0,
  "thinkingMaxChars": 0,
  "cmdMaxChars": 150,
  "resultMaxChars": 500,
  "humanMaxChars": 20000
}
```

`0` means unlimited for a `*MaxChars` cap. `resultMaxChars: 0` means no non-empty tool result survives, which is upstream's meaning and not a typo. Unknown keys, wrong types, negative values, and non-integer caps are errors. Bad config cancels compaction and says so. It never quietly falls back to a model summary.

pi still owns when compaction happens. Set `compaction.reserveTokens` in pi's own settings. Upstream's `--threshold T` on a window of `W` corresponds to `reserveTokens = W - T`, approximately, because pi counts tokens and the proxy estimated chars divided by four.

There is no `keepRecent` option. Upstream keeps three recent assistant turns; pi keeps a token budget of recent context. pi owns that decision, and the port does not override it.

After a compaction, a notification reports the shape of what happened:

```
Cliff: mechanical summary · 18 messages · 7 long results dropped · 4812 chars
```

`/cliff` prints the resolved config and its file sources, the last committed outcome for the current branch, what was dropped, and any degradation. It reads committed session state, so it still answers after a resume or a branch switch.

`/compact focus on tests` asks for something a mechanical summariser cannot do. Cliff compacts anyway with the normal rules and reports that the instructions were ignored. The primary intent was to compact.

## Shape

Three modules. `cliff.ts` imports nothing from pi and touches no filesystem. `pi-units.ts` is the only module that knows pi's message types. `extension.ts` is the only module that touches config files, hooks, session entries, and UI.

```
pi messages  →  pi-units.ts  →  SummaryUnit[]  →  cliff.ts  →  summary text + stats
                                                              extension.ts → pi compaction
```

### The data shape

Upstream's README is a table of content classes and how each is treated. The domain model encodes that table instead of re-deriving it from role checks.

```ts
type SummaryUnit =
  | { kind: "assistant"; thoughts: string[]; thinking: string[]; calls: ToolSignature[] }
  | { kind: "human"; text: string }
  | { kind: "system"; text: string }
  | { kind: "result"; text: string }
  | { kind: "omitted"; reason: OmitReason };
```

One assistant message is one `assistant` unit, not three. Upstream aggregates an assistant message's thinking, text, and tool signatures into a single part in that fixed order, so the unit that represents it has to be a group. Blocks from separate messages never merge.

The organising structure is a render table keyed by `kind`, with one rule per member:

```ts
const RENDER_RULES: { [K in SummaryUnit["kind"]]: Rule<Extract<SummaryUnit, { kind: K }>> };
```

The table is closed, not a plugin registry. Adding a pi-only content class means adding one union member and one rule, and the compiler finds every site. A reviewer can hold this table next to upstream's `_summarize_assistant` and `_summarize_user` and check the rules line by line. That review is the point of the structure.

### Faithfulness rules that the code must keep

| Upstream behaviour | How it is kept here |
| --- | --- |
| Tool result kept verbatim only if short enough, otherwise dropped whole | `result` rule, `resultMaxChars`, empty results dropped |
| Tool call becomes one line `[name] {args}` with the arguments as canonical JSON | `assistant` rule, `cmdMaxChars`, `canonicalJson()` |
| Assistant text and thinking kept in full by default, each independently capped | `thoughtMaxChars`, `thinkingMaxChars` |
| Thinking droppable entirely | `keepThinking: false` |
| Human text verbatim, capped | `humanMaxChars`, after stripping `<task-notification>` blocks |
| Human text blocks stay separate, each capped on its own; assistant text blocks join before one cap | one `human` unit per text block, one `assistant` unit per message |
| In-array system directives fold as instructions, empty ones vanish | `system` rule |
| Images, documents, redacted thinking contribute nothing | `omitted` unit with a counted reason |
| A previous summary is dropped, never merged forward | `compactionSummary` becomes an `omitted` unit; `preparation.previousSummary` is never read as content |
| Parts join with `\n\n---\n\n`; no parts means header only; header byte-exact | kept byte-exact inside pi's own `<summary>` wrapper |
| Caps count characters | code points, not UTF-16 units. Python `len()` counts code points, so `String.prototype.length` and `slice()` are wrong for astral text and must not be used for caps |
| Canonical JSON: sorted keys, `,`/`:` separators, unescaped non-ASCII | a port of `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`, with number formatting pinned by fixtures rather than assumed from `JSON.stringify` |
| Kept messages are never rebuilt | the kept suffix is pi's, untouched; the port only produces text |
| Fail-open: a failure changes nothing | `{ cancel: true }`, see below |
| `keep_recent` turns and a threshold trigger | not ported. pi owns both. See *What pi cannot give* |

### The head

Upstream keeps everything before the first assistant message verbatim, forever, outside the compacted region. In pi the opening user message falls inside `messagesToSummarize`, and a second compaction starts at the previous kept boundary, so the original task would decay out of the summary after two cycles. Upstream never loses it.

So the head section is carried in our own `details`. On the first compaction, the leading `human` and `system` units up to the first assistant message are recorded as `details.cliff.head` and rendered at the front of the summary. On each later compaction, the recorded head is re-emitted at the front before the new parts. It is rendered by the same human rules, so there is one code path and one set of caps.

Head decay and action-summary decay stay separate. The action parts still drop the previous summary, which is upstream's rule. Only the head section persists, because it is what upstream keeps verbatim.

Head text is not summarised, so it is not trimmed and not stripped of `<task-notification>` blocks. It does get the `humanMaxChars` bound. Upstream has no bound there, because the head is a message it forwards rather than text it renders, and an opening prompt is usually small. An uncapped head section would let one giant first paste become permanent, uncompactable context that grows the prompt forever. A 20000 character bound on the opening task is a documented deviation from upstream, not an oversight.

Loss that remains: head message roles, message boundaries, and head images. Text survives; structure does not. A task stated only as an image in the opening message is lost, and that case is counted and reported rather than described as preserved.

A compaction we did not produce (a `session_compact` with `fromExtension: false`, or details from another version) means no recoverable head. The port does not go looking for the original opening message behind a foreign summary.

### Escalation

Upstream walks a ladder when the outgoing request stays over budget: `keep_recent=1`, then drop thinking and cap assistant text at 300, then truncate the summary newest-part-first, and in strict mode refuse the request.

The cut half of that ladder is not portable and the budget half is. `keep_recent` changes the cut, and the cut is pi's, so that rung is dropped. The content reductions are pi-agnostic and are kept.

On `manual` and `threshold`, the configured rules apply unchanged.

On `overflow`:

1. `keepThinking: false`, and an effective thought cap of `cfg === 0 ? 300 : min(cfg, 300)`.
2. If the summary is still over budget, evict action parts from the oldest end, keeping whole parts, stopping at the first part that does not fit. Never skip a non-fitting part to reach an older small one. If nothing fits, the result is the header alone. The head section is never evicted and the kept tail is never touched.

Step 2 needs a budget, and a budget needs the cost of everything the hook does not hand over: the system prompt and the tool schemas. Derive it instead of inventing it. The most recent assistant message carries real `usage.input_tokens` for the context that was actually sent. Subtract the estimator's own figure for the current messages from that number and the remainder is the unmodelled overhead, measured rather than guessed.

```
overhead  = lastUsage.input_tokens - estimateTokens(currentMessages)   // floor at 0
budget    = contextWindow - reserveTokens - overhead - estimateTokens(keptSuffix) - summaryOverhead
```

Read `usage` from the most recent assistant message in the preparation. Do not use `ctx.getContextUsage()`. A probe measured it returning `tokens: null` on a session that had assistant messages, so it cannot be the anchor.

One estimator is used everywhere, the host's own chars/4 rule, because upstream's invariant is that every size decision goes through one function. When there is no assistant usage to anchor on, step 2 is skipped and the step-1 summary is committed as is.

There is no strict mode. Refusing to compact is not something an extension can do to a provider.

### Failure

On any internal failure, the handler returns `{ cancel: true }` with a diagnostic. That includes unreadable or invalid config, an unmappable message, a canonicalisation throw, and an aborted signal.

`{ cancel: true }` is the faithful mapping of upstream's verbatim passthrough. Nothing changes about the context. What it does not do is make an over-budget request succeed, and upstream makes the same trade: it forwards the oversized request and lets the provider reject it rather than silently rewriting history. Returning `undefined` would hand the compaction to pi's model summariser, which is a bigger, costlier, irreversible action taken precisely when something is already wrong.

`mode: "off"` is the deliberate way to give ownership back to pi. It is the only path that returns `undefined`.

`mode: "shadow"` computes the summary, reports what it would have committed, and then returns `undefined`, which lets pi run its own compaction. Upstream's shadow means "the forwarded bytes are byte-identical to a world without Cliff", and the equivalent here is that pi's ordinary behaviour is untouched. Cancelling in shadow would be the opposite of shadow: it would remove the safety net, let the session grow until the provider rejects it, and destroy the comparison shadow exists to provide. Shadow mode is the trial mode. It answers "what would Cliff have written, next to what pi actually wrote", on the same trigger and the same cut, with nothing at stake. The no-model guarantee describes `active` mode, and the README says so.

### Configuration and observation

Files, not pi settings keys. pi's settings schema is not ours to extend, and `ExtensionContext` exposes no settings accessor. Precedence is defaults, then `~/.pi/agent/cliff.json`, then `<cwd>/.pi/cliff.json`. No environment variables, because they were how a shell-launched proxy received flags.

Durable reporting lives in the compaction entry's `details.cliff`, versioned: profile, reason, counts, drop tallies, boundary id, head size. `/cliff` reads it back from the current branch. Shadow and cancelled outcomes are recorded with `pi.appendEntry("cliff.outcome", …)`, best effort, with no transcript text, so `/cliff` can answer "what would it have done" after the fact. Success reporting reads the committed entry from `session_compact`, never a cached candidate.

Diagnostics in non-TUI modes go through `ctx.ui.notify` where available and stderr otherwise. Nothing in this extension requires a terminal.

### Scope boundary

`session_before_tree` is untouched. Branch summarisation is a separate, user-chosen pi behaviour and may use a model. The no-model promise covers `/compact`, threshold compaction, and overflow recovery. The README says so.

Registering `session_compact_failed` is reporting only. It never retries, escalates, or writes a success receipt.

## What pi cannot give

| Upstream guarantee | Status here |
| --- | --- |
| Head kept as verbatim messages, images included | text preserved in the summary and carried across cycles in details; roles, boundaries and head images lost, and reported |
| `keep_recent` assistant turns kept verbatim | pi keeps a token budget of recent context instead. More configurable, not the same rule |
| Compaction at a chosen token threshold | pi's own threshold, mapped through `reserveTokens` |
| `keep_recent=1` escalation rung | not ported. It changes the cut, and the cut is pi's |
| Replay after a provider context error | pi retries compaction once. The lean profile and part eviction apply on that attempt |
| Refuse an over-budget request in strict mode | not possible from inside the agent |
| Live `cliff watch` terminal view | `/cliff` plus a post-compaction notification and session-recorded details |

## Alternatives considered

**Own the cut, restore the head structurally.** Compute our own `firstKeptEntryId` from the branch to reproduce `keep_recent`, and add a `context` handler that re-inserts the original head messages from a snapshot in our details. It matches upstream's structure exactly. An independent review of pi's source rejected it on evidence, and the reasoning is worth keeping because it is what settles the question.

- `appendCompaction` stores `firstKeptEntryId` with no validation. If the id is not on the branch, `buildContextEntries` never sets its `foundFirstKept` flag and the projected context becomes the summary alone. The entire kept suffix vanishes with no error. This was measured, not inferred: a probe passed `00000000-dead-beef-0000-0000-000000000000`, `session.compact()` accepted it, `session_compact` fired normally, the bogus id persisted to disk, and the projected context collapsed to `compactionSummary` alone, which survives a reload. One wrong uuid destroys the session's context and nothing reports it.
- `emitContext` hands the hook a `structuredClone` (`runner.js:903`), so "keep the head by reference" is not achievable at all. The clone is a copy of the messages.
- Anything injected in that hook is invisible to `prepareCompaction`, `shouldCompact`, and `estimateProjectedContextTokens`, which all read the session projection. A head that costs more than the estimator believes is a compaction loop that no cut rule can satisfy.
- Upstream's own classification lists cut selection and threshold triggering as proxy scaffolding, not core mechanism. pi supplies both.

The remaining argument for it was fidelity to the head, and the persisted head section answers that in text. Rejected.

**Cancel in shadow mode.** Every design candidate proposed it, including mine. It mistakes pi's status quo for a secret. Shadow must leave pi's behaviour alone, which means letting pi compact.

**Message serializer with public cut and escalation stages.** Export `groupTurns`, `chooseCut`, `render`, `truncateToBudget` and let the handler compose them. Individual algorithms become reusable, and the handler inherits the job of ordering them and reconciling two budget owners. It exposes complexity that nothing here needs to touch.

**Let `AgentMessage[]` be the domain type.** One fewer conversion, and then every module needs pi's roles, redaction rules, and split-turn quirks, and every test needs a pi harness. The single conversion in `pi-units.ts` is cheaper than that.

**Fall back to pi's model summariser on failure.** Reads as more robust, and it is the option that silently spends money and rewrites history while in a failure path. Rejected.

## Open questions

- Is a head section of `humanMaxChars` the right bound for the opening task, or should head text get its own, larger, cap?
- Does the measured-overhead budget for overflow truncation hold up against a real session, or does the estimator disagree with the provider enough to make eviction either useless or destructive?

## Next implementation step

Build `cliff.ts` against fixtures derived from upstream's `tests/test_cliff.py` and `tests/test_escalation.py`, asserting byte-exact summary text, before anything imports a pi type.

## How the host is driven in tests

A probe proved pi's compaction path runs in-process with no credential and no network: `createAgentSession` with an in-memory `SessionManager`, an inline extension through `DefaultResourceLoader.extensionFactories`, and `session.compact()` exercises `prepareCompaction`, the hook dispatch, and `appendCompaction` for real. When the handler returns a result, no model call happens at all, which the probe confirmed by trapping `fetch`, `net.Socket.connect`, and the runtime's stream methods, then contrasting with the same hook returning `undefined`, where pi tried to reach a summariser. The exports needed are all public top-level ones: `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`, `ModelRuntime`, `getAgentDir`, `convertToLlm`. `prepareCompaction` is not among them and is not needed, because the preparation arrives on the event.

Three behaviours the tests must account for, all measured:

- pi rejects a compaction directly after another one with `Already compacted`. A repeat-cycle test has to append a turn between the two.
- On the second cycle the event carries `previousSummary` holding the first summary verbatim. The port reads it for nothing, and a test asserts the old summary contributes no parts.
- `tokensBefore` on a later cycle reflects only the tail since the last compaction, not the whole original context. Pass it through unchanged and let the host's accounting stand.
