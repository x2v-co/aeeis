#!/usr/bin/env bash
# Build (or reuse) the AEEIS image for the checked-out commit, run the Temporal
# replay gate against it, start/upgrade the stack, wait for Worker readiness,
# promote the build to the Worker Deployment's Current Version, wait for API
# readiness, and only then record it in .current.env.
#   bin/deploy.sh                                   # build aeeis:<sha> from this checkout
#   AEEIS_DEPLOY_IMAGE=registry/aeeis:<sha> bin/deploy.sh --no-build
# Env: AEEIS_SKIP_REPLAY=1 (first deploy / emergency only), AEEIS_ALLOW_DIRTY=1.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
build=1; [[ "${1:-}" == "--no-build" ]] && build=0
sha="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
  [[ "${AEEIS_ALLOW_DIRTY:-0}" == 1 ]] || { echo "working tree is dirty; commit first (or AEEIS_ALLOW_DIRTY=1)" >&2; exit 2; }
  sha="$sha-dirty$(date +%s)"
fi
image="${AEEIS_DEPLOY_IMAGE:-aeeis:$sha}"
if (( build )); then
  # shellcheck disable=SC2086
  docker build ${AEEIS_DOCKER_BUILD_ARGS:-} -t "$image" "$REPO_DIR"
else
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
fi

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
    AEEIS_REPLAY_IMAGE="$image" "$STACK_DIR/bin/replay.sh" $ids >/dev/null
    echo "replay gate passed"
  else
    echo "replay gate: no histories yet (first deploy)"
  fi
fi

candidate="$STACK_DIR/.candidate.env"
( umask 077; printf 'AEEIS_IMAGE=%s\nAEEIS_BUILD_ID=%s\n' "$image" "$AEEIS_STACK-$sha" > "$candidate" )
set -a; . "$candidate"; set +a
env_args=(--env-file "$ENV_FILE" --env-file "$candidate")
echo "deploying $AEEIS_STACK image=$AEEIS_IMAGE build=$AEEIS_BUILD_ID queue=$AEEIS_TASK_QUEUE ns=${TEMPORAL_NAMESPACE:-aeeis}"
dc up -d --remove-orphans
wait_http http://127.0.0.1:4324/readyz "j.status==='ready'&&j.workerState==='RUNNING'&&j.buildId==='$AEEIS_BUILD_ID'" "worker readyz" 300
AEEIS_CURRENT_FILE="$candidate" "$STACK_DIR/bin/promote.sh"
wait_http http://127.0.0.1:4323/readyz "j.status==='ready'" "api readyz" 180
[[ -r "$CURRENT_FILE" ]] && cp -p "$CURRENT_FILE" "$STACK_DIR/.previous.env"
mv "$candidate" "$CURRENT_FILE"
env_args=(--env-file "$ENV_FILE" --env-file "$CURRENT_FILE")
echo "deployed $AEEIS_BUILD_ID (recorded in $(basename "$CURRENT_FILE"))"
dc ps --format '{{.Service}}\t{{.Status}}'
