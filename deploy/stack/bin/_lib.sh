# shellcheck shell=bash
# Shared helpers for deploy/stack/bin/*.sh (sourced, not executed).
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$STACK_DIR/../.." && pwd)"
export REPO_DIR
ENV_FILE="${AEEIS_ENV_FILE:-$STACK_DIR/stack.env}"
[[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE (copy stack.env.example, chmod 600)" >&2; exit 2; }
requested_git_commit="${AEEIS_GIT_COMMIT:-}"
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
# Explicit shell/systemd settings win, followed by the selected env file.
# Keep this separate from release state so deploy cannot reuse the old SHA.
AEEIS_CONFIG_GIT_COMMIT="${requested_git_commit:-${AEEIS_GIT_COMMIT:-}}"
export AEEIS_STACK="${AEEIS_STACK:-aeeis-cn-prod}"
[[ "$AEEIS_STACK" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "invalid AEEIS_STACK" >&2; exit 2; }
# State is isolated even when drill and production use the same checkout.
CURRENT_FILE="${AEEIS_CURRENT_FILE:-$STACK_DIR/.current.$AEEIS_STACK.env}"
# shellcheck disable=SC2034
PREVIOUS_FILE="$STACK_DIR/.previous.$AEEIS_STACK.env"
# shellcheck disable=SC2034
CANDIDATE_FILE="$STACK_DIR/.candidate.$AEEIS_STACK.env"
# Read legacy state only with explicit ownership evidence. Old files without
# AEEIS_STACK may identify their stack by the '<stack>-<sha>' build ID prefix.
if [[ ! -r "$CURRENT_FILE" && -z "${AEEIS_CURRENT_FILE:-}" && -r "$STACK_DIR/.current.env" ]]; then
  # shellcheck source=/dev/null
  legacy_stack="$( ( unset AEEIS_BUILD_ID; . "$STACK_DIR/.current.env"; printf '%s' "${AEEIS_BUILD_ID:-}" ) )"
  legacy_stack="${legacy_stack%-dirty[0-9]*}"
  legacy_stack="${legacy_stack%-*}"
  # shellcheck source=/dev/null
  legacy_owner="$( ( unset AEEIS_STACK; . "$STACK_DIR/.current.env"; printf '%s' "${AEEIS_STACK:-}" ) )"
  if [[ "$legacy_owner" == "$AEEIS_STACK" || ( -z "$legacy_owner" && "$legacy_stack" == "$AEEIS_STACK" ) ]]; then
    CURRENT_FILE="$STACK_DIR/.current.env"
  fi
fi
if [[ -r "$CURRENT_FILE" ]]; then
  selected_stack="$AEEIS_STACK"
  # shellcheck source=/dev/null
  . "$CURRENT_FILE"
  [[ "$AEEIS_STACK" == "$selected_stack" ]] || { echo "state file stack mismatch: $CURRENT_FILE" >&2; exit 2; }
fi
set +a
# Resolve image metadata only after preload. Keep configured and recorded SHAs
# separate so a new deployment cannot inherit the previous release's SHA.
AEEIS_STATE_GIT_COMMIT="${AEEIS_GIT_COMMIT:-}"
for commit_var in AEEIS_CONFIG_GIT_COMMIT AEEIS_STATE_GIT_COMMIT; do
  if [[ "${!commit_var}" == unknown ]]; then printf -v "$commit_var" '%s' ''; fi
  [[ -z "${!commit_var}" || "${!commit_var}" =~ ^[a-fA-F0-9]{7,40}$ ]] || { echo "AEEIS_GIT_COMMIT must be a git SHA or unknown" >&2; exit 2; }
done
unset AEEIS_GIT_COMMIT

image_git_commit() {
  local ref="$1" revision tag
  revision="$(docker image inspect "$ref" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  if [[ "$revision" =~ ^[a-fA-F0-9]{7,40}$ ]]; then printf '%s' "$revision"; return; fi
  tag="${ref##*:}"
  if [[ "$ref" != *@* && "$tag" =~ ^([a-fA-F0-9]{7,40})(-dirty[0-9]+)?$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"; return
  fi
  return 0
}
resolve_git_commit() { # image-ref [use-recorded-state]
  local revision="${AEEIS_CONFIG_GIT_COMMIT:-}"
  if [[ -z "$revision" && "${2:-1}" == 1 ]]; then revision="${AEEIS_STATE_GIT_COMMIT:-}"; fi
  if [[ -z "$revision" ]]; then revision="$(image_git_commit "$1")"; fi
  unset AEEIS_GIT_COMMIT
  if [[ -n "$revision" ]]; then export AEEIS_GIT_COMMIT="$revision"; fi
}
# The selected file is also the container env_file. Use an absolute path so
# callers can select it from any directory. STACK_ENV_FILE is not an AEEIS
# *_FILE secret (AEEIS_ENV_FILE would collide with AEEIS_ENV at startup).
export STACK_ENV_FILE="$ENV_FILE"
export AEEIS_STACK="${AEEIS_STACK:-aeeis-cn-prod}"
export AEEIS_LEGACY_STACK="${AEEIS_LEGACY_STACK:-aeeis-cn}"
if [[ "${AEEIS_IMAGE_REGISTRY:-}" == */ ]]; then
  echo "AEEIS_IMAGE_REGISTRY must have no trailing slash" >&2; exit 2
fi
compose_files=(-f "$STACK_DIR/compose.yml")
if [[ "${AEEIS_STACK_SMOKE:-0}" == 1 && "${CI:-}" != true && "${CI:-}" != 1 ]]; then
  echo "fixture smoke is for isolated CI only (CI=true required)" >&2; exit 2
fi
[[ "${AEEIS_STACK_SMOKE:-0}" == 1 ]] && compose_files+=(-f "$STACK_DIR/compose.smoke.yml")
env_args=(--env-file "$ENV_FILE")
[[ -r "$CURRENT_FILE" ]] && env_args+=(--env-file "$CURRENT_FILE")
dc() {
  local files=("${compose_files[@]}")
  # Omit the environment override when metadata is unavailable, preserving
  # the image's own ENV rather than masking it with an empty/unknown value.
  if [[ -n "${AEEIS_GIT_COMMIT:-}" ]]; then files+=(-f "$STACK_DIR/compose.commit.yml"); fi
  docker compose -p "$AEEIS_STACK" "${files[@]}" "${env_args[@]}" "$@"
}
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

# Read-only preflight, before any build/up/stop. Inspect the rendered model so
# overrides and future named volumes/container_name settings are guarded too.
stack_guard() {
  if [[ "$AEEIS_STACK" == "$AEEIS_LEGACY_STACK" ]]; then
    echo "refusing legacy project $AEEIS_LEGACY_STACK; select a distinct AEEIS_STACK" >&2
    return 2
  fi
  local targets existing_volumes legacy_ids legacy_resources kind name owner
  targets="$(dc --profile '*' config --format json | python3 -c '
import json,sys
c=json.load(sys.stdin)
for v in c.get("volumes",{}).values(): print("V",v["name"])
for s in c["services"].values():
    if s.get("container_name"): print("C",s["container_name"])
    for m in s.get("volumes",[]):
        if m["type"]=="bind" and not m.get("read_only",False): print("B",m["source"])
')" || return 2
  existing_volumes="$(docker volume ls --format '{{.Name}}')" || return 2
  while read -r kind name; do
    [[ "$kind" == V ]] || continue
    if grep -Fxq -- "$name" <<<"$existing_volumes"; then
      owner="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$name")" || return 2
      if [[ -n "$owner" && "$owner" != '<no value>' && "$owner" != "$AEEIS_STACK" ]]; then
        echo "refusing volume $name: owned by Compose project $owner (target $AEEIS_STACK)" >&2
        return 2
      fi
    fi
  done <<<"$targets"
  legacy_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$AEEIS_LEGACY_STACK")" || return 2
  local id
  for id in $legacy_ids; do
    legacy_resources="$(docker inspect "$id" | python3 -c '
import json,sys
for c in json.load(sys.stdin):
    print("C",c["Name"].lstrip("/"))
    for m in c.get("Mounts",[]):
        if m["Type"]=="volume": print("V",m["Name"])
        elif m["Type"]=="bind": print("B",m["Source"])
')" || return 2
    while IFS= read -r name; do
      if grep -Fxq -- "$name" <<<"$legacy_resources"; then
        echo "refusing target $name: legacy container $id would be affected" >&2
        return 2
      fi
    done <<<"$targets"
  done
}
