#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Build (or reuse) the AEEIS image for the checked-out commit, run the Temporal
# replay gate against it, start/upgrade the stack, wait for Worker readiness,
# promote the build to the Worker Deployment's Current Version, wait for API
# readiness, and only then record it in .current.<stack>.env.
#   bin/deploy.sh --env-file ./stack.env             # build aeeis:<sha> from this checkout
#   AEEIS_DEPLOY_IMAGE=registry/aeeis:<sha> bin/deploy.sh --env-file ./stack.env --no-build
# Env: AEEIS_ALLOW_DIRTY=1. Bootstrap Temporal before the first replay gate.
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
checkout_commit="$(git -C "$REPO_DIR" rev-parse HEAD)"
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
  export AEEIS_GIT_COMMIT="${AEEIS_CONFIG_GIT_COMMIT:-$checkout_commit}"
  # shellcheck disable=SC2086
  docker build ${AEEIS_DOCKER_BUILD_ARGS:-} --build-arg "AEEIS_GIT_COMMIT=$AEEIS_GIT_COMMIT" -t "$release_ref" "$REPO_DIR"
fi
# Preload EVERY rendered service image before any container can be replaced.
AEEIS_IMAGE="$image" AEEIS_BUILD_ID="$AEEIS_STACK-$sha" prepull_images
AEEIS_IMAGE="$image" AEEIS_BUILD_ID="$AEEIS_STACK-$sha" verify_images
if (( ! build )); then
  # The deployed image can differ from this checkout. Inspect after preload.
  export AEEIS_GIT_COMMIT="${AEEIS_CONFIG_GIT_COMMIT:-$(image_git_commit "$release_ref")}"
fi

# Always invoke the gate. Missing/unreachable Temporal, listing/export errors,
# malformed output and replay failure all block before replacing containers.
echo "replay gate: stack=$AEEIS_STACK namespace=${TEMPORAL_NAMESPACE:-aeeis} candidate=$release_ref"
AEEIS_REPLAY_IMAGE="$release_ref" "$STACK_DIR/bin/replay.sh"

candidate="$CANDIDATE_FILE"
( umask 077; printf 'AEEIS_STACK=%s\nAEEIS_IMAGE=%s\nAEEIS_BUILD_ID=%s\nAEEIS_GIT_COMMIT=%s\n' "$AEEIS_STACK" "$image" "$AEEIS_STACK-$sha" "$AEEIS_GIT_COMMIT" > "$candidate" )
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
[[ -r "$CURRENT_FILE" ]] && cp -p "$CURRENT_FILE" "$PREVIOUS_FILE"
CURRENT_FILE="${AEEIS_CURRENT_FILE:-$STACK_DIR/.current.$AEEIS_STACK.env}"
mv "$candidate" "$CURRENT_FILE"
env_args=(--env-file "$ENV_FILE" --env-file "$CURRENT_FILE")
echo "deployed $AEEIS_BUILD_ID (recorded in $(basename "$CURRENT_FILE"))"
dc ps --format '{{.Service}}\t{{.Status}}'
