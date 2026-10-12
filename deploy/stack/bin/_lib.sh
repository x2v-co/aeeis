# Shared helpers for deploy/stack/bin/*.sh (sourced, not executed).
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$STACK_DIR/../.." && pwd)"
ENV_FILE="${AEEIS_ENV_FILE:-$STACK_DIR/stack.env}"
# Written by bin/deploy.sh only after a successful deploy: AEEIS_IMAGE and
# AEEIS_BUILD_ID of the running build (.previous.env keeps the one before).
CURRENT_FILE="${AEEIS_CURRENT_FILE:-$STACK_DIR/.current.env}"
[[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE (copy stack.env.example, chmod 600)" >&2; exit 2; }
set -a; . "$ENV_FILE"; [[ -r "$CURRENT_FILE" ]] && . "$CURRENT_FILE"; set +a
# The selected file is also the container env_file. Use an absolute path so
# callers can select it from any directory. STACK_ENV_FILE is not an AEEIS
# *_FILE secret (AEEIS_ENV_FILE would collide with AEEIS_ENV at startup).
export STACK_ENV_FILE="$ENV_FILE"
compose_files=(-f "$STACK_DIR/compose.yml")
if [[ "${AEEIS_STACK_SMOKE:-0}" == 1 && "${CI:-}" != true && "${CI:-}" != 1 ]]; then
  echo "fixture smoke is for isolated CI only (CI=true required)" >&2; exit 2
fi
[[ "${AEEIS_STACK_SMOKE:-0}" == 1 ]] && compose_files+=(-f "$STACK_DIR/compose.smoke.yml")
env_args=(--env-file "$ENV_FILE")
[[ -r "$CURRENT_FILE" ]] && env_args+=(--env-file "$CURRENT_FILE")
dc() { docker compose "${compose_files[@]}" "${env_args[@]}" "$@"; }
temporal_cli() { dc exec -T temporal temporal --address temporal:7233 --namespace "${TEMPORAL_NAMESPACE:-aeeis}" "$@"; }

# Probe a URL from inside the stack's shared network namespace (via the api
# container, which has node). The bearer token is passed by name (-e VAR), so
# it never appears in argv. Each request is bounded by an abort timeout.
wait_http() { # url predicate-json-expr label timeout_s
  local url="$1" expr="$2" label="$3" deadline=$(( $(date +%s) + ${4:-180} ))
  while (( $(date +%s) < deadline )); do
    if dc exec -T -e AEEIS_ACCESS_TOKEN api node -e "fetch('$url',{headers:{authorization:'Bearer '+(process.env.AEEIS_ACCESS_TOKEN||'')},signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(j=>process.exit(($expr)?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      echo "$label ok"; return 0
    fi
    sleep 2
  done
  echo "$label not ready after ${4:-180}s" >&2; return 1
}
