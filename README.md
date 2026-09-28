# pi-cliff

Mechanical context compaction for [pi](https://github.com/badlogic/pi-mono), ported from [CliffCompaction](https://github.com/nguyenvuthientrang/cliffcompaction). Based on the paper [CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents](https://arxiv.org/abs/2609.26779).

In `active` mode, when pi compacts a conversation, Cliff replaces the model-written summary with one built from the messages themselves. No model call. No new API cost. The summary lists what the assistant said, what it thought, which tools it called with which arguments, and which tool results were short enough to keep. Long tool outputs, images, and the previous summary are dropped, which is the whole point. `shadow` and `off` leave pi's model summariser in control.

It is a port of the compaction mechanism from an HTTP proxy into a pi extension. Bash executions and branch summaries use Pi's own `convertToLlm` projection; `docs/design.md` records what carried over, what pi cannot express, and what was deliberately not ported.

## Install

```bash
pi install git:github.com/Whamp/pi-cliff
```

Restart pi. Cliff now chooses automatic cuts after completed assistant/tool steps in `active` mode. Manual `/compact` still uses Pi's eligibility and cut.

To try Cliff for one Pi invocation without adding it to your settings, run:

```bash
pi -e git:github.com/Whamp/pi-cliff
```

In that session, run `/cliff help` to see the defaults. Exit Pi to stop loading Cliff automatically; the package may remain in Pi's download cache.

## Configure

Optional. Cliff's defaults apply when neither config file is present. Create `~/.pi/agent/cliff.json`:

```json
{
  "mode": "active",
  "workingTokens": 120000,
  "keepRecentTurns": 3,
  "includeReasoning": true,
  "assistantTextMaxTokens": "unlimited",
  "reasoningTextMaxTokens": "unlimited",
  "toolCallMaxTokens": 37.5,
  "toolResultMaxTokens": 125,
  "userTextMaxTokens": 5000
}
```

Add `<project>/.pi/cliff.json` to override values for one project. Project settings override global settings, which override the built-in defaults.

| Key                      | Default       | Meaning                                                                    |
| ------------------------ | ------------- | -------------------------------------------------------------------------- |
| `mode`                   | `active`      | `active`, `shadow`, or `off`                                               |
| `workingTokens`         | `120000`      | Compressible-middle estimate that triggers an automatic cut; head and retained tail excluded |
| `keepRecentTurns`        | `3`           | Recent assistant/tool steps kept intact by an automatic cut                |
| `includeReasoning`       | `true`        | Include assistant reasoning text                                           |
| `assistantTextMaxTokens` | `"unlimited"` | Approximate-token limit for visible assistant text per message             |
| `reasoningTextMaxTokens` | `"unlimited"` | Approximate-token limit for reasoning text per assistant message           |
| `toolCallMaxTokens`      | `37.5`        | Approximate-token limit for serialized tool-call arguments                 |
| `toolResultMaxTokens`    | `125`         | Drop tool results whole when they exceed this approximate-token limit      |
| `userTextMaxTokens`      | `5000`        | Approximate-token limit for user and system text per block, including head |

The five `*MaxTokens` settings are estimates, not actual tokenizer counts: estimated tokens = Unicode code points ÷ 4. After standard JavaScript JSON number parsing, they accept finite nonnegative numbers in quarter-token steps only, and the converted code-point cap (`tokens * 4`) must be a safe integer. Cliff does not round parsed limits. JSON parsing itself uses floating-point numbers, so extreme literals can lose precision or underflow to zero. A limit of `0` keeps no content in its category; `"unlimited"` disables it. Positive text limits append `...` after the capped payload. Speaker labels, tool signature wrappers, and appended ellipses are outside text payload caps. Tool-call limits apply to serialized arguments only; tool results are never truncated and oversized results are dropped whole. These five per-content limits are not total-context budgets. `workingTokens` and `keepRecentTurns` must be positive safe integers. `workingTokens` estimates the compressible middle only, not tokens measured at the provider.

Both the previous `*MaxChars` settings and historical spellings are rejected, not aliased or rewritten. Current keys migrate as `assistantTextMaxChars` → `assistantTextMaxTokens`, `reasoningTextMaxChars` → `reasoningTextMaxTokens`, `toolCallMaxChars` → `toolCallMaxTokens`, `toolResultMaxChars` → `toolResultMaxTokens`, and `userTextMaxChars` → `userTextMaxTokens`; divide finite code-point values by 4, preserving their `0` and `"unlimited"` meanings. Historical keys migrate as `thoughtMaxChars` → `assistantTextMaxTokens`, `thinkingMaxChars` → `reasoningTextMaxTokens`, `cmdMaxChars` → `toolCallMaxTokens`, `resultMaxChars` → `toolResultMaxTokens`, and `humanMaxChars` → `userTextMaxTokens`; divide finite values by 4, with old text-limit `0` mapped to `"unlimited"` and `resultMaxChars: 0` remaining `0`. `keepThinking` still maps to `includeReasoning`.

In `active` mode, bad configuration prevents a Cliff turn-boundary draft. When Pi reaches an eligible native compaction hook, Cliff cancels rather than falling through to a model summary. `/cliff` reports configuration errors. In `shadow` and `off`, Pi owns compaction. When a valid config file selects `"off"`, errors in the other file do not block Pi, and `/cliff` reports them. An invalid file is ignored as a whole, including any `mode` value it contains. Unknown keys, negative or non-finite values, values that are not exact quarter-token steps, unsafe converted code-point limits, and limits other than a number or `"unlimited"` are errors.

## Who owns what

After a successful assistant/tool step, Cliff estimates the compressible middle, the working history between the system/tools head and the retained tail. If it exceeds `workingTokens`, Cliff chooses an older assistant-step cut, preserves three recent assistant/tool steps by default, and previews the draft against the model's input limit before returning it. Pi persists it before the next request. Pi's `compaction.keepRecentTokens` does not choose this Cliff-owned cut, and head growth does not spend the working budget.

Manual `/compact` still uses Pi's cut and Pi's retained-token setting. Pi also owns persistence, its own automatic threshold/overflow checks, and their eligibility gate. If native preparation succeeds, active Cliff supplies a mechanical cut or cancels; it never falls through to Pi's model summariser. An oversized first request can precede Cliff's first completed step. A later queued prompt or changed model/tools can differ from Cliff's boundary estimate. No exact provider-fit or billed-savings claim follows from the estimate.

## Modes

`active` is the default. Cliff writes the summary and pi persists it.

`shadow` does not make Cliff-owned automatic cuts. When Pi calls its native hook, Cliff computes a comparison summary and delegates to Pi. Pi's model summariser can still run, so the no-model guarantee applies only to `active` mode with no competing compaction extension.

`off` returns control to pi entirely.

## Failure

At a completed-step boundary, Cliff only returns a draft when it can validate a reducing cut; otherwise it leaves history unchanged. When Pi invokes the native automatic or manual compaction hook, active Cliff cancels on failure rather than substituting a degraded summary or falling through to Pi's model summariser. Optional notifications and outcome receipts cannot change that result. Pi's own hook is not called when its retained-token setting leaves no eligible native cut.

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
- Cliff now retains three recent assistant/tool steps on its own automatic cuts; Pi still chooses the kept tail for manual compaction and gates its own automatic/overflow hooks with a token budget.
- Upstream retries a provider rejection by shedding more context. Here Pi owns overflow retry and may find no eligible native cut under a large retained-token setting. Cliff uses lean overflow rendering when Pi reaches its hook, but cannot guarantee recovery before a first completed step.
- Upstream's `cliff watch` terminal view has no equivalent. `/cliff` and the session file are what you get.

## Verify

```bash
pnpm check
python3 scripts/gen-fixtures.py
PI_MODEL_ARGS="--provider <name> --model <name>" scripts/verify-live.sh  # optional live-model check
```

`pnpm check` runs TypeScript, type-aware Oxlint, formatting, the upstream renderer fixtures, and the real-Pi SDK integration tests. The offline SDK tests include a local fake provider, a real `turn_end` draft, and the next dispatched provider request with Pi's 64K tail. No paid model is called by the offline suite.

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
