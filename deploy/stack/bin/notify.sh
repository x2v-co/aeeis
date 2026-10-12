#!/usr/bin/env bash
# OnFailure handler. stdout/stderr go to the unit journal. Notification must
# never mask the original failure or fail hard if configuration/tools are absent.
notify() (
set -u
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${AEEIS_ENV_FILE:-$STACK_DIR/stack.env}"
if [[ -r "$env_file" ]]; then
  # shellcheck source=/dev/null
  . "$env_file"
else
  echo "aeeis notify: stack env unavailable; using inherited configuration" >&2
fi
instance="${1:-${AEEIS_STACK:-unknown}}"
unit="${MONITOR_UNIT:-aeeis backup/health ($instance)}"
result="${MONITOR_SERVICE_RESULT:-failed}"
host="$(hostname 2>/dev/null || printf unknown)"
message="AEEIS failure: $unit on $host (instance=$instance, result=$result)"
printf '%s\n' "$message"
if [[ -z "${AEEIS_NOTIFY_WEBHOOK:-}" ]]; then
  echo 'aeeis notify: AEEIS_NOTIFY_WEBHOOK unset; journal only'
  exit 0
fi
# Use JSON encoding rather than interpolating unit/host text into a payload.
if ! payload="$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$message")"; then
  echo 'aeeis notify: could not encode webhook payload' >&2
  exit 0
fi
if ! curl --silent --show-error --fail --connect-timeout 5 --max-time 15 \
  -H 'Content-Type: application/json' --data-binary "$payload" \
  "$AEEIS_NOTIFY_WEBHOOK" >/dev/null 2>&1; then
  echo 'aeeis notify: webhook delivery failed; see original failure in journal' >&2
fi
exit 0
)
# Even a broken env file or missing utility must leave this handler successful.
notify "$@" || echo 'aeeis notify: handler error; see original failure in journal' >&2
exit 0
