#!/usr/bin/env bash
# Temporal replay gate: export workflow histories from this stack and replay
# them against the workflow bundle in an image (default: the deployed one; set
# AEEIS_REPLAY_IMAGE to a candidate image before rolling it out).
#   bin/replay.sh <workflowId> [<workflowId> ...]
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
(( $# > 0 )) || { echo "usage: $0 <workflowId>..." >&2; exit 2; }
image="${AEEIS_REPLAY_IMAGE:-${AEEIS_IMAGE:?no AEEIS_IMAGE; set AEEIS_REPLAY_IMAGE}}"
umask 077
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
for id in "$@"; do
  temporal_cli workflow show --workflow-id "$id" --output json > "$dir/history.json"
  # Histories contain workflow inputs: keep them 0600 and read them as the
  # invoking uid, with no network.
  docker run --rm --network none --user "$(id -u):$(id -g)" -v "$dir:/histories:ro" \
    -e AEEIS_TEMPORAL_HISTORY_FILE=/histories/history.json -e AEEIS_TEMPORAL_WORKFLOW_ID="$id" \
    "$image" node scripts/replay-temporal-history.mjs 2>/dev/null | grep '"aeeis-temporal-replay/1"' || {
      echo "replay FAILED for $id on $image" >&2; exit 1; }
done
