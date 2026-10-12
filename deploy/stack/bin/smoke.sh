#!/usr/bin/env bash
# End-to-end smoke for an isolated CI stack using the Fixture Model and
# Fixture Projection Sink overlay: one Run + one Reminder through Temporal,
# then replays both workflow histories against the deployed image.
# Do NOT run on a stack that already serves real traffic: it swaps the model
# to the fixture. Requires CI=true; never use it for production verification.
set -euo pipefail
export AEEIS_STACK_SMOKE=1
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
: "${AEEIS_ACCESS_TOKEN:?stack.env must set AEEIS_ACCESS_TOKEN}"
: "${AEEIS_IMAGE:?deploy first: CI=true AEEIS_STACK_SMOKE=1 bin/deploy.sh --env-file stack.env}"
dc up -d --remove-orphans
wait_http http://127.0.0.1:4324/readyz "j.status==='ready'&&j.workerState==='RUNNING'" "worker readyz" 300
wait_http http://127.0.0.1:4323/readyz "j.status==='ready'" "api readyz" 180
out="$(mktemp)"; trap 'rm -f "$out"' EXIT
dc exec -T -e AEEIS_ACCESS_TOKEN -e AEEIS_SMOKE_TIMEOUT_MS api node scripts/smoke-stack.mjs | tee "$out"
run_id="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['run']['id'])" "$out")"
reminder_id="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['reminder']['id'])" "$out")"
"$STACK_DIR/bin/replay.sh" "$run_id" "aeeis-reminder-$reminder_id"
echo "stack smoke + replay passed"
