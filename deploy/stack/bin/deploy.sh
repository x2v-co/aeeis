#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Build (or reuse) the AEEIS image for the checked-out commit, run the Temporal
# replay gate against it, start/upgrade the stack, wait for Worker readiness,
# promote the build to the Worker Deployment's Current Version, wait for API
# readiness, and only then record it in .current.env.
#   bin/deploy.sh --env-file ./stack.env             # build aeeis:<sha> from this checkout
#   AEEIS_DEPLOY_IMAGE=registry/aeeis:<sha> bin/deploy.sh --env-file ./stack.env --no-build
# Env: AEEIS_SKIP_REPLAY=1 (first deploy / emergency only), AEEIS_ALLOW_DIRTY=1.
set -euo pipefail
build=1
deploy_env_file=
while (( $# )); do
  case "$1" in
    --env-file)
      [[ -n "${2:-}" && "$2" != --* ]] || { echo "--env-file requires a readable file path" >&2; exit 2; }
      deploy_env_file="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    *) echo "usage: $0 --env-file <path> [--no-build]" >&2; exit 2 ;;
  esac
done
[[ -n "$deploy_env_file" ]] || { echo "an explicit --env-file <path> is required; no default env file is selected" >&2; exit 2; }
[[ -f "$deploy_env_file" && -r "$deploy_env_file" ]] || { echo "--env-file must name a readable regular file" >&2; exit 2; }
AEEIS_ENV_FILE="$(cd "$(dirname "$deploy_env_file")" && pwd)/$(basename "$deploy_env_file")"
export AEEIS_ENV_FILE
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
# shellcheck source=_images.sh
. "$STACK_DIR/bin/_images.sh"
sha="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
  [[ "${AEEIS_ALLOW_DIRTY:-0}" == 1 ]] || { echo "working tree is dirty; commit first (or AEEIS_ALLOW_DIRTY=1)" >&2; exit 2; }
  sha="$sha-dirty$(date +%s)"
fi
image="${AEEIS_DEPLOY_IMAGE:-aeeis:$sha}"
# Fail missing production settings before building, pulling, or starting.
AEEIS_IMAGE="$image" AEEIS_BUILD_ID="$AEEIS_STACK-$sha" dc config --quiet
AEEIS_IMAGE="$image" AEEIS_BUILD_ID="$AEEIS_STACK-$sha" stack_guard
release_ref="${AEEIS_IMAGE_REGISTRY:+$AEEIS_IMAGE_REGISTRY/}$image"
if (( build )); then
  # shellcheck disable=SC2086
  docker build ${AEEIS_DOCKER_BUILD_ARGS:-} -t "$release_ref" "$REPO_DIR"
fi
# Preload EVERY rendered service image before any container can be replaced.
AEEIS_IMAGE="$image" AEEIS_BUILD_ID="$AEEIS_STACK-$sha" prepull_images
AEEIS_IMAGE="$image" AEEIS_BUILD_ID="$AEEIS_STACK-$sha" verify_images

# Replay gate: recent + running workflow histories must replay on the candidate.
if [[ "${AEEIS_SKIP_REPLAY:-0}" != 1 ]] && [[ -n "$(dc ps -q temporal 2>/dev/null)" ]]; then
  ids="$(temporal_cli workflow list --limit "${AEEIS_REPLAY_SAMPLE:-20}" --output json \
    | python3 -c 'import json,sys
raw=sys.stdin.read().strip()
items=json.loads(raw) if raw.startswith("[") else [json.loads(l) for l in raw.splitlines() if l.strip()]
for w in items:
    t=(w.get("type") or {}).get("name")
    if t in ("agentRunWorkflow","reminderWorkflow"): print(w["execution"]["workflowId"])' | sort -u)" \
    || { echo "replay gate: cannot list workflows; refusing to deploy (AEEIS_SKIP_REPLAY=1 to override)" >&2; exit 3; }
  if [[ -n "$ids" ]]; then
    echo "replay gate: $(wc -l <<<"$ids") histories against $image"
    # shellcheck disable=SC2086
    AEEIS_REPLAY_IMAGE="$release_ref" "$STACK_DIR/bin/replay.sh" $ids >/dev/null
    echo "replay gate passed"
  else
    echo "replay gate: no histories yet (first deploy)"
  fi
fi

candidate="$STACK_DIR/.candidate.env"
( umask 077; printf 'AEEIS_IMAGE=%s\nAEEIS_BUILD_ID=%s\n' "$image" "$AEEIS_STACK-$sha" > "$candidate" )
set -a
# shellcheck source=/dev/null
. "$candidate"
set +a
env_args=(--env-file "$ENV_FILE" --env-file "$candidate")
echo "deploying $AEEIS_STACK image=$AEEIS_IMAGE build=$AEEIS_BUILD_ID queue=$AEEIS_TASK_QUEUE ns=${TEMPORAL_NAMESPACE:-aeeis}"
stack_guard
verify_images
dc up -d --pull never
wait_http http://127.0.0.1:4324/readyz "j.status==='ready'&&j.workerState==='RUNNING'&&j.buildId==='$AEEIS_BUILD_ID'" "worker readyz" 300
AEEIS_CURRENT_FILE="$candidate" "$STACK_DIR/bin/promote.sh"
wait_http http://127.0.0.1:4323/readyz "j.status==='ready'" "api readyz" 180
[[ -r "$CURRENT_FILE" ]] && cp -p "$CURRENT_FILE" "$STACK_DIR/.previous.env"
mv "$candidate" "$CURRENT_FILE"
env_args=(--env-file "$ENV_FILE" --env-file "$CURRENT_FILE")
echo "deployed $AEEIS_BUILD_ID (recorded in $(basename "$CURRENT_FILE"))"
dc ps --format '{{.Service}}\t{{.Status}}'
