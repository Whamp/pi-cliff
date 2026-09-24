# Design

Pi already owns compaction timing, the cut, recent-context retention, persistence, and rebuilding model context. Cliff supplies only the summary text for Pi's `session_before_compact` hook. In `active` mode, the hook does not call a model or infer whether rendered text fits a provider's context window.

## Contract

- Pi chooses and prepares one compaction. Cliff copies `preparation.firstKeptEntryId` and `preparation.tokensBefore` verbatim into its result; it never recomputes either value.
- Cliff projects `messagesToSummarize` followed by `turnPrefixMessages`. It does not inspect or rebuild Pi's kept suffix.
- `manual` and `threshold` use the configured renderer. `overflow` uses only the fixture-backed lean renderer profile: drop thinking and cap thoughts at 300 characters. There is no token estimator, fit budget, action-part eviction, or replacement budget knob.
- Active-mode config, projection, rendering, malformed Cliff-owned head, or abort failures cancel compaction. They do not fall through to Pi's model summariser. `shadow` computes a comparison and delegates; `off` delegates without invoking Cliff's renderer.
- Optional notifications and receipts never control the compaction result. Pi UI notifications are used only when `ctx.hasUI`; headless diagnostics go to stderr.

## Message projection

`src/pi-units.ts` projects Pi message types into the content-class `SummaryUnit` union rendered by `src/cliff.ts`. User text blocks remain distinct; assistant messages retain their established grouping and ordering; images and previous summaries are omitted rather than summarized as content.

Pi's `bashExecution` and `branchSummary` roles have no ordinary upstream role. For just these two roles, Cliff uses Pi's `convertToLlm` and folds the resulting user text as `human`, preserving Pi's bash human/user classification, branch-summary framing, exclusions, and formatting. A bash message marked `excludeFromContext` becomes an omission because `convertToLlm` excludes it. Tests compare this projection to Pi's real converter; they do not recreate its text formatter.

The core renderer contains the upstream mechanical summary rules and golden-fixture comparisons. Overflow recovery applies only those lean rendering rules. A summary may still exceed the provider's limit; Pi owns the cut and retry policy, and Cliff makes no provider-fit promise.

## Carried opening head

Pi stores one summary and one contiguous kept suffix, so the opening task would otherwise age out on a later compaction. On the first cycle Cliff records leading human and system units before `headRegionEnd`. On later cycles it re-emits that stored head before the new Pi-selected messages, separated by an internal previous-summary boundary. A valid empty head stays empty.

The compaction entry's Cliff-owned state is deliberately minimal:

```json
{"cliff":{"version":1,"head":[{"kind":"human","text":"opening task"}]}}
```

`details.cliff.head` is decoded independently of receipts or historical report statistics. Missing or corrupt optional statistics cannot invalidate a valid head. A malformed Cliff-owned version/head cancels in active mode; a latest foreign compaction with no Cliff record is not parsed for recovery hints. No summary prose, foreign metadata, action counts, character counts, estimates, or diagnostics are used to reconstruct the head.

## Modes, failures, and reporting

- `active` renders Cliff's summary and returns Pi's exact prepared boundary and token count. An internal failure records a best-effort `cliff.outcome` receipt, reports the cause, and returns `{ cancel: true }`.
- `shadow` renders for comparison, optionally records a receipt, reports that Pi owns the compaction, and returns `undefined` so Pi behaves normally. A shadow failure is also delegated.
- `off` does not invoke Cliff's renderer and returns `undefined`.

Reporting cannot turn an active success or cancellation into delegation. UI notification throws fall back to stderr; receipt write failures are ignored. `/cliff` reports resolved config sources, the latest branch head status, and an optional shadow/cancellation receipt. `session_compact` emits a concise committed status only for a compaction whose details contain a readable Cliff head.

Config comes from defaults, `~/.pi/agent/cliff.json`, then `<cwd>/.pi/cliff.json`. In active mode, unreadable or invalid config cancels safely; shadow and off delegate. `/compact` instructions are not applied to a mechanical summary, so Cliff reports that they were ignored and continues with the configured rules.

## Scope and verification

Cliff does not register `session_before_tree`; branch/tree summarisation remains Pi's feature and may use a model. The real-Pi SDK integration test drives manual `session.compact()` through the installed extension with model and network tripwires, without module-loader mocking. It verifies Pi's actual cut/count and projected suffix, three compaction cycles with the original head, valid empty and malformed persisted state, configuration and notification failures, and shadow delegation. Automatic threshold and overflow triggers remain covered at the direct hook boundary only; the SDK integration does not synthesize an agent turn or provider overflow recovery.

`pnpm check` runs type checking, type-aware Oxlint, formatting, unit tests, upstream renderer fixtures, and SDK integration tests. Regenerate the upstream goldens with `python3 scripts/gen-fixtures.py`; select another clone using `--upstream-src` or `CLIFF_UPSTREAM_SRC`. The stable default is `~/.cache/pi-cliff/cliffcompaction/src`, which must contain upstream revision `b48d660ae3c1f6037094d6cfc6b5d9f5938a7957`. Generated provenance records the source selector and upstream revision, not a machine-specific path. `scripts/verify-live.sh` is an optional later live-model check, separate from offline validation; it disables ambient extension discovery, explicitly loads Cliff, and uses temporary project settings and session data.
