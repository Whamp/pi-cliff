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

Loss that remains: head message roles, message boundaries, and head images. Text survives; structure does not. A task stated only as an image in the opening message is lost, and that case is counted and reported rather than described as preserved.

A compaction we did not produce (a `session_compact` with `fromExtension: false`, or details from another version) means no recoverable head. The port does not go looking for the original opening message behind a foreign summary.

### Escalation

Upstream walks a ladder when the outgoing request stays over budget: `keep_recent=1`, then drop thinking and cap assistant text at 300, then truncate the summary newest-part-first, and in strict mode refuse the request.

Two profiles survive, chosen by `event.reason`:

- `manual` and `threshold` use the configured rules.
- `overflow` uses `keepThinking: false` and an effective thought cap of `cfg === 0 ? 300 : min(cfg, 300)`.

Rung 1 is not portable, because it changes the cut and the cut is pi's. Rung 3 is dropped on purpose. Truncating the summary to fit a budget requires the fixed cost of the rest of the request, which the hook does not expose, and inventing one would chop summary text on a guess. There is no strict mode: refusing to compact is not a thing an agent-side extension can do to a provider.

### Failure

On any internal failure, the handler returns `{ cancel: true }` with a diagnostic. That includes unreadable or invalid config, an unmappable message, a canonicalisation throw, and an aborted signal.

`{ cancel: true }` is the faithful mapping of upstream's verbatim passthrough. Nothing changes about the context. What it does not do is make an over-budget request succeed, and upstream makes the same trade: it forwards the oversized request and lets the provider reject it rather than silently rewriting history. Returning `undefined` would hand the compaction to pi's model summariser, which is a bigger, costlier, irreversible action taken precisely when something is already wrong.

`mode: "off"` is the deliberate way to give ownership back to pi. It is the only path that returns `undefined`.

`mode: "shadow"` computes the summary, reports what it would have committed, and cancels. Upstream's shadow means "changes nothing". Here nothing means pi's pre-compaction state, so cancelling is what preserves it. The consequence is stated in the README: shadow sessions keep growing and can hit the provider's limit.

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
| Escalation ladder and replay on a provider error | one leaner profile on `overflow`, no replay |
| Refuse an over-budget request in strict mode | not possible from inside the agent |
| Live `cliff watch` terminal view | `/cliff` plus a post-compaction notification and session-recorded details |

## Alternatives considered

**Own the cut, restore the head structurally.** Compute our own `firstKeptEntryId` from the branch to reproduce `keep_recent`, and add a `context` handler that re-inserts the original head messages from a snapshot in our details. It matches upstream's structure exactly. It costs a handler that runs on every request in every mode, re-sends the head for the rest of the session and so spends the tokens compaction just reclaimed, re-keys the prompt cache on the first post-compaction request, and puts a hand-made entry id into a field pi does not validate. Wrong id, wrong projection, damaged session. It loses on interface depth: the caller has to know the projection rules to use it safely.

**Message serializer with public cut and escalation stages.** Export `groupTurns`, `chooseCut`, `render`, `truncateToBudget` and let the handler compose them. Individual algorithms become reusable, and the handler inherits the job of ordering them and reconciling two budget owners. It exposes complexity that nothing here needs to touch.

**Let `AgentMessage[]` be the domain type.** One fewer conversion, and then every module needs pi's roles, redaction rules, and split-turn quirks, and every test needs a pi harness. The single conversion in `pi-units.ts` is cheaper than that.

**Fall back to pi's model summariser on failure.** Reads as more robust, and it is the option that silently spends money and rewrites history while in a failure path. Rejected.

## Open questions

- Does the pi peer range need pinning beyond the installed 0.87.1, and should the compatibility test run against more than one release?
- Is a head section of `humanMaxChars` the right bound for the opening task, or should head text get its own, larger, cap?
- Should `/cliff` also show a running total of compactions and dropped characters for the session, which needs one scan of the branch and is cheap?

## Next implementation step

Build `cliff.ts` against fixtures derived from upstream's `tests/test_cliff.py` and `tests/test_escalation.py`, asserting byte-exact summary text, before anything imports a pi type.
