# pi-cliff

Mechanical context compaction for [pi](https://github.com/badlogic/pi-mono), ported from [CliffCompaction](NOTICE.md).

When pi decides your conversation is too long, it asks a model to write a summary of the older turns. Cliff replaces that summary with one built from the messages themselves. No model call. No new API cost. The summary lists what the assistant said, what it thought, which tools it called with which arguments, and which tool results were short enough to keep. Long tool outputs, images, and the previous summary are dropped, which is the whole point.

It is a port of the compaction mechanism from an HTTP proxy into a pi extension. `docs/design.md` records what carried over, what pi cannot express, and what was deliberately not ported.

## Install

```bash
pi install /path/to/pi-cliff
```

Restart pi. Cliff now produces the summary for every compaction, automatic or manual.

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

| Key                | Default  | Meaning                                                           |
| ------------------ | -------- | ----------------------------------------------------------------- |
| `mode`             | `active` | `active`, `shadow`, or `off`                                      |
| `keepThinking`     | `true`   | Include assistant thinking in the summary                         |
| `thoughtMaxChars`  | `0`      | Cap per assistant message. `0` means no cap                       |
| `thinkingMaxChars` | `0`      | Separate cap for thinking                                         |
| `cmdMaxChars`      | `150`    | Cap for a tool call and its arguments                             |
| `resultMaxChars`   | `500`    | Tool results longer than this are dropped instead of shortened    |
| `humanMaxChars`    | `20000`  | Cap for your own messages and for instructions in system messages |

A `0` is unlimited for the caps, except `resultMaxChars: 0`, which drops every non-empty result. That is upstream's meaning.

Bad configuration cancels compaction and tells you why. It never falls back to a model summary silently. Unknown keys, negative values, and non-integer caps are all errors.

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

`shadow` computes the summary and reports what it would have written, then leaves pi alone and pi compacts as usual. Use it to compare the two on the same trigger and the same cut before trusting `active`. Note that the no-model guarantee describes `active`; in `shadow` pi's own summariser still runs.

`off` returns control to pi entirely.

## Failure

If Cliff cannot build a summary, it cancels that compaction and says so. Your history is untouched. It never substitutes a degraded summary and never calls a model.

The faithful analogue of upstream's fail-open is to change nothing, and an uncompacted context can still be rejected by the provider. That is also what upstream does. If something in Cliff is breaking and you need compaction back immediately, set `mode: "off"`.

## Using it

```
/compact            # compact now
/cliff              # resolved config, file sources, last outcome on this branch
```

`/compact focus on the tests` asks a mechanical summariser to do something it cannot. Cliff compacts with the normal rules and reports that the instructions were ignored.

After a compaction you get a line like this:

```
Cliff: mechanical summary · 18 messages · 7 long results dropped · 4812 chars
```

`/cliff` reads committed session state, so it still answers after a resume or a branch switch. It reports what was dropped, how large the summary is, and any degradation. It does not claim token savings inferred from character counts.

## What you lose against the proxy

- The opening turns are preserved as text inside the summary, and carried forward across later compactions. Their original message roles, boundaries, and any images in them are not. pi stores one summary plus one contiguous suffix, so there is no slot for a separate opening block.
- Upstream keeps three recent assistant turns. pi keeps a token budget instead.
- Upstream retries a provider rejection by shedding more context. Here pi gets one recovery attempt, where Cliff drops thinking, caps assistant text at 300 characters, and evicts the oldest summary parts to fit what is left.
- Upstream's `cliff watch` terminal view has no equivalent. `/cliff` and the session file are what you get.

## Verify

```bash
pnpm check              # types, lint, format, unit and fixture tests
python3 scripts/gen-fixtures.py   # regenerate the upstream goldens
scripts/verify-live.sh  # one real pi session, then assert the session file
```

`gen-fixtures.py` calls upstream's own `compact()` and stores the resulting strings as the expectation for the TypeScript renderer, so fidelity is measured rather than claimed. `verify-live.sh` runs a real pi session against a local model, forces pi to compact, and asserts on the resulting session file. See the script header for pointing it at a different model.

## Out of scope

Branch and tree summarisation is pi's own feature and may still use a model. Registering `session_before_tree` is deliberately not done. If you install another extension that replaces compaction, the two will fight over the same hook.

## License

MIT, see `LICENSE` and `NOTICE.md`. Ported from CliffCompaction, Copyright (c) 2026 Trang Nguyen.
