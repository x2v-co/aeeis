#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# No daemon/network required: exercise the production entrypoints with Docker
# mocked on PATH. Also run from the normal unit-test suite.
set -euo pipefail
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
export FAKE_LOG="$test_dir/docker.log" FAKE_IMAGES="$test_dir/images"
export AEEIS_ENV_FILE="$test_dir/stack.env" AEEIS_CURRENT_FILE="$test_dir/no-current.env"
export AEEIS_ALLOW_DIRTY=1 AEEIS_SKIP_REPLAY=1 COMPOSE_PROJECT_NAME=aeeis-cn
cat > "$AEEIS_ENV_FILE" <<'ENV'
AEEIS_STACK=aeeis-cn-prod
AEEIS_TASK_QUEUE=aeeis-agent
AEEIS_IMAGE=aeeis:test
AEEIS_BUILD_ID=test
ENV
cat > "$test_dir/bin/docker" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\n')
images = Path(os.environ['FAKE_IMAGES'])
local = set(images.read_text().splitlines())
registry = os.getenv('AEEIS_IMAGE_REGISTRY', '')
prefix = registry + '/' if registry else ''
refs = [prefix + x for x in [os.getenv('AEEIS_IMAGE','aeeis:test'), 'alpine:3.20', 'postgres:17-alpine', os.getenv('AEEIS_TEMPORAL_IMAGE','temporalio/auto-setup:1.29.7')]]
mode = os.getenv('FAKE_MODE', '')
if args[0] == 'compose':
    assert '-p' in args and args[args.index('-p')+1] == os.getenv('AEEIS_STACK', 'aeeis-cn-prod'), args
    if 'config' in args:
        if '--images' in args:
            assert '--profile' in args and '*' in args, args
            print('\n'.join(refs + [refs[2]]))
        elif '--format' in args:
            print(json.dumps({'services': {'api': {'container_name': os.getenv('FAKE_TARGET_CONTAINER', 'new-api')}},
                              'volumes': {'pg': {'name': 'aeeis-cn-prod-postgres'}}}))
    sys.exit(0)
if args[:2] == ['volume', 'ls']:
    if mode == 'daemon-fail': sys.exit(1)
    if os.getenv('FAKE_VOLUME_OWNER'): print('aeeis-cn-prod-postgres')
elif args[:2] == ['volume', 'inspect']:
    print(os.environ['FAKE_VOLUME_OWNER'])
elif args[0] == 'ps':
    assert 'label=com.docker.compose.project=' + os.getenv('AEEIS_LEGACY_STACK', 'aeeis-cn') in args
    if os.getenv('FAKE_LEGACY'): print('old-id')
elif args[0] == 'inspect':
    name = 'aeeis-cn-prod-postgres' if os.getenv('FAKE_LEGACY') == 'shared' else 'old-postgres'
    print(json.dumps([{'Name': '/old-api', 'Mounts': [{'Type': 'volume', 'Name': name}]}]))
elif args[:2] == ['image', 'inspect']:
    sys.exit(0 if args[2] in local else 1)
elif args[0] == 'pull':
    ref = args[1]
    if mode == 'all-fail' or (mode == 'postgres-fail' and 'postgres:' in ref): sys.exit(1)
    if mode in ('registry-fail', 'mirror-fail') and registry and ref.startswith(registry + '/'): sys.exit(1)
    if mode == 'mirror-fail' and ref.startswith('m.daocloud.io/'): sys.exit(1)
    local.add(ref)
    images.write_text('\n'.join(sorted(local)) + '\n')
elif args[0] == 'tag':
    assert args[1] in local
    local.add(args[2])
    images.write_text('\n'.join(sorted(local)) + '\n')
elif args[0] == 'save':
    assert set(args[3:]) == set(refs), args
    Path(args[2]).write_text('\n'.join(args[3:]) + '\n')
elif args[0] == 'load':
    local.update(Path(args[2]).read_text().splitlines())
    images.write_text('\n'.join(sorted(local)) + '\n')
else:
    raise AssertionError(args)
PY
chmod +x "$test_dir/bin/docker"
export PATH="$test_dir/bin:$PATH"
reset_fake() {
  : > "$FAKE_LOG"; : > "$FAKE_IMAGES"
  unset FAKE_MODE FAKE_VOLUME_OWNER FAKE_LEGACY FAKE_TARGET_CONTAINER AEEIS_IMAGE_REGISTRY AEEIS_LEGACY_STACK
}
expect_failure() {
  if "$@" > "$test_dir/output" 2>&1; then echo "unexpected success: $*" >&2; exit 1; fi
}
no_container_mutation() {
  python3 - <<'PY'
import json,os
for a in map(json.loads, open(os.environ['FAKE_LOG'])):
    assert not (a[0] == 'compose' and any(x in a for x in ['up','stop','down','run','restart'])), a
    assert a[0] != 'build', a
PY
}
guard() { bash -euo pipefail -c '. "$1/bin/_lib.sh"; stack_guard' guard "$STACK_DIR"; }
deploy() { AEEIS_DEPLOY_IMAGE=aeeis:test "$STACK_DIR/bin/deploy.sh" --env-file "$AEEIS_ENV_FILE" --no-build; }
reset_fake
# Legacy name collision (including configurable legacy names).
sed -i 's/AEEIS_STACK=aeeis-cn-prod/AEEIS_STACK=aeeis-cn/' "$AEEIS_ENV_FILE"
expect_failure deploy
no_container_mutation
sed -i 's/AEEIS_STACK=aeeis-cn$/AEEIS_STACK=aeeis-cn-prod/' "$AEEIS_ENV_FILE"
export AEEIS_LEGACY_STACK=aeeis-cn-prod
expect_failure deploy
no_container_mutation
reset_fake
export FAKE_VOLUME_OWNER=another-project
expect_failure deploy
no_container_mutation
reset_fake
export FAKE_MODE=daemon-fail
expect_failure deploy
no_container_mutation
reset_fake
export FAKE_LEGACY=shared
expect_failure deploy
no_container_mutation
reset_fake
export FAKE_LEGACY=separate FAKE_TARGET_CONTAINER=old-api
expect_failure deploy
no_container_mutation
reset_fake
export FAKE_LEGACY=separate FAKE_VOLUME_OWNER=aeeis-cn-prod
guard
no_container_mutation
# Failed candidate or infrastructure pulls must never reach compose up/stop.
for mode in all-fail postgres-fail; do
  reset_fake
  export FAKE_MODE="$mode"
  expect_failure deploy
  no_container_mutation
  grep -q 'refusing deployment' "$test_dir/output"
done
# Explicit release/hop transport overrides beat stack.env and .current.env.
reset_fake
AEEIS_IMAGE=aeeis:override AEEIS_TEMPORAL_IMAGE=temporalio/auto-setup:1.25.2 \
  "$STACK_DIR/bin/images.sh" list > "$test_dir/list"
grep -Fxq 'aeeis:override' "$test_dir/list"
grep -Fxq 'temporalio/auto-setup:1.25.2' "$test_dir/list"
# Offline save/load uses all rendered image refs, including profiled services.
reset_fake
"$STACK_DIR/bin/images.sh" prepull > "$test_dir/output" 2>&1
"$STACK_DIR/bin/images.sh" save "$test_dir/stack.tar"
: > "$FAKE_IMAGES"
"$STACK_DIR/bin/images.sh" load "$test_dir/stack.tar" > "$test_dir/output" 2>&1
"$STACK_DIR/bin/images.sh" verify
# Local upstream preload is retagged for the registry without any pulls.
: > "$FAKE_LOG"
export AEEIS_IMAGE_REGISTRY=ccr.ccs.tencentyun.com/x2v-co
"$STACK_DIR/bin/images.sh" prepull
python3 - <<'PY'
import json,os
calls=list(map(json.loads,open(os.environ['FAKE_LOG'])))
assert not any(a[0]=='pull' for a in calls), calls
assert sum(a[0]=='tag' for a in calls)==4, calls
PY
# Registry -> mirror -> upstream fallback, canonical retagging, boot no-pull.
for mode in registry-fail mirror-fail; do
  reset_fake
  export AEEIS_IMAGE_REGISTRY=ccr.ccs.tencentyun.com/x2v-co FAKE_MODE="$mode"
  "$STACK_DIR/bin/stack.sh" start > "$test_dir/output" 2>&1
  python3 - <<'PY'
import json,os
calls=list(map(json.loads,open(os.environ['FAKE_LOG'])))
pulls=[a[1] for a in calls if a[0]=='pull']
expected=['ccr.ccs.tencentyun.com/x2v-co/aeeis:test','m.daocloud.io/docker.io/library/aeeis:test']
if os.environ['FAKE_MODE']=='mirror-fail': expected+=['aeeis:test']
assert pulls[:len(expected)]==expected, pulls
up=[a for a in calls if a[0]=='compose' and 'up' in a]
assert len(up)==1 and up[0][-2:]==['--pull','never'], up
assert sum(a[:2]==['image','inspect'] for a in calls[:calls.index(up[0])])>=4, calls
PY
done
# Load followed by a missing-image failure also fails closed.
reset_fake
printf 'aeeis:test\n' > "$test_dir/incomplete.tar"
export FAKE_MODE=all-fail
expect_failure "$STACK_DIR/bin/images.sh" load "$test_dir/incomplete.tar"
no_container_mutation
python3 - <<'PYTEST'
import json,os
assert not any(a[0]=='pull' for a in map(json.loads,open(os.environ['FAKE_LOG'])))
PYTEST
echo 'stack selftest: project/volume guards, pull failures, offline transport and registry fallback passed'
