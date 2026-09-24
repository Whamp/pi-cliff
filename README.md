# pi-cliff

Mechanical context compaction for [pi](https://github.com/badlogic/pi-mono), ported from [CliffCompaction](NOTICE.md).

In `active` mode, when pi compacts a conversation, Cliff replaces the model-written summary with one built from the messages themselves. No model call. No new API cost. The summary lists what the assistant said, what it thought, which tools it called with which arguments, and which tool results were short enough to keep. Long tool outputs, images, and the previous summary are dropped, which is the whole point. `shadow` and `off` leave pi's model summariser in control.

It is a port of the compaction mechanism from an HTTP proxy into a pi extension. Bash executions and branch summaries use Pi's own `convertToLlm` projection; `docs/design.md` records what carried over, what pi cannot express, and what was deliberately not ported.

## Install

```bash
pi install /path/to/pi-cliff
```

Restart pi. Cliff now handles every compaction request with a mechanical summary in `active` mode.

## Configure

Optional. Cliff's defaults apply when neither config file is present. Create `~/.pi/agent/cliff.json`:

```json
{
  "mode": "active",
  "includeReasoning": true,
  "assistantTextMaxChars": "unlimited",
  "reasoningTextMaxChars": "unlimited",
  "toolCallMaxChars": 150,
  "toolResultMaxChars": 500,
  "userTextMaxChars": 20000
}
```

Add `<project>/.pi/cliff.json` to override values for one project. Project settings override global settings, which override the built-in defaults.

| Key                      | Default       | Meaning                                                                      |
| ------------------------ | ------------- | ---------------------------------------------------------------------------- |
| `mode`                   | `active`      | `active`, `shadow`, or `off`                                                  |
| `includeReasoning`       | `true`        | Include assistant reasoning text                                             |
| `assistantTextMaxChars`  | `"unlimited"` | Limit visible assistant text per message                                    |
| `reasoningTextMaxChars`  | `"unlimited"` | Limit reasoning text per assistant message                                  |
| `toolCallMaxChars`       | `150`         | Limit serialized tool-call arguments, not the `[toolName]` wrapper           |
| `toolResultMaxChars`     | `500`         | Drop tool results whole when they exceed this limit                         |
| `userTextMaxChars`       | `20000`       | Limit user and system text per block, including the carried opening head    |

The five character limits accept nonnegative safe integers or the exact string `"unlimited"`. They count Unicode code points. A limit of `0` keeps no content in its category: it omits whole tool-call lines and user/system labels as needed. `"unlimited"` disables the limit. Positive text limits append `...` after the cap; tool results are never truncated, and a result above a positive limit is dropped whole. A tool-call limit applies to serialized arguments only, not the `[toolName]` wrapper.

The old names are rejected, not aliased or rewritten: `keepThinking` → `includeReasoning`, `thoughtMaxChars` → `assistantTextMaxChars`, `thinkingMaxChars` → `reasoningTextMaxChars`, `cmdMaxChars` → `toolCallMaxChars`, `resultMaxChars` → `toolResultMaxChars`, and `humanMaxChars` → `userTextMaxChars`. The old text-limit value `0` meant unlimited; write `"unlimited"` under the new name to preserve that behavior. `resultMaxChars: 0` still means drop every non-empty result, so migrate it to `toolResultMaxChars: 0`.

In `active` mode, bad configuration cancels compaction and tells you why; Cliff never falls back to a model summary silently. In `shadow` and `off`, pi owns compaction. When a valid config file selects `"off"`, errors in the other file do not block Pi, and `/cliff` reports them. An invalid file is ignored as a whole, including any `mode` value it contains. Unknown keys, negative or fractional values, unsafe integers, and limits other than a number or `"unlimited"` are errors.

## Who owns what

pi decides when to compact and how much recent context to keep. Cliff decides what the summary says.

|                                  | Owner                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| When compaction happens          | pi, through `compaction.enabled` and `compaction.reserveTokens` |
| How much recent context survives | pi, through `compaction.keepRecentTokens`                       |
| What the summary contains        | Cliff                                                           |
| Persistence and the session file | pi                                                              |

There is no `thresholdTokens` and no `keepRecent` here on purpose. Upstream needed those because it was a proxy guessing at token counts and choosing its own cut. pi has real accounting and its own cut rule. If you are porting a proxy configuration, upstream's `--threshold T` on a window of `W` is roughly pi's `reserveTokens = W - T`.

## Modes

`active` is the default. Cliff writes the summary and pi persists it.

`shadow` computes the summary for comparison, then delegates to pi. Pi's model summariser still runs, so the no-model guarantee applies only to `active` mode.

`off` returns control to pi entirely.

## Failure

If Cliff cannot read active-mode config, project Pi's selected messages, restore its own opening head, render a summary, or honor an abort, it cancels that compaction and reports why. History is unchanged. It never substitutes a degraded summary or falls through to Pi's model summariser. Optional notifications and outcome receipts are isolated: their failure cannot hand control to the model summariser.

In `shadow` and `off`, Cliff delegates to pi. If something in Cliff is breaking and you need compaction back immediately, set `mode` to `"off"`.

## Using it

```text
/compact            # compact now
/cliff              # effective config, winning sources, and branch status
/cliff help         # config keys, semantics, precedence, and copyable defaults
```

`/compact focus on the tests` asks a mechanical summariser to do something it cannot. Cliff compacts with the normal rules and reports that the instructions were ignored.

After an active Cliff compaction you get a short committed-status line. `/cliff` shows every effective value and its winning built-in, global-file, or project-file origin, plus file, head, and receipt status. `/cliff help` works even when a config file is malformed. The compaction entry stores only `{version, head}` under `details.cliff`; optional receipts and statistics never gate head restoration.

## What you lose against the proxy

- The opening turns are preserved as text inside the summary, and carried forward across later compactions. Their original message roles, boundaries, and any images in them are not. pi stores one summary plus one contiguous suffix, so there is no slot for a separate opening block.
- Upstream keeps three recent assistant turns. pi keeps a token budget instead.
- Upstream retries a provider rejection by shedding more context. Here pi owns overflow recovery; Cliff uses only its lean renderer policy (drop thinking and cap assistant text at 300 characters), without estimating a provider-fit budget or evicting summary parts. The result may still exceed the provider's limit.
- Upstream's `cliff watch` terminal view has no equivalent. `/cliff` and the session file are what you get.

## Verify

```bash
pnpm check
python3 scripts/gen-fixtures.py
scripts/verify-live.sh  # optional live-model verification; not part of the offline check
```

`pnpm check` runs TypeScript, type-aware Oxlint, formatting, the upstream renderer fixtures, and the real-Pi SDK integration tests. The SDK tests exercise manual `session.compact()` with model/network tripwires; automatic threshold and overflow behavior are covered at the direct hook boundary only. No live model is called by the offline suite.

`gen-fixtures.py` calls upstream's own `compact()` and stores the resulting strings as the renderer oracle. Select a clone with `--upstream-src` or `CLIFF_UPSTREAM_SRC`; with neither, it uses `~/.cache/pi-cliff/cliffcompaction/src`. The checked-in provenance records the source selector and upstream revision, not a machine-specific absolute path.

`verify-live.sh` is separate from offline validation. It disables ambient extension discovery, explicitly loads Cliff, and uses throwaway project settings, session, and agent directories; it does not install or edit anything under `~/.pi`. Needed model/auth files are copied only into the private temporary agent directory and removed on exit. The script preserves `run.log` and session JSONL under `/tmp/pi-cliff-verify-evidence-*` (or `CLIFF_LIVE_ARTIFACT_DIR`). It still runs the selected live model and is not part of `pnpm check`.

## Out of scope

Branch and tree summarisation is pi's own feature and may still use a model. Registering `session_before_tree` is deliberately not done. If you install another extension that replaces compaction, the two will fight over the same hook.

## License

MIT, see `LICENSE` and `NOTICE.md`. Ported from CliffCompaction, Copyright (c) 2026 Trang Nguyen.
