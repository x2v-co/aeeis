#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Make the running worker build the Current Version of its Worker Deployment.
# Versioned workers only receive tasks for the Current (or Ramping) version;
# without this step new workflows stay queued with no poller. Retries until
# Temporal reports the expected Current Version or the deadline passes.
set -euo pipefail
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
: "${AEEIS_BUILD_ID:?AEEIS_BUILD_ID missing (bin/deploy.sh sets it)}"
deployment="$AEEIS_TASK_QUEUE"
deadline=$(( $(date +%s) + ${AEEIS_PROMOTE_TIMEOUT_S:-180} ))
while (( $(date +%s) < deadline )); do
  if temporal_cli worker deployment describe-version --deployment-name "$deployment" --build-id "$AEEIS_BUILD_ID" >/dev/null 2>&1; then
    temporal_cli worker deployment set-current-version --deployment-name "$deployment" --build-id "$AEEIS_BUILD_ID" --yes >/dev/null 2>&1 || true
    current="$(temporal_cli worker deployment describe --name "$deployment" --output json 2>/dev/null \
      | python3 -c 'import json,sys
d=json.load(sys.stdin)
def find(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k.lower() in ("currentversionbuildid",) and isinstance(v,str): return v
            if k.lower() in ("currentversion","currentdeploymentversion") and isinstance(v,dict) and v.get("buildId"): return v["buildId"]
            r=find(v)
            if r: return r
    if isinstance(o,list):
        for v in o:
            r=find(v)
            if r: return r
print(find(d) or "")' 2>/dev/null || true)"
    if [[ "$current" == "$AEEIS_BUILD_ID" ]]; then
      echo "promoted $deployment -> $AEEIS_BUILD_ID"; exit 0
    fi
  fi
  sleep 3
done
echo "failed to promote $deployment -> $AEEIS_BUILD_ID within ${AEEIS_PROMOTE_TIMEOUT_S:-180}s" >&2
exit 1
