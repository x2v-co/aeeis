#!/usr/bin/env bash
# OnFailure handler. stdout/stderr go to the unit journal. Notification must
# never mask the original failure. Feishu delivery errors return non-zero;
# the systemd unit ignores this status to preserve the original service failure.
notify() (
set -uo pipefail
# Keep unexpected handler errors (including exit in a sourced env) best effort.
# Normal completion removes this trap so Feishu failures reach the caller.
trap 'status=$?; if (( status != 0 )); then echo "aeeis notify: handler error; see original failure in journal" >&2; fi; exit 0' EXIT
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
# Optional Telegram egress proxy: AEEIS_NOTIFY_PROXY, else first line of
# AEEIS_NOTIFY_PROXY_FILE (default /etc/notify-failure/proxy, the CN host proxy).
proxy="${AEEIS_NOTIFY_PROXY:-}"
proxy_file="${AEEIS_NOTIFY_PROXY_FILE:-/etc/notify-failure/proxy}"
if [[ -z "$proxy" && -r "$proxy_file" ]]; then
  proxy="$(head -n1 "$proxy_file" 2>/dev/null | tr -d '[:space:]"'"'"'' | sed 's/^[A-Za-z_]*=//')" || proxy=''
fi
curl_args=(--silent --show-error --fail --connect-timeout 5 --max-time 15)
telegram_args=("${curl_args[@]}")
[[ -z "$proxy" ]] || telegram_args+=(--proxy "$proxy")
webhook_args=("${curl_args[@]}" --noproxy '*')
if [[ -n "${AEEIS_NOTIFY_WEBHOOK_PROXY:-}" ]]; then
  # Override inherited NO_PROXY too when a webhook proxy is explicitly chosen.
  webhook_args=("${curl_args[@]}" --noproxy '' --proxy "$AEEIS_NOTIFY_WEBHOOK_PROXY")
fi
sent=0
delivery_status=0
if [[ -n "${AEEIS_NOTIFY_WEBHOOK:-}" ]]; then
  sent=1
  format="${AEEIS_NOTIFY_FORMAT:-}"
  if [[ "$format" != feishu ]]; then
    # Parse the hostname, not the path or a substring of an unrelated host.
    format="$(python3 -c '
import sys
from urllib.parse import urlsplit
try:
    host = urlsplit(sys.stdin.read()).hostname
except ValueError:
    host = None
print("feishu" if host in ("open.feishu.cn", "open.larksuite.com") else "generic")
' <<< "$AEEIS_NOTIFY_WEBHOOK" 2>/dev/null)" || format=generic
  fi
  # Use JSON encoding rather than interpolating unit/host text into a payload.
  if ! payload="$(python3 -c '
import json,sys
text = sys.argv[1]
print(json.dumps({"msg_type":"text","content":{"text":text}} if sys.argv[2] == "feishu" else {"text":text}))
' "$message" "$format")"; then
    echo 'aeeis notify: could not encode webhook payload' >&2
    [[ "$format" != feishu ]] || delivery_status=1
  elif ! response="$(curl "${webhook_args[@]}" \
    -H 'Content-Type: application/json' --data-binary "$payload" \
    "$AEEIS_NOTIFY_WEBHOOK" 2>/dev/null)"; then
    echo 'aeeis notify: webhook delivery failed; see original failure in journal' >&2
    [[ "$format" != feishu ]] || delivery_status=1
  elif [[ "$format" == feishu ]] && ! python3 -c '
import json,sys
try:
    response = json.load(sys.stdin)
    code = response.get("code", response.get("StatusCode"))
    valid = type(code) is int and code == 0
except (ValueError, AttributeError):
    valid = False
sys.exit(0 if valid else 1)
' <<< "$response" 2>/dev/null; then
    # Never echo the response: it may contain webhook credentials or URLs.
    echo 'aeeis notify: feishu webhook response invalid or rejected (expected code=0 or StatusCode=0)' >&2
    delivery_status=1
  fi
fi
if [[ -n "${AEEIS_NOTIFY_TG_BOT_TOKEN:-}" && -n "${AEEIS_NOTIFY_TG_CHAT_ID:-}" ]]; then
  sent=1
  if ! payload="$(python3 -c 'import json,sys; print(json.dumps({"chat_id":sys.argv[2],"text":"[aeeis] "+sys.argv[1],"disable_web_page_preview":True}))' "$message" "$AEEIS_NOTIFY_TG_CHAT_ID")"; then
    echo 'aeeis notify: could not encode telegram payload' >&2
  # Token goes via a curl config on stdin so it never appears in argv.
  elif ! printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$AEEIS_NOTIFY_TG_BOT_TOKEN" \
    | curl "${telegram_args[@]}" --config - -H 'Content-Type: application/json' \
      --data-binary "$payload" >/dev/null 2>&1; then
    echo 'aeeis notify: telegram delivery failed; see original failure in journal' >&2
  fi
fi
if (( sent == 0 )); then
  echo 'aeeis notify: AEEIS_NOTIFY_WEBHOOK unset; journal only'
fi
trap - EXIT
exit "$delivery_status"
)
notify "$@"
