#!/usr/bin/env bash
# End-to-end check: run a real pi session against a real model with the
# extension loaded, force pi to compact, then assert what it persisted.
#
#   scripts/verify-live.sh                      # uses the local server60 model
#   PI_MODEL_ARGS="--provider x --model y" scripts/verify-live.sh
#
# Nothing here writes to ~/.pi. The extension is loaded per-run with -e and the
# project config lives in a throwaway directory.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${TMPDIR:-/tmp}/pi-cliff-verify.$$"
model_args="${PI_MODEL_ARGS:---provider server60-qwen38 --model qwen3.8-flash-next-intel-autoround-w4a16}"

mkdir -p "$work/.pi" "$work/sessions"

# A reserve larger than the context window makes pi's threshold
# (contextWindow - reserveTokens) unreachable, so compaction fires as soon as
# there is any usage. keepRecentTokens is set low so the cut sits early and the
# summarised range is large enough to exercise every content class.
cat >"$work/.pi/settings.json" <<'JSON'
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 300000,
    "keepRecentTokens": 400
  }
}
JSON

cat >"$work/.pi/cliff.json" <<'JSON'
{
  "mode": "active",
  "resultMaxChars": 500
}
JSON

prompt='First, remember this instruction for the whole session: the deployment colour is TEAL-7.
Now run these bash commands one at a time, each in its own tool call, and tell me the final line of the last one:
1. seq 1 500
2. printf "marker-odd\\n%.0s" {1..300}
3. echo done'

cd "$work"
# shellcheck disable=SC2086
pi $model_args \
  --approve \
  --no-context-files --no-skills \
  --session-dir "$work/sessions" \
  -e "$repo/src/extension.ts" \
  -p "$prompt"

session="$(ls -t "$work"/sessions/*.jsonl | head -1)"
echo "session: $session"
if node "$repo/scripts/inspect-session.mjs" "$session" TEAL-7; then
  trap - EXIT
  rm -rf "$work"
  echo "cleaned up $work"
else
  trap - EXIT
  echo "left $work in place for inspection" >&2
  exit 1
fi
