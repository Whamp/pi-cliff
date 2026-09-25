# pi-cliff

Mechanical context compaction for [pi](https://github.com/badlogic/pi-mono), ported from [CliffCompaction](https://github.com/nguyenvuthientrang/cliffcompaction). Based on the paper [CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents](https://arxiv.org/abs/2609.26779).

In `active` mode, when pi compacts a conversation, Cliff replaces the model-written summary with one built from the messages themselves. No model call. No new API cost. The summary lists what the assistant said, what it thought, which tools it called with which arguments, and which tool results were short enough to keep. Long tool outputs, images, and the previous summary are dropped, which is the whole point. `shadow` and `off` leave pi's model summariser in control.

It is a port of the compaction mechanism from an HTTP proxy into a pi extension. Bash executions and branch summaries use Pi's own `convertToLlm` projection; `docs/design.md` records what carried over, what pi cannot express, and what was deliberately not ported.

## Install

```bash
pi install git:github.com/Whamp/pi-cliff
```

Restart pi. Cliff now handles every compaction request with a mechanical summary in `active` mode.

## Configure

Optional. Cliff's defaults apply when neither config file is present. Create `~/.pi/agent/cliff.json`:

```json
{
  "mode": "active",
  "includeReasoning": true,
  "assistantTextMaxTokens": "unlimited",
  "reasoningTextMaxTokens": "unlimited",
  "toolCallMaxTokens": 37.5,
  "toolResultMaxTokens": 125,
  "userTextMaxTokens": 5000
}
```

Add `<project>/.pi/cliff.json` to override values for one project. Project settings override global settings, which override the built-in defaults.

| Key                       | Default       | Meaning                                                                   |
| ------------------------- | ------------- | ------------------------------------------------------------------------- |
| `mode`                    | `active`      | `active`, `shadow`, or `off`                                               |
| `includeReasoning`        | `true`        | Include assistant reasoning text                                          |
| `assistantTextMaxTokens`  | `"unlimited"` | Approximate-token limit for visible assistant text per message             |
| `reasoningTextMaxTokens`  | `"unlimited"` | Approximate-token limit for reasoning text per assistant message            |
| `toolCallMaxTokens`       | `37.5`        | Approximate-token limit for serialized tool-call arguments                 |
| `toolResultMaxTokens`     | `125`         | Drop tool results whole when they exceed this approximate-token limit      |
| `userTextMaxTokens`       | `5000`        | Approximate-token limit for user and system text per block, including head |

The five `*MaxTokens` settings are estimates, not actual tokenizer counts: estimated tokens = Unicode code points ÷ 4. After standard JavaScript JSON number parsing, they accept finite nonnegative numbers in quarter-token steps only, and the converted code-point cap (`tokens * 4`) must be a safe integer. Cliff does not round parsed limits. JSON parsing itself uses floating-point numbers, so extreme literals can lose precision or underflow to zero. A limit of `0` keeps no content in its category; `"unlimited"` disables it. Positive text limits append `...` after the capped payload. Speaker labels, tool signature wrappers, and appended ellipses are outside text payload caps. Tool-call limits apply to serialized arguments only; tool results are never truncated and oversized results are dropped whole. These are per-content limits, not total-context budgets.

Both the previous `*MaxChars` settings and historical spellings are rejected, not aliased or rewritten. Current keys migrate as `assistantTextMaxChars` → `assistantTextMaxTokens`, `reasoningTextMaxChars` → `reasoningTextMaxTokens`, `toolCallMaxChars` → `toolCallMaxTokens`, `toolResultMaxChars` → `toolResultMaxTokens`, and `userTextMaxChars` → `userTextMaxTokens`; divide finite code-point values by 4, preserving their `0` and `"unlimited"` meanings. Historical keys migrate as `thoughtMaxChars` → `assistantTextMaxTokens`, `thinkingMaxChars` → `reasoningTextMaxTokens`, `cmdMaxChars` → `toolCallMaxTokens`, `resultMaxChars` → `toolResultMaxTokens`, and `humanMaxChars` → `userTextMaxTokens`; divide finite values by 4, with old text-limit `0` mapped to `"unlimited"` and `resultMaxChars: 0` remaining `0`. `keepThinking` still maps to `includeReasoning`.

In `active` mode, bad configuration cancels compaction and tells you why; Cliff never falls back to a model summary silently. In `shadow` and `off`, pi owns compaction. When a valid config file selects `"off"`, errors in the other file do not block Pi, and `/cliff` reports them. An invalid file is ignored as a whole, including any `mode` value it contains. Unknown keys, negative or non-finite values, values that are not exact quarter-token steps, unsafe converted code-point limits, and limits other than a number or `"unlimited"` are errors.

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
- Upstream retries a provider rejection by shedding more context. Here pi owns overflow recovery; Cliff uses only its lean renderer policy (drop thinking and cap assistant text at 300 Unicode code points, or 75 estimated tokens), without estimating a provider-fit budget or evicting summary parts. The result may still exceed the provider's limit.
- Upstream's `cliff watch` terminal view has no equivalent. `/cliff` and the session file are what you get.

## Verify

```bash
pnpm check
python3 scripts/gen-fixtures.py
PI_MODEL_ARGS="--provider <name> --model <name>" scripts/verify-live.sh  # optional live-model check
```

`pnpm check` runs TypeScript, type-aware Oxlint, formatting, the upstream renderer fixtures, and the real-Pi SDK integration tests. The SDK tests exercise manual `session.compact()` with model/network tripwires; automatic threshold and overflow behavior are covered at the direct hook boundary only. No live model is called by the offline suite.

`gen-fixtures.py` calls upstream's own `compact()` and stores the resulting strings as the renderer oracle. Select a clone with `--upstream-src` or `CLIFF_UPSTREAM_SRC`; with neither, it uses `~/.cache/pi-cliff/cliffcompaction/src`. The checked-in provenance records the source selector and upstream revision, not a machine-specific absolute path.

`verify-live.sh` requires a configured model through `PI_MODEL_ARGS` and is separate from offline validation. It disables ambient extension discovery, explicitly loads Cliff, and uses throwaway project settings, session, and agent directories; it does not install or edit anything under `~/.pi`. Needed model/auth files are copied only into the private temporary agent directory and removed on exit. The script preserves `run.log` and session JSONL under `/tmp/pi-cliff-verify-evidence-*` (or `CLIFF_LIVE_ARTIFACT_DIR`). It still runs the selected live model and is not part of `pnpm check`.

## Out of scope

Branch and tree summarisation is pi's own feature and may still use a model. Registering `session_before_tree` is deliberately not done. If you install another extension that replaces compaction, the two will fight over the same hook.

## Citation

The [original project](https://github.com/nguyenvuthientrang/cliffcompaction) gives this citation for the [paper](https://arxiv.org/abs/2609.26779):

```bibtex
@article{nguyen2026cliffcompaction,
  title   = {CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents},
  author  = {Nguyen, Trang and Cho, Eulrang and Chen, Bingqing and Dettmers, Tim},
  journal = {arXiv preprint arXiv:2609.26779},
  year    = {2026}
}
```

## License

MIT, see `LICENSE` and `NOTICE.md`. Ported from CliffCompaction, Copyright (c) 2026 Trang Nguyen.
