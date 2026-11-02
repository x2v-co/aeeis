#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# No daemon/network required: exercise the production entrypoints with Docker
# mocked on PATH. Also run from the normal unit-test suite.
set -Eeuo pipefail
trap 'echo "selftest failed at line $LINENO: $BASH_COMMAND" >&2' ERR
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A root-run container may mount a checkout owned by the host user. Trust only
# this checkout for this test and its children; never change global Git config.
repo_dir="$(cd "$STACK_DIR/../.." && pwd)"
export "GIT_CONFIG_KEY_${GIT_CONFIG_COUNT:-0}=safe.directory"
export "GIT_CONFIG_VALUE_${GIT_CONFIG_COUNT:-0}=$repo_dir"
export GIT_CONFIG_COUNT="$((${GIT_CONFIG_COUNT:-0} + 1))"
for dependency in git python3; do
  if ! command -v "$dependency" >/dev/null; then
    echo "stack selftest: required dependency missing: $dependency" >&2
    exit 1
  fi
done
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
# Most entrypoints are captured here. Show their diagnostics before cleanup.
trap 'echo "selftest failed at line $LINENO: $BASH_COMMAND" >&2; if [[ -f "$test_dir/output" ]]; then cat "$test_dir/output" >&2; fi' ERR
mkdir -p "$test_dir/bin"
# Same repository root, isolated deploy state. Never write real release files.
selftest_stack="$(mktemp -d "$STACK_DIR/../.selftest.XXXXXX")"
trap 'rm -rf "$test_dir" "$selftest_stack"' EXIT
cp -a "$STACK_DIR/bin" "$STACK_DIR/systemd" "$STACK_DIR/compose.yml" "$STACK_DIR/compose.commit.yml" "$selftest_stack/"
STACK_DIR="$selftest_stack"
export FAKE_LOG="$test_dir/docker.log" FAKE_IMAGES="$test_dir/images" FAKE_STACK_DIR="$STACK_DIR"
export FAKE_RELEASE_LOG="$test_dir/releases.log"
export AEEIS_ENV_FILE="$test_dir/stack.env" AEEIS_CURRENT_FILE="$test_dir/no-current.env"
export AEEIS_ALLOW_DIRTY=1 COMPOSE_PROJECT_NAME=aeeis-cn
cat > "$AEEIS_ENV_FILE" <<'ENV'
AEEIS_STACK=aeeis-cn-prod
AEEIS_TASK_QUEUE=aeeis-agent
AEEIS_IMAGE=aeeis:test
AEEIS_BUILD_ID=test
ENV
cat > "$test_dir/bin/docker" <<'PY'
#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\n')
if args[0] == 'build' or (args[0] == 'compose' and 'up' in args):
    commit = os.getenv('AEEIS_GIT_COMMIT')
    if args[0] == 'compose':
        overrides = [a for a in args if a.endswith('/compose.commit.yml')]
        assert bool(overrides) == bool(commit), (args, commit)
        assert all(Path(a).is_file() for a in overrides), args
        assert commit != 'unknown', 'unknown must not mask the image environment'
    with open(os.environ['FAKE_RELEASE_LOG'], 'a') as f:
        f.write(json.dumps({'args': args, 'commit': commit,
                           'runtimeCommit': commit or os.getenv('FAKE_IMAGE_ENV_COMMIT')}) + '\n')
images = Path(os.environ['FAKE_IMAGES'])
local = set(images.read_text().splitlines())
registry = os.getenv('AEEIS_IMAGE_REGISTRY', '')
prefix = registry + '/' if registry else ''
refs = [prefix + x for x in [os.getenv('AEEIS_IMAGE','aeeis:test'), 'alpine:3.20', 'postgres:17-alpine', os.getenv('AEEIS_TEMPORAL_IMAGE','temporalio/auto-setup:1.29.7')]]
mode = os.getenv('FAKE_MODE', '')
if args[0] == 'compose':
    assert '-p' in args and args[args.index('-p')+1] == os.getenv('AEEIS_STACK', 'aeeis-cn-prod'), args
    if 'run' in args and '--help' in args:
        support = os.getenv('FAKE_COMPOSE_RUN_PULL', '1')
        print('Usage: docker compose run [OPTIONS] SERVICE [COMMAND] [ARGS...]')
        if support != '0': print('      --pull string    Pull image before running')
        sys.exit(42 if support == 'help-fail' else 0)
    elif 'config' in args:
        if '--images' in args:
            assert '--profile' in args and '*' in args, args
            print('\n'.join(refs + [refs[2]]))
        elif '--format' in args:
            print(json.dumps({'services': {'api': {'container_name': os.getenv('FAKE_TARGET_CONTAINER', 'new-api')}},
                              'volumes': {'pg': {'name': 'aeeis-cn-prod-postgres'}}}))
        if mode == 'config-fail': sys.exit(42)
    elif 'ps' in args and '-q' in args:
        print('temporal-id')
    elif 'workflow' in args and 'list' in args:
        if mode == 'list-fail': sys.exit(1)
        if mode == 'malformed': print('{bad'); sys.exit(0)
        if mode == 'empty-output': sys.exit(0)
        query = args[args.index('--query') + 1]
        running = 'ExecutionStatus="Running"' in query
        if running: assert '--limit' not in args, args
        rows = [{'type': {'name': 'agentRunWorkflow'}, 'execution': {'workflowId': 'run-' + str(i), 'runId': 'execution-' + str(i)}} for i in range(4)] if running and mode != 'no-histories' else []
        print(json.dumps(rows))
    elif 'workflow' in args and 'show' in args:
        if mode == 'export-fail': sys.exit(1)
        assert '--run-id' in args, args
        print('{"events": [{}]}')
    elif 'deployment' in args and 'describe' in args:
        print(json.dumps({'currentVersion': {'buildId': os.environ['AEEIS_BUILD_ID']}}))
    elif 'run' in args and args[-1] == 'backup':
        assert '--no-deps' in args, args
        if os.getenv('FAKE_COMPOSE_RUN_PULL', '1') == '1':
            assert '--pull' in args and args[args.index('--pull') + 1] == 'never', args
        else:
            assert '--pull' not in args, args
        if mode == 'backup-run-fail': sys.exit(42)
        env = dict(os.environ, AEEIS_BACKUP_ROOT=os.environ['AEEIS_BACKUP_DIR'],
                   AEEIS_POSTGRES_PASSWORD='test-aeeis', TEMPORAL_POSTGRES_PASSWORD='test-temporal',
                   PATH=str(Path(sys.argv[0]).parent / 'container') + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['sh', os.environ['FAKE_STACK_DIR'] + '/bin/pg-dump-all.sh'], env=env)
        if result.returncode: sys.exit(result.returncode)
        if mode == 'backup-corrupt':
            (Path(env['AEEIS_BACKUP_ROOT']) / env['BACKUP_STAMP'] / 'aeeis.dump').write_text('corrupt')
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
    if '--format' in args and args[2] in local: print(os.getenv('FAKE_REVISION', ''))
    sys.exit(0 if args[2] in local else 1)
elif args[0] == 'build':
    assert '--build-arg' in args and args[args.index('--build-arg')+1].startswith('AEEIS_GIT_COMMIT='), args
    local.add(args[args.index('-t')+1])
    images.write_text('\n'.join(sorted(local)) + '\n')
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
elif args[0] == 'run':
    workflow_id = next(x.split('=',1)[1] for x in args if x.startswith('AEEIS_TEMPORAL_WORKFLOW_ID='))
    if mode == 'no-marker': print('no replay evidence'); sys.exit(0)
    print(json.dumps({'protocol':'aeeis-temporal-replay/1', 'status':'passed', 'workflowId':workflow_id}))
    if mode == 'replay-fail':
        print('candidate replay nondeterminism', file=sys.stderr)
        sys.exit(1)
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
  : > "$FAKE_RELEASE_LOG"
  unset FAKE_MODE FAKE_VOLUME_OWNER FAKE_LEGACY FAKE_TARGET_CONTAINER FAKE_REVISION FAKE_IMAGE_ENV_COMMIT FAKE_COMPOSE_RUN_PULL AEEIS_IMAGE_REGISTRY AEEIS_LEGACY_STACK
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
# An explicit sed backup suffix works on BSD/macOS and GNU; EXIT removes backups.
sed -i.bak 's/AEEIS_STACK=aeeis-cn-prod/AEEIS_STACK=aeeis-cn/' "$AEEIS_ENV_FILE"
expect_failure deploy
no_container_mutation
sed -i.bak 's/AEEIS_STACK=aeeis-cn$/AEEIS_STACK=aeeis-cn-prod/' "$AEEIS_ENV_FILE"
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
# Valid-looking output must not hide a failed producer in either pipeline.
reset_fake
export FAKE_MODE=config-fail
expect_failure guard
expect_failure "$STACK_DIR/bin/images.sh" list
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
# Gate is exercised through deploy, including failure after a success marker.
for mode in list-fail malformed empty-output export-fail replay-fail no-marker; do
  reset_fake
  export FAKE_MODE="$mode"
  expect_failure deploy
  no_container_mutation
  grep -q 'replay gate:' "$test_dir/output"
  if [[ "$mode" == replay-fail ]]; then grep -q 'candidate replay nondeterminism' "$test_dir/output"; fi
done
reset_fake
deploy > "$test_dir/output" 2>&1
grep -q 'running executions=[[:space:]]*4$' "$test_dir/output"
grep -q 'PASSED checked=4' "$test_dir/output"
python3 - <<'PYTEST'
import json,os
calls=list(map(json.loads,open(os.environ['FAKE_LOG'])))
replays=[a for a in calls if a[0]=='run']
assert len(replays)==4, replays
assert all('aeeis:test' in a for a in replays), replays
up=next(a for a in calls if a[0]=='compose' and 'up' in a)
assert all(calls.index(a)<calls.index(up) for a in replays)
PYTEST
reset_fake
export FAKE_MODE=no-histories
deploy > "$test_dir/output" 2>&1
grep -q 'PASSED checked=0' "$test_dir/output"
# Per-stack selection and backward-compatible legacy reads.
unset AEEIS_CURRENT_FILE
printf 'AEEIS_STACK=aeeis-cn-prod\nAEEIS_IMAGE=aeeis:legacy\nAEEIS_BUILD_ID=aeeis-cn-prod-old\n' > "$STACK_DIR/.current.env"
read_image() { bash -euo pipefail -c '. "$1/bin/_lib.sh"; printf "%s\n" "$AEEIS_IMAGE"' image "$STACK_DIR"; }
[[ "$(read_image)" == aeeis:legacy ]]
printf 'AEEIS_IMAGE=aeeis:legacy-prefix\nAEEIS_BUILD_ID=aeeis-cn-prod-old\n' > "$STACK_DIR/.current.env"
[[ "$(read_image)" == aeeis:legacy-prefix ]]
sed -i.bak 's/AEEIS_STACK=aeeis-cn-prod/AEEIS_STACK=aeeis-drill/' "$AEEIS_ENV_FILE"
[[ "$(read_image)" == aeeis:test ]]
reset_fake
deploy > "$test_dir/output" 2>&1
[[ -r "$STACK_DIR/.current.aeeis-drill.env" ]]
[[ ! -e "$STACK_DIR/.candidate.aeeis-drill.env" ]]
[[ "$(read_image)" == aeeis:test ]]
sed -i.bak 's/AEEIS_STACK=aeeis-drill/AEEIS_STACK=aeeis-cn-prod/' "$AEEIS_ENV_FILE"
[[ "$(read_image)" == aeeis:legacy-prefix ]]
reset_fake
deploy > "$test_dir/output" 2>&1
[[ -r "$STACK_DIR/.current.aeeis-cn-prod.env" ]]
grep -q 'aeeis:legacy-prefix' "$STACK_DIR/.previous.aeeis-cn-prod.env"
[[ -r "$STACK_DIR/.current.aeeis-drill.env" ]]
# New keyed state takes precedence over legacy, including a different image.
sed -i.bak 's/AEEIS_IMAGE=aeeis:test/AEEIS_IMAGE=aeeis:prod/' "$STACK_DIR/.current.aeeis-cn-prod.env"
[[ "$(read_image)" == aeeis:prod ]]
sed -i.bak 's/AEEIS_STACK=aeeis-cn-prod/AEEIS_STACK=aeeis-drill/' "$AEEIS_ENV_FILE"
[[ "$(read_image)" == aeeis:test ]]
echo 'stack selftest: project/volume guards, pull failures, offline transport, registry fallback, replay gate and stack state isolation passed'

# Release identity: explicit shell > selected env file > image label > hex tag.
# The old state SHA must never leak into a new --no-build deployment.
reset_fake
export FAKE_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
deploy > "$test_dir/output" 2>&1
grep -Fxq "AEEIS_GIT_COMMIT=$FAKE_REVISION" "$STACK_DIR/.current.aeeis-drill.env"
python3 - <<'PY'
import json,os
calls=list(map(json.loads,open(os.environ['FAKE_RELEASE_LOG'])))
assert calls and all(c['commit']==os.environ['FAKE_REVISION'] for c in calls), calls
docker_calls=list(map(json.loads,open(os.environ['FAKE_LOG'])))
pull=next(i for i,a in enumerate(docker_calls) if a[:2]==['pull','m.daocloud.io/docker.io/library/aeeis:test'])
metadata=[i for i,a in enumerate(docker_calls) if a[:3]==['image','inspect','aeeis:test'] and '--format' in a]
assert metadata and all(i>pull for i in metadata), docker_calls
PY
reset_fake
AEEIS_DEPLOY_IMAGE=aeeis:bbbbbbb "$STACK_DIR/bin/deploy.sh" --env-file "$AEEIS_ENV_FILE" --no-build > "$test_dir/output" 2>&1
grep -Fxq 'AEEIS_GIT_COMMIT=bbbbbbb' "$STACK_DIR/.current.aeeis-drill.env"
printf 'AEEIS_GIT_COMMIT=ccccccc\n' >> "$AEEIS_ENV_FILE"
reset_fake
export FAKE_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
deploy > "$test_dir/output" 2>&1
grep -Fxq 'AEEIS_GIT_COMMIT=ccccccc' "$STACK_DIR/.current.aeeis-drill.env"
AEEIS_GIT_COMMIT=ddddddd deploy > "$test_dir/output" 2>&1
grep -Fxq 'AEEIS_GIT_COMMIT=ddddddd' "$STACK_DIR/.current.aeeis-drill.env"
sed -i.bak '/^AEEIS_GIT_COMMIT=/d' "$AEEIS_ENV_FILE"
reset_fake
"$STACK_DIR/bin/deploy.sh" --env-file "$AEEIS_ENV_FILE" > "$test_dir/output" 2>&1
FAKE_EXPECT_COMMIT="$(git -C "$STACK_DIR/../.." rev-parse HEAD)"
export FAKE_EXPECT_COMMIT
python3 - <<'PY'
import json,os
calls=list(map(json.loads,open(os.environ['FAKE_RELEASE_LOG'])))
build=next(c for c in calls if c['args'][0]=='build')
assert 'AEEIS_GIT_COMMIT='+os.environ['FAKE_EXPECT_COMMIT'] in build['args'], build
assert all(c['commit']==os.environ['FAKE_EXPECT_COMMIT'] for c in calls), calls
PY
"$STACK_DIR/bin/stack.sh" start > "$test_dir/output" 2>&1
python3 - <<'PY'
import json,os
assert list(map(json.loads,open(os.environ['FAKE_RELEASE_LOG'])))[-1]['commit']==os.environ['FAKE_EXPECT_COMMIT']
PY
echo 'stack selftest: git commit build, label/tag fallback, env precedence and restart persistence passed'

# Boot without recorded state or a local image must inspect metadata after pull.
reset_fake
export FAKE_REVISION=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
AEEIS_CURRENT_FILE="$test_dir/startup-without-state.env" "$STACK_DIR/bin/stack.sh" start > "$test_dir/output" 2>&1
python3 - <<'PY'
import json,os
calls=list(map(json.loads,open(os.environ['FAKE_LOG'])))
pull=next(i for i,a in enumerate(calls) if a[:2]==['pull','m.daocloud.io/docker.io/library/aeeis:test'])
metadata=[i for i,a in enumerate(calls) if a[:3]==['image','inspect','aeeis:test'] and '--format' in a]
assert metadata and all(i>pull for i in metadata), calls
release=list(map(json.loads,open(os.environ['FAKE_RELEASE_LOG'])))
assert len(release)==1 and release[0]['commit']==os.environ['FAKE_REVISION'], release
PY
# No OCI label or hex tag: retain the image ENV, including when old config says unknown.
reset_fake
export FAKE_IMAGE_ENV_COMMIT=ffffffffffffffffffffffffffffffffffffffff
AEEIS_GIT_COMMIT=unknown AEEIS_CURRENT_FILE="$test_dir/startup-without-state.env" \
  "$STACK_DIR/bin/stack.sh" start > "$test_dir/output" 2>&1
AEEIS_GIT_COMMIT=unknown deploy > "$test_dir/output" 2>&1
if grep -q '^AEEIS_GIT_COMMIT=' "$STACK_DIR/.current.aeeis-drill.env"; then
  echo 'unknown commit must not override the image environment' >&2
  exit 1
fi
python3 - <<'PY'
import json,os
release=list(map(json.loads,open(os.environ['FAKE_RELEASE_LOG'])))
assert len(release)==2 and all(c['commit'] is None for c in release), release
assert all(c['runtimeCommit']==os.environ['FAKE_IMAGE_ENV_COMMIT'] for c in release), release
PY
echo 'stack selftest: post-pull startup metadata and unlabeled image environment preservation passed'

# Run the real backup entrypoints with fake Docker and PostgreSQL clients.
# The backup container has mv -T; macOS does not. Preserve its atomic rename
# semantics on the same filesystem, only on the fake container's PATH.
mkdir -p "$test_dir/bin/container"
if [[ "$(uname -s)" == Darwin ]]; then
  cat > "$test_dir/bin/container/mv" <<'PY'
#!/usr/bin/env python3
import os, sys
assert len(sys.argv) == 4 and sys.argv[1] == '-T', sys.argv
# Never treat an existing directory as a destination to move inside.
if os.path.isdir(sys.argv[3]):
    raise IsADirectoryError(sys.argv[3])
os.replace(sys.argv[2], sys.argv[3])
PY
  chmod +x "$test_dir/bin/container/mv"
  printf 'old\n' > "$test_dir/move-target"
  printf 'replacement\n' > "$test_dir/move-source"
  "$test_dir/bin/container/mv" -T "$test_dir/move-source" "$test_dir/move-target"
  grep -Fxq replacement "$test_dir/move-target"
  test ! -e "$test_dir/move-source"
  mkdir "$test_dir/move-directory"
  expect_failure "$test_dir/bin/container/mv" -T "$test_dir/move-target" "$test_dir/move-directory"
  grep -Fxq replacement "$test_dir/move-target"
  test ! -e "$test_dir/move-directory/move-target"
  mkdir "$test_dir/move-source-directory"
  expect_failure "$test_dir/bin/container/mv" -T "$test_dir/move-source-directory" "$test_dir/move-directory"
  test -d "$test_dir/move-source-directory"
  test ! -e "$test_dir/move-directory/move-source-directory"
fi
export FAKE_PG_LOG="$test_dir/pg.log"
cat > "$test_dir/bin/pg_dump" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
command = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['FAKE_PG_LOG'], 'a') as f:
    f.write(json.dumps([command] + args) + '\n')
root = Path(os.environ['AEEIS_BACKUP_ROOT'])
assert not (root / os.environ['BACKUP_STAMP']).exists(), 'published before validation'
mode = os.getenv('FAKE_MODE', '')
if command == 'pg_dump':
    assert '-Fc' in args and '--no-owner' in args, args
    db = args[args.index('-d') + 1]
    host = args[args.index('-h') + 1]
    user = args[args.index('-U') + 1]
    expected = ('postgres', 'aeeis', 'test-aeeis') if db == 'aeeis' else ('temporal-postgres', 'temporal', 'test-temporal')
    assert (host, user, os.environ['PGPASSWORD']) == expected
    assert db in ('aeeis', 'temporal', 'temporal_visibility'), args
    Path(args[args.index('-f') + 1]).write_text('archive ' + db)
    if mode == 'dump-fail' and db == 'temporal': sys.exit(43)
else:
    assert args[0] == '--list' and Path(args[1]).read_text().startswith('archive '), args
    if mode == 'restore-fail': sys.exit(44)
PY
chmod +x "$test_dir/bin/pg_dump"
ln -s pg_dump "$test_dir/bin/pg_restore"
no_service_changes() {
  python3 - <<'PY'
import json,os
calls = list(map(json.loads, open(os.environ['FAKE_LOG'])))
assert not any(a[0] == 'compose' and any(x in a for x in ['stop','down','up','restart','start']) for a in calls), calls
PY
}
reset_backup() {
  reset_fake
  : > "$FAKE_PG_LOG"
  export AEEIS_BACKUP_DIR="$test_dir/backups with spaces"
  rm -rf "$AEEIS_BACKUP_DIR"
  mkdir -p "$AEEIS_BACKUP_DIR/20000101T000000Z"
  python3 - "$AEEIS_BACKUP_DIR/20000101T000000Z" <<'PY'
import os, sys, time
old = time.time() - 30 * 24 * 60 * 60
os.utime(sys.argv[1], (old, old))
PY
}
reset_backup
# A legacy quiesce setting must not cause an outage.
export AEEIS_BACKUP_QUIESCE=full AEEIS_BACKUP_KEEP_DAYS=14
export FAKE_COMPOSE_RUN_PULL=1
"$STACK_DIR/bin/backup.sh" > "$test_dir/output" 2>&1
no_service_changes
python3 - <<'PY'
import json,os,stat
from pathlib import Path
root = Path(os.environ['AEEIS_BACKUP_DIR'])
backups = list(root.iterdir())
assert len(backups) == 1 and backups[0].name != '20000101T000000Z', backups
assert stat.S_IMODE(backups[0].stat().st_mode) == 0o700
assert {p.name for p in backups[0].iterdir()} == {'aeeis.dump','temporal.dump','temporal_visibility.dump','SHA256SUMS'}
calls = list(map(json.loads, open(os.environ['FAKE_PG_LOG'])))
assert [a[a.index('-d')+1] for a in calls if a[0]=='pg_dump'] == ['aeeis','temporal','temporal_visibility'], calls
assert sum(a[0]=='pg_restore' for a in calls) == 3, calls
docker_calls = list(map(json.loads, open(os.environ['FAKE_LOG'])))
assert any(a[0] == 'compose' and a[-2:] == ['run', '--help'] for a in docker_calls), docker_calls
runs = [a for a in docker_calls if a[0] == 'compose' and 'run' in a and a[-1] == 'backup']
assert len(runs) == 1 and runs[0][runs[0].index('--pull') + 1] == 'never', runs
PY
# Older Compose, or a failed help probe, must still complete the backup.
for support in 0 help-fail; do
  reset_backup
  export FAKE_COMPOSE_RUN_PULL="$support"
  "$STACK_DIR/bin/backup.sh" > "$test_dir/output" 2>&1
  no_service_changes
  python3 - <<'PY'
import json,os
calls = list(map(json.loads, open(os.environ['FAKE_LOG'])))
assert any(a[0] == 'compose' and a[-2:] == ['run', '--help'] for a in calls), calls
runs = [a for a in calls if a[0] == 'compose' and 'run' in a and a[-1] == 'backup']
assert len(runs) == 1 and '--pull' not in runs[0], runs
PY
done
# No partial final directory or temp files; failures must not prune old backups.
for mode in backup-run-fail dump-fail restore-fail; do
  reset_backup
  export FAKE_MODE="$mode"
  expect_failure "$STACK_DIR/bin/backup.sh"
  no_service_changes
  python3 - <<'PY'
import os
from pathlib import Path
assert [p.name for p in Path(os.environ['AEEIS_BACKUP_DIR']).iterdir()] == ['20000101T000000Z']
PY
done
# The host rechecks hashes before retention/upload, even after container success.
reset_backup
export FAKE_MODE=backup-corrupt
expect_failure "$STACK_DIR/bin/backup.sh"
no_service_changes
test -d "$AEEIS_BACKUP_DIR/20000101T000000Z"
reset_backup
export AEEIS_BACKUP_UPLOAD_CMD='exit 45'
expect_failure "$STACK_DIR/bin/backup.sh"
no_service_changes
unset AEEIS_BACKUP_UPLOAD_CMD AEEIS_BACKUP_QUIESCE

# Notification tests stub curl completely: no Feishu/Telegram network requests.
export FAKE_CURL_LOG="$test_dir/curl.json"
cat > "$test_dir/bin/curl" <<'CURL'
#!/usr/bin/env python3
import json,os,sys
args = sys.argv[1:]
assert args[args.index('--connect-timeout')+1] == '5'
assert args[args.index('--max-time')+1] == '15'
assert '--fail' in args
assert args[args.index('-H')+1] == 'Content-Type: application/json'
payload = json.loads(args[args.index('--data-binary')+1])
telegram = '--config' in args
if telegram:
    assert args[args.index('--config')+1] == '-'
    config = sys.stdin.read()
    assert config.startswith('url = "https://api.telegram.org/bot')
    assert config.endswith('/sendMessage"\n')
else:
    # Assert routing without recording the webhook URL in the test log.
    assert args[-1] == os.environ['FAKE_WEBHOOK_EXPECTED']
    args[-1] = '<webhook>'
with open(os.environ['FAKE_CURL_LOG'], 'a') as f:
    f.write(json.dumps({'kind': 'telegram' if telegram else 'webhook',
                        'args': args, 'payload': payload}) + '\n')
if not telegram:
    # Also check that curl/response diagnostics cannot leak into the journal.
    print('private curl diagnostic', file=sys.stderr)
    print(os.getenv('FAKE_CURL_RESPONSE', '{"code":0}'))
sys.exit(0 if telegram else int(os.getenv('FAKE_CURL_EXIT', '0')))
CURL
chmod +x "$test_dir/bin/curl"
python3 - <<'NOTIFY'
import json, os, subprocess
from pathlib import Path

log = Path(os.environ['FAKE_CURL_LOG'])
root = log.parent
entrypoint = str(Path(os.environ['FAKE_STACK_DIR']) / 'bin/notify.sh')
config = root / 'notify.conf'
config.write_text('')
proxy_file = root / 'notify-proxy'
proxy_file.write_text('PROXY=http://127.0.0.1:9\n')
# Isolate from real inherited notification settings, including credentials.
base = {k: v for k, v in os.environ.items()
        if not k.startswith(('AEEIS_NOTIFY_', 'MONITOR_', 'FAKE_CURL_'))}
base.update(AEEIS_ENV_FILE=str(config), FAKE_CURL_LOG=str(log),
            AEEIS_NOTIFY_PROXY_FILE=str(root / 'no-proxy'),
            MONITOR_UNIT='unit "quoted"\nbackslash\\中文',
            MONITOR_SERVICE_RESULT='exit-code',
            HTTP_PROXY='http://127.0.0.1:8', HTTPS_PROXY='http://127.0.0.1:8',
            ALL_PROXY='http://127.0.0.1:8', NO_PROXY='*')
webhook = 'http://127.0.0.1:1/selftest'

def run(*, target=webhook, expected_target=None, response='{"code":0}', status=0, **settings):
    log.unlink(missing_ok=True)
    env = dict(base, AEEIS_NOTIFY_WEBHOOK=target,
               FAKE_WEBHOOK_EXPECTED=expected_target or target,
               FAKE_CURL_RESPONSE=response)
    env.update(settings)
    result = subprocess.run([entrypoint, 'aeeis-cn-prod'], env=env,
                            text=True, capture_output=True, timeout=5)
    assert result.returncode == status, (result.returncode, result.stderr)
    # Responses and curl diagnostics must never be included in output.
    assert 'private curl diagnostic' not in result.stdout + result.stderr
    assert 'private response diagnostic' not in result.stdout + result.stderr
    if target:
        assert target not in result.stdout + result.stderr
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return result, calls

def direct(call):
    args = call['args']
    assert args[args.index('--noproxy')+1] == '*'
    assert '--proxy' not in args

result, calls = run(target='')
assert 'journal only' in result.stdout and calls == []
# The protected stack configuration still overrides inherited configuration.
config.write_text('AEEIS_NOTIFY_WEBHOOK=' + webhook + '\n')
result, calls = run(target='http://127.0.0.1:1/inherited', expected_target=webhook,
                    AEEIS_NOTIFY_PROXY='http://127.0.0.1:7')
assert len(calls) == 1
assert set(calls[0]['payload']) == {'text'}
assert base['MONITOR_UNIT'] in calls[0]['payload']['text']
assert 'result=exit-code' in calls[0]['payload']['text']
direct(calls[0])
config.write_text('')
# Generic receivers keep their existing payload and best-effort semantics.
_, calls = run(response='not JSON')
direct(calls[0])
result, _ = run(FAKE_CURL_EXIT='22')
assert 'webhook delivery failed' in result.stderr
# Both official hostnames are detected; uppercase hosts/ports are URL parsed.
# These are fabricated endpoints consumed only by the stub above.
for target in ('http://open.feishu.cn:1/selftest',
               'http://OPEN.LARKSUITE.COM:1/selftest', webhook):
    settings = {'AEEIS_NOTIFY_FORMAT': 'feishu'} if target == webhook else {}
    _, calls = run(target=target, AEEIS_NOTIFY_PROXY='http://127.0.0.1:7', **settings)
    assert len(calls) == 1
    assert set(calls[0]['payload']) == {'msg_type', 'content'}
    assert calls[0]['payload']['msg_type'] == 'text'
    assert set(calls[0]['payload']['content']) == {'text'}
    assert base['MONITOR_UNIT'] in calls[0]['payload']['content']['text']
    direct(calls[0])
# Host-like text in a path or a different domain must remain generic.
for target in ('http://127.0.0.1:1/open.feishu.cn',
               'http://open.feishu.cn.localhost:1/selftest',
               'http://open.feishu.cn@127.0.0.1:1/selftest'):
    _, calls = run(target=target)
    assert set(calls[0]['payload']) == {'text'}
# Explicit webhook proxy overrides even NO_PROXY='*', independently of TG.
_, calls = run(AEEIS_NOTIFY_FORMAT='feishu',
               AEEIS_NOTIFY_PROXY='http://127.0.0.1:7',
               AEEIS_NOTIFY_WEBHOOK_PROXY='http://127.0.0.1:6')
args = calls[0]['args']
assert args[args.index('--proxy')+1] == 'http://127.0.0.1:6'
assert args[args.index('--noproxy')+1] == ''
# Feishu's alternate success key is supported; malformed/error replies fail.
run(AEEIS_NOTIFY_FORMAT='feishu', response='{"StatusCode":0}')
for response in ('{"code":19024,"msg":"private response diagnostic"}',
                 '{"StatusCode":1}', '{}', 'not JSON', '[]', 'null',
                 '{"code":false}', '{"code":"0"}'):
    result, _ = run(AEEIS_NOTIFY_FORMAT='feishu', response=response, status=1)
    assert 'feishu webhook response invalid or rejected' in result.stderr
result, _ = run(AEEIS_NOTIFY_FORMAT='feishu', FAKE_CURL_EXIT='22', status=1)
assert 'webhook delivery failed' in result.stderr
# A failed Feishu request still delivers Telegram using its existing proxy.
tg = {'AEEIS_NOTIFY_TG_BOT_TOKEN': 'fake-selftest-token',
      'AEEIS_NOTIFY_TG_CHAT_ID': 'fake-chat'}
for failure in ({'response': '{"code":1}'}, {'FAKE_CURL_EXIT': '22'}):
    _, calls = run(AEEIS_NOTIFY_FORMAT='feishu', status=1,
                   AEEIS_NOTIFY_PROXY='http://127.0.0.1:7', **tg, **failure)
    assert [c['kind'] for c in calls] == ['webhook', 'telegram']
    direct(calls[0])
    args = calls[1]['args']
    assert args[args.index('--proxy')+1] == 'http://127.0.0.1:7'
    assert '--noproxy' not in args
    assert calls[1]['payload']['chat_id'] == 'fake-chat'
    assert calls[1]['payload']['text'].startswith('[aeeis] AEEIS failure:')
    assert base['MONITOR_UNIT'] in calls[1]['payload']['text']
    assert calls[1]['payload']['disable_web_page_preview'] is True
# Telegram alone also retains proxy-file fallback.
_, calls = run(target='', AEEIS_NOTIFY_PROXY_FILE=str(proxy_file), **tg)
assert len(calls) == 1 and calls[0]['kind'] == 'telegram'
args = calls[0]['args']
assert args[args.index('--proxy')+1] == 'http://127.0.0.1:9'
assert '--noproxy' not in args
# Absent/broken config remains best effort.
result, _ = run(target='', AEEIS_ENV_FILE=str(root / 'missing-notify.conf'))
assert 'stack env unavailable' in result.stderr
config.write_text('exit 99\n')
result, calls = run(target='')
assert 'handler error' in result.stderr and calls == []
NOTIFY

# Execute the unit shell commands with an overridden checkout containing spaces.
# This also checks that all commands cd into the configured deploy directory.
export FAKE_UNIT_DIR="$test_dir/custom deploy"
mkdir -p "$FAKE_UNIT_DIR/bin"
cat > "$FAKE_UNIT_DIR/bin/probe" <<'SH'
#!/bin/sh
test "$PWD" = "$AEEIS_DEPLOY_DIR" || exit 1
printf '%s\n' "$0 $*" >> "$AEEIS_DEPLOY_DIR/commands"
SH
chmod +x "$FAKE_UNIT_DIR/bin/probe"
for entrypoint in backup health notify stack; do
  ln -s probe "$FAKE_UNIT_DIR/bin/$entrypoint.sh"
done
printf 'AEEIS_BIND_IP=100.64.0.1\n' > "$FAKE_UNIT_DIR/stack.env"
printf '#!/bin/sh\nprintf "inet 100.64.0.1/32\\n"\n' > "$test_dir/bin/ip"
chmod +x "$test_dir/bin/ip"
python3 - <<'PY'
import os,shlex,subprocess
from pathlib import Path
units = Path(os.environ['FAKE_STACK_DIR']) / 'systemd'
env = dict(os.environ, AEEIS_DEPLOY_DIR=os.environ['FAKE_UNIT_DIR'],
           AEEIS_ENV_FILE=os.environ['FAKE_UNIT_DIR'] + '/stack.env')
for name in ('backup','health','notify','stack'):
    text = (units / ('aeeis-' + name + '@.service')).read_text()
    assert 'Environment=AEEIS_DEPLOY_DIR=/opt/aeeis/deploy/stack' in text
    assert 'EnvironmentFile=-/etc/aeeis/%i.env' in text
    assert '/opt/%i/aeeis' not in text
    if name in ('backup','health'): assert 'OnFailure=aeeis-notify@%i.service' in text
    if name == 'notify': assert 'OnFailure=' not in text
    for line in text.splitlines():
        if line.startswith(('ExecStart=', 'ExecStartPre=', 'ExecStop=')):
            command = line.split('=',1)[1].removeprefix('-').replace('$$','$').replace('%i','aeeis-cn-prod')
            subprocess.run(shlex.split(command), env=env, check=True, timeout=5)
commands = (Path(env['AEEIS_DEPLOY_DIR']) / 'commands').read_text()
assert 'notify.sh aeeis-cn-prod' in commands and 'stack.sh start' in commands and 'stack.sh stop' in commands, commands
PY
# Stub external dependencies so verify also works on hosts without Docker units.
if command -v systemd-analyze >/dev/null; then
  mkdir -p "$test_dir/systemd"
  cp "$STACK_DIR"/systemd/* "$test_dir/systemd/"
  for dependency in docker tailscaled; do
    printf '[Unit]\nDescription=Selftest dependency\n[Service]\nExecStart=/bin/true\n' > "$test_dir/systemd/$dependency.service"
  done
  if ! SYSTEMD_UNIT_PATH="$test_dir/systemd:" systemd-analyze verify \
    "$test_dir"/systemd/aeeis-*.service "$test_dir"/systemd/aeeis-*.timer > "$test_dir/systemd-verify.log" 2>&1; then
    if grep -Fxq 'SO_PASSCRED failed: Operation not permitted' "$test_dir/systemd-verify.log"; then
      echo 'stack selftest: systemd-analyze unavailable (sandbox blocks SO_PASSCRED); unit command checks passed'
    else
      cat "$test_dir/systemd-verify.log" >&2
      exit 1
    fi
  fi
else
  echo 'stack selftest: skipping systemd-analyze verification (dependency absent); unit command checks passed'
fi
echo 'stack selftest: online atomic backups, failure exits, retention, notifications and configurable systemd paths passed'
