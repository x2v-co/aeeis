#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# With no IDs, check ALL Running AEEIS executions plus a recent closed sample.
# Explicit IDs are useful for incident replay. Every error fails closed.
set -euo pipefail
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
image="${AEEIS_REPLAY_IMAGE:-${AEEIS_IMAGE_REGISTRY:+$AEEIS_IMAGE_REGISTRY/}${AEEIS_IMAGE:?no AEEIS_IMAGE; set AEEIS_REPLAY_IMAGE}}"
umask 077
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
if (( $# == 0 )); then
  sample="${AEEIS_REPLAY_SAMPLE:-20}"
  [[ "$sample" =~ ^[1-9][0-9]*$ ]] || { echo 'replay gate: invalid AEEIS_REPLAY_SAMPLE' >&2; exit 2; }
  query='WorkflowType IN ("agentRunWorkflow", "reminderWorkflow")'
  echo "replay gate: listing ALL Running executions and up to $sample closed executions (stack=$AEEIS_STACK namespace=${TEMPORAL_NAMESPACE:-aeeis})"
  temporal_cli workflow list --query "$query AND ExecutionStatus=\"Running\"" --output json > "$dir/running.json" || {
    echo 'replay gate: cannot list Running workflows; refusing deployment' >&2; exit 3; }
  temporal_cli workflow list --query "$query AND ExecutionStatus!=\"Running\"" --limit "$sample" --output json > "$dir/closed.json" || {
    echo 'replay gate: cannot list closed workflows; refusing deployment' >&2; exit 3; }
  for group in running closed; do
    python3 "$STACK_DIR/bin/_workflow-list.py" < "$dir/$group.json" > "$dir/$group.ids" || {
      echo "replay gate: invalid $group workflow list; refusing deployment" >&2; exit 3; }
    echo "replay gate: $group executions=$(wc -l < "$dir/$group.ids")"
  done
  sort -u "$dir/running.ids" "$dir/closed.ids" > "$dir/executions"
else
  printf '%s\n' "$@" > "$dir/executions"
fi
count=0
while IFS=$'\t' read -r workflow_id run_id; do
  [[ -n "$workflow_id" ]] || continue
  args=(--workflow-id "$workflow_id")
  [[ -z "$run_id" ]] || args+=(--run-id "$run_id")
  echo "replay gate: checking workflow=$workflow_id run=${run_id:-latest} image=$image"
  temporal_cli workflow show "${args[@]}" --output json > "$dir/history.json" || {
    echo "replay gate: history export FAILED for $workflow_id" >&2; exit 1; }
  # Keep stderr and JSON evidence visible. pipefail propagates Docker failure
  # even when it printed a success-looking marker before exiting nonzero.
  if ! docker run --rm --network none --user "$(id -u):$(id -g)" -v "$dir:/histories:ro" \
    -e AEEIS_TEMPORAL_HISTORY_FILE=/histories/history.json -e AEEIS_TEMPORAL_WORKFLOW_ID="$workflow_id" \
    "$image" node scripts/replay-temporal-history.mjs | tee "$dir/result"; then
    echo "replay gate: replay FAILED for $workflow_id on $image" >&2; exit 1
  fi
  python3 - "$dir/result" "$workflow_id" <<'PY' || { echo "replay gate: missing valid success result for $workflow_id" >&2; exit 1; }
import json,sys
results=[]
for line in open(sys.argv[1]):
    try: value=json.loads(line)
    except json.JSONDecodeError: continue
    if isinstance(value,dict) and value.get('protocol')=='aeeis-temporal-replay/1': results.append(value)
assert len(results)==1 and results[0].get('status')=='passed' and results[0].get('workflowId')==sys.argv[2], results
PY
  count=$((count + 1))
done < "$dir/executions"
echo "replay gate: PASSED checked=$count image=$image (zero means no AEEIS histories found)"
