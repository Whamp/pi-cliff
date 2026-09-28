# Design

Cliff owns automatic cuts at a completed assistant/tool step. Pi persists Cliff's native `turn_end` compaction entry and builds subsequent provider context from it. Manual `/compact` still uses Pi's cut. Pi also gates its own automatic threshold/overflow hook with its retained-token setting; when that hook runs, active Cliff plans a mechanical cut or cancels without a summarizer-model call.

## Contract

- On a completed step, Cliff uses Pi's current projected branch to find the last three assistant/tool steps. It summarizes an older prefix, validates the chosen assistant ID against the branch, previews a hypothetical native compaction in memory, and returns a draft only when estimated input decreases and fits the known model limit. The trigger measures the compressible middle alone, the candidate prefix between the system/tools head and the retained tail, against `workingTokens` (default 120000 estimated tokens). Head or tail growth never triggers a cut. The preview's model-limit check is a separate fit gate, not the trigger.
- Pi's projected `system` message already includes the current system prompt and active tool declarations. `estimateTokens(system)` counts them once. Cliff does not append a second prompt or tool estimate. An absent system message denies automatic planning instead of inventing a fallback.
- Manual compaction still copies Pi's `preparation.firstKeptEntryId` and `preparation.tokensBefore` and renders exactly `messagesToSummarize` followed by `turnPrefixMessages`.
- `manual` and `threshold` use the configured renderer. `overflow` disables reasoning and caps the renderer's existing assistant-text field at 300 Unicode code points (75 estimated tokens), treating `"unlimited"` as 300 and preserving zero. This is an internal rendering rule, not a provider-fit budget or replacement knob.
- Active-mode config, projection, rendering, malformed Cliff-owned head, or abort failures cancel compaction. They do not fall through to Pi's model summariser. `shadow` computes a comparison and delegates; `off` delegates without invoking Cliff's renderer.
- Optional notifications and receipts never control the compaction result. Pi UI notifications are used only when `ctx.hasUI`; headless diagnostics go to stderr.

## Message projection

`src/pi-units.ts` projects Pi message types into the content-class `SummaryUnit` union rendered by `src/cliff.ts`. User text blocks remain distinct; assistant messages retain their established grouping and ordering; images and previous summaries are omitted rather than summarized as content.

Pi's `bashExecution` and `branchSummary` roles have no ordinary upstream role. For just these two roles, Cliff uses Pi's `convertToLlm` and folds the resulting user text as `human`, preserving Pi's bash human/user classification, branch-summary framing, exclusions, and formatting. A bash message marked `excludeFromContext` becomes an omission because `convertToLlm` excludes it. Tests compare this projection to Pi's real converter; they do not recreate its text formatter.

The core renderer contains the upstream mechanical summary rules and golden-fixture comparisons. Overflow uses those lean rendering rules. The planner checks only its known boundary projection; a later queued prompt, model switch, or tool change can invalidate its estimate. A first oversized request can arrive before Cliff's first completed step. Pi still owns overflow retry and may not reach Cliff's hook if Pi's native preparation has no eligible cut.

## Carried opening head

Pi stores one summary and one contiguous kept suffix, so the opening task would otherwise age out on a later compaction. On the first cycle Cliff records leading human and system units before `headRegionEnd`. On later cycles it re-emits that stored head before the new Pi-selected messages, separated by an internal previous-summary boundary. A valid empty head stays empty.

The compaction entry's Cliff-owned state is deliberately minimal:

```json
{ "cliff": { "version": 1, "head": [{ "kind": "human", "text": "opening task" }] } }
```

`details.cliff.head` is decoded independently of receipts or historical report statistics. Missing or corrupt optional statistics cannot invalidate a valid head. A malformed Cliff-owned version/head cancels in active mode; a latest foreign compaction with no Cliff record is not parsed for recovery hints. No summary prose, foreign metadata, action counts, character counts, estimates, or diagnostics are used to reconstruct the head.

## Modes, failures, and reporting

- `active` returns a durable Cliff cut on a successful turn boundary. Manual compaction retains Pi's exact prepared cut and count. Native automatic threshold/overflow calls run the same automatic planner; a no-cut or failure records a best-effort receipt and returns `{ cancel: true }`.
- `shadow` renders for comparison, optionally records a receipt, reports that Pi owns the compaction, and returns `undefined` so Pi behaves normally. A shadow failure is also delegated.
- `off` does not invoke Cliff's renderer and returns `undefined`.

Reporting cannot turn an active success or cancellation into delegation. UI notification throws fall back to stderr; receipt write failures are ignored. `/cliff` reports every effective config value with its winning built-in, global-file, or project-file origin, plus file, head, and receipt status. `/cliff help` prints key meanings and strict JSON defaults before config loading or session queries. `session_compact` emits a concise committed status only for a compaction whose details contain a readable Cliff head.

Config has nine settings: `mode`, `workingTokens`, `keepRecentTurns`, `includeReasoning`, `assistantTextMaxTokens`, `reasoningTextMaxTokens`, `toolCallMaxTokens`, `toolResultMaxTokens`, and `userTextMaxTokens`. Public numeric limits are approximate tokens (Unicode code points divided by four), not tokenizer counts; exact quarter-token steps are accepted only when `tokens * 4` is a safe integer. `"unlimited"` disables a cap and zero retains no category content, including no tool-call line or user/system label. Positive text limits append an uncapped ellipsis; speaker labels and tool signature wrappers are outside text-payload caps. Tool-call limits apply to serialized arguments; a result above its limit is dropped whole. The five `*MaxTokens` per-content limits are not total-context budgets. `workingTokens` and `keepRecentTurns` are positive safe integers for automatic policy.

`src/config.ts` owns token-valued defaults, parsing, merge, help, status, and retired-key diagnostics. `src/auto-compaction.ts` owns automatic assistant-step selection, a known-full-input estimate, in-memory preview, and fit checks. `src/extension.ts` maps all five renderer fields explicitly to the unchanged character-valued `SummaryPolicy` at the single rendering boundary. Manual compaction still uses Pi-owned token counts unchanged. Defaults are derived from renderer limits of unlimited/unlimited/150/500/20000 code points, yielding unlimited/unlimited/37.5/125/5000 estimated tokens. Defaults, `~/.pi/agent/cliff.json`, then `<cwd>/.pi/cliff.json` set precedence. Current `*MaxChars` spellings are rejected with divide-by-four guidance while preserving their zero/unlimited meanings. Historical `thoughtMaxChars`, `thinkingMaxChars`, `cmdMaxChars`, `resultMaxChars`, and `humanMaxChars` are also diagnostic-only; their text-limit zero values migrate to `"unlimited"`, while historical result zero remains zero.

In active mode, unreadable or invalid config cancels safely; shadow and off delegate. `/compact` instructions are not applied to a mechanical summary, so Cliff reports that they were ignored and continues with the configured rules.

## Scope and verification

Cliff does not register `session_before_tree`; branch/tree summarisation remains Pi's feature and may use a model. The real-Pi SDK integration tests drive manual `session.compact()` and the registered `/cliff help` command with model/network tripwires. A separate SDK fixture drives real `session.prompt()` calls through a loopback fake provider and tests the actual Cliff `turn_end` draft with a 64K Pi retained tail. It checks the persisted entry and next dispatched request, plus off/shadow and model-fit denial. The suite does not simulate every native threshold, classified overflow retry, changed request loadout, or billed provider savings.

`pnpm check` runs type checking, type-aware Oxlint, formatting, unit tests, upstream renderer fixtures, and SDK integration tests. Regenerate the upstream goldens with `python3 scripts/gen-fixtures.py`; select another clone using `--upstream-src` or `CLIFF_UPSTREAM_SRC`. The stable default is `~/.cache/pi-cliff/cliffcompaction/src`, which must contain upstream revision `b48d660ae3c1f6037094d6cfc6b5d9f5938a7957`. Generated provenance records the source selector and upstream revision, not a machine-specific path. `scripts/verify-live.sh` is an optional later live-model check, separate from offline validation; it disables ambient extension discovery, explicitly loads Cliff, and uses temporary project settings and session data.
