#!/usr/bin/env bash
# End-to-end check: run a real pi session against a real model with Cliff loaded,
# force compaction, then resume the same session with a retrieval follow-up.
#
#   scripts/verify-live.sh                      # uses the local server60 model
#   PI_MODEL_ARGS="--provider x --model y" scripts/verify-live.sh
#
# Nothing here writes under ~/.pi. Ambient extension discovery is disabled;
# Cliff is loaded explicitly, and settings/session/auth files are isolated.
set -euo pipefail
umask 077

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_root="${TMPDIR:-/tmp}"
work="$(mktemp -d "$tmp_root/pi-cliff-verify.XXXXXX")"
artifact_dir="${CLIFF_LIVE_ARTIFACT_DIR:-$tmp_root/pi-cliff-verify-evidence-$(basename "$work")}"
source_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
agent_dir="$work/agent"
model_args="${PI_MODEL_ARGS:---provider server60-qwen38 --model qwen3.8-flash-next-intel-autoround-w4a16}"
read -r -a model_args_array <<< "$model_args"
opening_marker="TEAL-7"
followup_user_marker="FOLLOWUP_QUESTION:"
followup_answer_marker="REMEMBERED_COLOUR=TEAL-7"
session=""

if [[ -e "$artifact_dir" ]]; then
  echo "evidence directory already exists: $artifact_dir" >&2
  rm -rf "$work"
  exit 2
fi
mkdir -m 700 -p "$artifact_dir"
artifact_dir="$(cd "$artifact_dir" && pwd)"
case "$artifact_dir/" in
  "$work/"*)
    echo "evidence directory must not be inside the temporary session directory" >&2
    rm -rf "$work"
    exit 2
    ;;
esac

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$session" && -f "$session" ]]; then
    cp -- "$session" "$artifact_dir/session-final.jsonl" || echo "could not copy final session to evidence" >&2
  fi
  rm -rf "$agent_dir"
  if (( status == 0 )); then
    rm -rf "$work"
    echo "cleaned up temporary session directory"
  else
    echo "left non-secret temporary session files at $work for inspection" >&2
  fi
  echo "evidence: $artifact_dir"
  exit "$status"
}
trap cleanup EXIT
exec > >(tee "$artifact_dir/run.log") 2>&1

run_pi() {
  timeout --signal=TERM --kill-after=10s "${PI_LIVE_TIMEOUT_SECONDS:-180}s" pi "$@"
}

mkdir -p "$work/.pi" "$work/sessions" "$agent_dir"
chmod 700 "$agent_dir" "$work/sessions"

# Pi reads custom model definitions and credentials from its agent dir. Copy them
# to an ephemeral private directory so OAuth refreshes or startup writes cannot
# mutate ~/.pi; the agent dir is removed on exit and never copied to evidence.
for file in models.json auth.json; do
  if [[ -f "$source_agent_dir/$file" ]]; then
    cp -- "$source_agent_dir/$file" "$agent_dir/$file"
    chmod 600 "$agent_dir/$file"
  fi
done
export PI_CODING_AGENT_DIR="$agent_dir"

# The reserve exceeds either selected model's context window, making Pi's
# threshold reachable immediately; a small kept tail exercises the exact cut.
cat >"$work/.pi/settings.json" <<'JSON'
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 1000000,
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
followup_prompt='FOLLOWUP_QUESTION: Without using any tools, retrieve the exact deployment colour from my first request. Reply exactly as REMEMBERED_COLOUR=<colour>. Do not ask me to repeat it.'

cd "$work"
run_pi "${model_args_array[@]}" \
  --approve \
  --no-extensions \
  --no-context-files --no-skills --no-prompt-templates --no-themes \
  --tools bash \
  --session-dir "$work/sessions" \
  --extension "$repo/src/extension.ts" \
  -p "$prompt"

session="$(find "$work/sessions" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
if [[ -z "$session" ]]; then
  echo "Pi completed the initial request without writing a session JSONL" >&2
  exit 1
fi
cp -- "$session" "$artifact_dir/session-after-tool-run.jsonl"
echo "initial session: $session"

# Resume the same persisted conversation in a separate user request; it does not
# restate TEAL-7, so a correct answer must come from the compacted context.
run_pi "${model_args_array[@]}" \
  --approve \
  --no-extensions \
  --no-context-files --no-skills --no-prompt-templates --no-themes \
  --tools bash \
  --session-dir "$work/sessions" \
  --session "$session" \
  --extension "$repo/src/extension.ts" \
  -p "$followup_prompt"

node "$repo/scripts/inspect-session.mjs" \
  "$session" "$opening_marker" "$followup_user_marker" "$followup_answer_marker"
if ! grep -q 'Cliff: mechanical .* compaction committed' "$artifact_dir/run.log"; then
  echo "session log lacks Cliff's committed-compaction receipt" >&2
  exit 1
fi
