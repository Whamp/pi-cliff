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

Optional. Upstream's defaults apply when nothing is present.

```jsonc
// ~/.pi/agent/cliff.json
{
  "mode": "active",
  "keepThinking": true,
  "thoughtMaxChars": 0,
  "thinkingMaxChars": 0,
  "cmdMaxChars": 150,
  "resultMaxChars": 500,
  "humanMaxChars": 20000,
}
```

Add `<project>/.pi/cliff.json` to override a single project. Project wins over global.

| Key                | Default  | Meaning                                                         |
| ------------------ | -------- | --------------------------------------------------------------- |
| `mode`             | `active` | `active`, `shadow`, or `off`                                    |
| `keepThinking`     | `true`   | Include assistant thinking in the summary                       |
| `thoughtMaxChars`  | `0`      | Cap per assistant message. `0` means no cap                     |
| `thinkingMaxChars` | `0`      | Separate cap for thinking                                      |
| `cmdMaxChars`      | `150`    | Cap for a tool call and its arguments                           |
| `resultMaxChars`   | `500`    | Tool results longer than this are dropped instead of shortened |
| `humanMaxChars`    | `20000`  | Cap for your own messages and system instructions               |

A `0` is unlimited for the caps, except `resultMaxChars: 0`, which drops every non-empty result. That is upstream's meaning.

In `active` mode, bad configuration cancels compaction and tells you why; it never falls back to a model summary silently. In `shadow` and `off`, pi owns the compaction. Unknown keys, negative values, and non-integer caps are all errors.

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
/cliff              # resolved config, file sources, and branch head status
```

`/compact focus on the tests` asks a mechanical summariser to do something it cannot. Cliff compacts with the normal rules and reports that the instructions were ignored.

After an active Cliff compaction you get a short committed-status line. `/cliff` shows the resolved mode, config sources, current branch's carried-head status, and the latest optional shadow or cancellation receipt. The compaction entry stores only `{version, head}` under `details.cliff`; optional receipts and statistics never gate head restoration.

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

`verify-live.sh` is separate from offline validation. It disables ambient extension discovery, explicitly loads Cliff, and uses a throwaway project settings directory and session directory; it does not install or edit anything under `~/.pi`. It still runs the selected live model and is not part of `pnpm check`.

## Out of scope

Branch and tree summarisation is pi's own feature and may still use a model. Registering `session_before_tree` is deliberately not done. If you install another extension that replaces compaction, the two will fight over the same hook.

## License

MIT, see `LICENSE` and `NOTICE.md`. Ported from CliffCompaction, Copyright (c) 2026 Trang Nguyen.
