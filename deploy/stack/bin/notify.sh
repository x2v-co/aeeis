#!/usr/bin/env bash
# OnFailure handler. stdout/stderr go to the unit journal. Notification must
# never mask the original failure or fail hard if configuration/tools are absent.
notify() (
set -uo pipefail
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
# Optional egress proxy: AEEIS_NOTIFY_PROXY, else first line of
# AEEIS_NOTIFY_PROXY_FILE (default /etc/notify-failure/proxy, the CN host proxy).
proxy="${AEEIS_NOTIFY_PROXY:-}"
proxy_file="${AEEIS_NOTIFY_PROXY_FILE:-/etc/notify-failure/proxy}"
if [[ -z "$proxy" && -r "$proxy_file" ]]; then
  proxy="$(head -n1 "$proxy_file" 2>/dev/null | tr -d '[:space:]"'"'"'' | sed 's/^[A-Za-z_]*=//')" || proxy=''
fi
curl_args=(--silent --show-error --fail --connect-timeout 5 --max-time 15)
[[ -z "$proxy" ]] || curl_args+=(--proxy "$proxy")
sent=0
if [[ -n "${AEEIS_NOTIFY_WEBHOOK:-}" ]]; then
  sent=1
  # Use JSON encoding rather than interpolating unit/host text into a payload.
  if ! payload="$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$message")"; then
    echo 'aeeis notify: could not encode webhook payload' >&2
  elif ! curl "${curl_args[@]}" \
    -H 'Content-Type: application/json' --data-binary "$payload" \
    "$AEEIS_NOTIFY_WEBHOOK" >/dev/null 2>&1; then
    echo 'aeeis notify: webhook delivery failed; see original failure in journal' >&2
  fi
fi
if [[ -n "${AEEIS_NOTIFY_TG_BOT_TOKEN:-}" && -n "${AEEIS_NOTIFY_TG_CHAT_ID:-}" ]]; then
  sent=1
  if ! payload="$(python3 -c 'import json,sys; print(json.dumps({"chat_id":sys.argv[2],"text":"[aeeis] "+sys.argv[1],"disable_web_page_preview":True}))' "$message" "$AEEIS_NOTIFY_TG_CHAT_ID")"; then
    echo 'aeeis notify: could not encode telegram payload' >&2
  # Token goes via a curl config on stdin so it never appears in argv.
  elif ! printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$AEEIS_NOTIFY_TG_BOT_TOKEN" \
    | curl "${curl_args[@]}" --config - -H 'Content-Type: application/json' \
      --data-binary "$payload" >/dev/null 2>&1; then
    echo 'aeeis notify: telegram delivery failed; see original failure in journal' >&2
  fi
fi
if (( sent == 0 )); then
  echo 'aeeis notify: AEEIS_NOTIFY_WEBHOOK unset; journal only'
fi
exit 0
)
# Even a broken env file or missing utility must leave this handler successful.
notify "$@" || echo 'aeeis notify: handler error; see original failure in journal' >&2
exit 0
