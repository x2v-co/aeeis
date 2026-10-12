#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# No daemon/network required: exercise the production entrypoints with Docker
# mocked on PATH. Also run from the normal unit-test suite.
set -euo pipefail
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
# Same repository root, isolated deploy state. Never write real release files.
selftest_stack="$(mktemp -d "$STACK_DIR/../.selftest.XXXXXX")"
trap 'rm -rf "$test_dir" "$selftest_stack"' EXIT
cp -a "$STACK_DIR/bin" "$STACK_DIR/systemd" "$selftest_stack/"
STACK_DIR="$selftest_stack"
export FAKE_LOG="$test_dir/docker.log" FAKE_IMAGES="$test_dir/images" FAKE_STACK_DIR="$STACK_DIR"
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
        assert '--no-deps' in args and '--pull' in args and 'never' in args, args
        if mode == 'backup-run-fail': sys.exit(42)
        env = dict(os.environ, AEEIS_BACKUP_ROOT=os.environ['AEEIS_BACKUP_DIR'],
                   AEEIS_POSTGRES_PASSWORD='test-aeeis', TEMPORAL_POSTGRES_PASSWORD='test-temporal')
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
grep -q 'running executions=4' "$test_dir/output"
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
sed -i 's/AEEIS_STACK=aeeis-cn-prod/AEEIS_STACK=aeeis-drill/' "$AEEIS_ENV_FILE"
[[ "$(read_image)" == aeeis:test ]]
reset_fake
deploy > "$test_dir/output" 2>&1
[[ -r "$STACK_DIR/.current.aeeis-drill.env" ]]
[[ ! -e "$STACK_DIR/.candidate.aeeis-drill.env" ]]
[[ "$(read_image)" == aeeis:test ]]
sed -i 's/AEEIS_STACK=aeeis-drill/AEEIS_STACK=aeeis-cn-prod/' "$AEEIS_ENV_FILE"
[[ "$(read_image)" == aeeis:legacy-prefix ]]
reset_fake
deploy > "$test_dir/output" 2>&1
[[ -r "$STACK_DIR/.current.aeeis-cn-prod.env" ]]
grep -q 'aeeis:legacy-prefix' "$STACK_DIR/.previous.aeeis-cn-prod.env"
[[ -r "$STACK_DIR/.current.aeeis-drill.env" ]]
# New keyed state takes precedence over legacy, including a different image.
sed -i 's/AEEIS_IMAGE=aeeis:test/AEEIS_IMAGE=aeeis:prod/' "$STACK_DIR/.current.aeeis-cn-prod.env"
[[ "$(read_image)" == aeeis:prod ]]
sed -i 's/AEEIS_STACK=aeeis-cn-prod/AEEIS_STACK=aeeis-drill/' "$AEEIS_ENV_FILE"
[[ "$(read_image)" == aeeis:test ]]
echo 'stack selftest: project/volume guards, pull failures, offline transport, registry fallback, replay gate and stack state isolation passed'

# Run the real backup entrypoints with fake Docker and PostgreSQL clients.
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
  touch -d '30 days ago' "$AEEIS_BACKUP_DIR/20000101T000000Z"
}
reset_backup
# A legacy quiesce setting must not cause an outage.
export AEEIS_BACKUP_QUIESCE=full AEEIS_BACKUP_KEEP_DAYS=14
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
PY
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

# Webhook handling uses a JSON payload, bounds requests, and never fails hard.
export FAKE_CURL_LOG="$test_dir/curl.json"
cat > "$test_dir/bin/curl" <<'PY'
#!/usr/bin/env python3
import json,os,sys
args = sys.argv[1:]
assert args[args.index('--connect-timeout')+1] == '5'
assert args[args.index('--max-time')+1] == '15'
assert '--fail' in args
payload = json.loads(args[args.index('--data-binary')+1])
assert isinstance(payload['text'], str)
with open(os.environ['FAKE_CURL_LOG'], 'w') as f: json.dump({'args':args,'payload':payload}, f)
sys.exit(int(os.getenv('FAKE_CURL_EXIT', '0')))
PY
chmod +x "$test_dir/bin/curl"
export AEEIS_NOTIFY_WEBHOOK=
"$STACK_DIR/bin/notify.sh" aeeis-cn-prod > "$test_dir/output" 2>&1
grep -q 'journal only' "$test_dir/output"
test ! -e "$FAKE_CURL_LOG"
printf '\nAEEIS_NOTIFY_WEBHOOK=https://notify.invalid/stack-hook\n' >> "$AEEIS_ENV_FILE"
export AEEIS_NOTIFY_WEBHOOK=https://notify.invalid/inherited-hook
export MONITOR_UNIT='aeeis-health@aeeis-cn-prod.service' MONITOR_SERVICE_RESULT=exit-code
"$STACK_DIR/bin/notify.sh" aeeis-cn-prod > "$test_dir/output" 2>&1
python3 - <<'PY'
import json,os
call = json.load(open(os.environ['FAKE_CURL_LOG']))
assert call['args'][-1] == 'https://notify.invalid/stack-hook'
assert os.environ['MONITOR_UNIT'] in call['payload']['text']
assert 'result=exit-code' in call['payload']['text']
PY
export FAKE_CURL_EXIT=22
"$STACK_DIR/bin/notify.sh" aeeis-cn-prod > "$test_dir/output" 2>&1
grep -q 'webhook delivery failed' "$test_dir/output"
AEEIS_ENV_FILE="$test_dir/missing.env" "$STACK_DIR/bin/notify.sh" aeeis-cn-prod > "$test_dir/output" 2>&1
grep -q 'stack env unavailable' "$test_dir/output"
printf 'exit 99\n' > "$test_dir/broken.env"
AEEIS_ENV_FILE="$test_dir/broken.env" "$STACK_DIR/bin/notify.sh" aeeis-cn-prod > "$test_dir/output" 2>&1
grep -q 'handler error' "$test_dir/output"
unset AEEIS_NOTIFY_WEBHOOK MONITOR_UNIT MONITOR_SERVICE_RESULT FAKE_CURL_EXIT

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
  SYSTEMD_UNIT_PATH="$test_dir/systemd:" systemd-analyze verify \
    "$test_dir"/systemd/aeeis-*.service "$test_dir"/systemd/aeeis-*.timer
fi
echo 'stack selftest: online atomic backups, failure exits, retention, notifications and configurable systemd paths passed'
