# Migrate aeeis-sg and kk-cn to the production stack

Run this procedure separately on **aeeis-sg** (SG, legacy stack `aeeis-sg`) and
**kk-cn** (CN, legacy stack `aeeis-cn`; new stack `aeeis-cn-prod`). Both currently run the root
`docker-compose.yml` + `aeeis-compose-model.yml` + `aeeis-sg.override.yml` or
`aeeis-cn.override.yml`, with `AEEIS_ENV=development` and existing tokens.
The destination is `deploy/stack/compose.yml`, with `AEEIS_ENV=production`,
Temporal versioning enabled, and a real HTTPS model provider. Never use the
fixture smoke overlay on either production host.

## 1. Preflight and rehearse

- Record the old checkout/commit, Compose project, service names, image tags,
  API listener, proxy/Tailscale Serve target, systemd units, database names,
  Postgres major versions, Temporal version, namespace, queue and volume names.
  Use the deployed configuration, rather than assuming the root defaults.
- Verify Docker Engine/Compose, free disk for dumps **and** volume copies,
  tailnet address availability, outbound HTTPS to the approved regional model,
  and access to pinned images. The new API publishes the existing API port to
  the tailnet and host loopback; PostgreSQL, Temporal and worker health remain
  inside Compose. Keep the existing public HTTPS URL/proxy and Host allowlist
  so Toolkit Global and other callers continue to reach the same API.
- Keep the old checkout, override files, images and containers available for
  rollback. Disable old auto-start/deploy units during the maintenance window;
  record their prior state. Do not use `docker compose down -v` or prune volumes.
- Check out the reviewed production-stack commit separately from the old
  checkout. Build/pull its release image before the maintenance window.
- Rehearse on isolated copies of the backups with the candidate image and a
  real provider. API startup can migrate AEEIS schemas; Temporal auto-setup can
  upgrade its persistence and visibility schemas. The root default Temporal
  image is 1.24.2; the stack default is 1.29.7. Use the Temporal checkpoints
  **1.24.2 -> 1.25.2 -> 1.27.4 -> 1.29.7** and the per-hop procedure in section 4a;
  never start the new default directly on a 1.24.2 schema. Record each image
  and schema transition. Match the Postgres major when reusing physical volumes; use a
  logical dump/restore for a major upgrade. Validate the entire restore before
  scheduling cutover.

Set these operator variables to the inventory values (examples are placeholders):

```bash
set -euo pipefail
umask 077
OLD_REPO='/REPLACE_WITH_OLD_CHECKOUT'
OLD_PROJECT='REPLACE_WITH_EXISTING_COMPOSE_PROJECT'
OLD_OVERRIDE='aeeis-sg.override.yml'  # kk-cn: aeeis-cn.override.yml
OLD_NAMESPACE='REPLACE_WITH_EXISTING_NAMESPACE'
NEW_REPO='/REPLACE_WITH_PRODUCTION_CHECKOUT'
STACK_ENV="$NEW_REPO/deploy/stack/stack.env"
migration_backup='/REPLACE_WITH_REGION_LOCAL_BACKUP_DIRECTORY/migration'
mkdir -p "$migration_backup"
old_dc() {
  docker compose --project-directory "$OLD_REPO" -p "$OLD_PROJECT" \
    -f "$OLD_REPO/docker-compose.yml" \
    -f "$OLD_REPO/aeeis-compose-model.yml" \
    -f "$OLD_REPO/$OLD_OVERRIDE" "$@"
}
old_dc ps --all > "$migration_backup/old-services.txt"
old_dc images > "$migration_backup/old-images.txt"
old_dc config > "$migration_backup/old-compose-effective.yml"
cp "$OLD_REPO/docker-compose.yml" "$OLD_REPO/aeeis-compose-model.yml" \
  "$OLD_REPO/$OLD_OVERRIDE" "$migration_backup/"
```

The effective config and overrides contain secrets; keep them mode 0600 and
out of tickets, logs and Git. Include any old env files and file secrets in the
protected backup. Adapt service names below if inventory differs from `aeeis`,
`temporal-worker`, `postgres`, `temporal-postgres`, `temporal`.

## 2. Prepare production configuration and preserve tokens

```bash
cp "$NEW_REPO/deploy/stack/stack.env.example.sg" "$STACK_ENV"
# kk-cn: copy stack.env.example.cn instead
chmod 600 "$STACK_ENV"
```

Edit locally with a secure editor. Replace **every** `REPLACE_WITH_*` value:

- Copy `AEEIS_ACCESS_TOKEN` and `AEEIS_WORKER_TOKEN` from the **existing host's
  override/effective config unchanged**. Do not generate replacement tokens at
  cutover: Toolkit Global and other callers already hold the access token, and
  API/worker must agree on the worker token. Verify the worker token meets the
  existing 16-character minimum. If a host uses principal tokens or OIDC rather
  than the stated access-token setup, reconcile that auth mode before using
  this static-access-token stack template.
- Set `AEEIS_STACK=aeeis-cn-prod` on CN (`aeeis-sg-prod` on SG),
  distinct from `OLD_PROJECT`. Set `AEEIS_LEGACY_STACK="$OLD_PROJECT"` in the
  env file using its literal inventory value. Default legacy project is `aeeis-cn`.
  All new Compose commands must pass `-p "$AEEIS_STACK"`; do not remove orphans.
  Fresh volumes default to `<project>-postgres`, `<project>-temporal-postgres`,
  and `<project>-data`. The guard rejects foreign Compose volume labels and
  legacy-container mount/name overlap, even if legacy containers are stopped.
- Preserve the current Temporal namespace and task queue for restored state.
  The existing CN task queue is **`aeeis-agent`**, independent of project name.
  `AEEIS_TASK_QUEUE` also names the new Worker Deployment. The script derives a
  stable `AEEIS_BUILD_ID` from stack name and Git commit, and promotes that build
  after worker readiness. Versioning and `AUTO_UPGRADE` are configured by Compose.
- Set the host tailnet IP, current API port, all existing caller/proxy Host
  names in `AEEIS_PUBLIC_HOSTS`, and the workbench HTTPS browser origin in
  `AEEIS_TRUSTED_ORIGINS`. Preserve existing integration tokens/settings too;
  replace development HTTP integrations with HTTPS before production startup.
- Configure `AEEIS_MODEL_BASE_URL` with the approved provider's **HTTPS**
  OpenAI-compatible base, `AEEIS_MODEL` with its real model/endpoint ID, and
  `AEEIS_MODEL_API_KEY` with its key. For SG use the approved overseas provider;
  for CN use ARK or another approved mainland provider. Templates contain no
  live endpoints, credentials or fixture models. An optional health URL must
  be a real provider endpoint; many providers do not implement `/health`.
  Alternatively remove the direct key assignment and set
  `AEEIS_MODEL_API_KEY_FILE=/run/aeeis-secrets/model-key`; install that file in
  `deploy/stack/secrets/model-key` owned by UID 1000, mode 0400. Never set both.
- On restored databases preserve the database passwords and roles from
  the old installation. `POSTGRES_PASSWORD` initializes an empty volume; it
  does **not** change credentials in an existing volume. Defer password rotation
  to a separate coordinated change. Check the configured connection URI works.
- Retain `AEEIS_ENV=production`, `AEEIS_TEMPORAL_USE_VERSIONING=1` and
  `AEEIS_TRUSTED_INTERNAL_HOSTS=api,worker`. The last setting accepts only exact
  single-label service names (`^[a-z0-9][a-z0-9-]{0,62}$`), never dots, wildcards
  or IP entries; loopback is implicit. HTTP trust applies only to
  `AEEIS_INTERNAL_URL` and `AEEIS_TEMPORAL_WORKER_HEALTH_URL`/worker-health probes.
  Model, competition and provider URL maps still require HTTPS in production
  with the existing loopback exception. Leave all insecure-HTTP switches off.
  The current shared-network stack uses loopback for these two internal URLs.
  `AEEIS_TRUSTED_HOSTS` is a separate inbound Host allowlist; when changing to
  service URLs, configure that inbound allowlist independently.
- `STACK_ENV_FILE=./stack.env` identifies the container env file for direct
  Compose use. If using another filename/path, update it relative to
  `deploy/stack/compose.yml` or set an absolute path. `bin/deploy.sh` requires
  `--env-file` and resolves that path itself. The name deliberately avoids the
  `AEEIS_*_FILE` secret loader. Never put deployment secrets in `.env` as an
  implicit fallback.

### 2a. Preload every image before the maintenance window

Use the same architecture, reviewed release and image pins as the destination.
On SG/dev with Docker access to upstream (transfer **images only**, no CN data):

```bash
cd "$NEW_REPO/deploy/stack"
# Set the actual reviewed release repository:tag in the selected env/release.
export AEEIS_IMAGE='aeeis:REPLACE_WITH_COMMIT'
export AEEIS_ENV_FILE="$STACK_ENV"
./bin/images.sh list
./bin/images.sh prepull
./bin/images.sh save /tmp/aeeis-images.tar
# Export an additional bundle for each rehearsed Temporal hop, with matching pins.
for temporal_hop in 1.24.2 1.25.2 1.27.4 1.29.7; do
  AEEIS_TEMPORAL_IMAGE="temporalio/auto-setup:$temporal_hop" ./bin/images.sh prepull
  AEEIS_TEMPORAL_IMAGE="temporalio/auto-setup:$temporal_hop" ./bin/images.sh save "/tmp/aeeis-images-$temporal_hop.tar"
done
(cd /tmp && sha256sum aeeis-images*.tar > aeeis-images.sha256)
scp /tmp/aeeis-images*.tar /tmp/aeeis-images.sha256 kk-cn:/tmp/
# On CN, select its protected configuration and the same release:
(cd /tmp && sha256sum -c aeeis-images.sha256)
AEEIS_ENV_FILE="$STACK_ENV" ./bin/images.sh load /tmp/aeeis-images.tar
for temporal_hop in 1.24.2 1.25.2 1.27.4 1.29.7; do
  AEEIS_ENV_FILE="$STACK_ENV" AEEIS_TEMPORAL_IMAGE="temporalio/auto-setup:$temporal_hop" \
    ./bin/images.sh load "/tmp/aeeis-images-$temporal_hop.tar"
done
AEEIS_ENV_FILE="$STACK_ENV" ./bin/images.sh verify
```

`images.sh` honors explicitly supplied image/registry variables over `stack.env`
and `.current.<stack>.env`, so each bundle uses the selected release and hop. Build the
release on SG/dev first if it is not published.
`load` verifies/retags locally and never pulls. `save` includes every service
image, including ops profiles. `prepull` tries local -> registry prefix -> mirror
-> upstream, retagging each success to the canonical Compose reference. Any
missing image aborts deployment before `up`/replacement; startup disables pulls.
DaoCloud is only a best-effort fallback, never a prerequisite.

For TCR, configure `AEEIS_IMAGE_REGISTRY=ccr.ccs.tencentyun.com/x2v-co` (no trailing
slash) in CN's selected env. Compose prefixes the repository paths of **all**
images; with this setting, use repository:tag release refs such as
`AEEIS_DEPLOY_IMAGE=aeeis:<commit>`. Use `docker login ccr.ccs.tencentyun.com`
without placing passwords in argv. On the connected build
host, tag/push each listed upstream ref to `<prefix>/<upstream-repository>:<tag>`
(e.g. `<prefix>/postgres:17-alpine`, `<prefix>/temporalio/auto-setup:1.29.7`, and
`<prefix>/aeeis:<commit>`); confirm the namespace/repository paths are supported
by your registry. Run `images.sh prepull` and `verify` on CN before draining.
A loaded upstream bundle also works: local images are retagged to TCR refs.

## 3. Drain, then back up Postgres, Temporal persistence and data

First block new submissions from callers and ingress, pause reminder/recurring
producers, and let all in-flight runs/workflows finish on the **old** workers.
Resolve pending approvals and check Temporal's open workflows in the existing
namespace. Future reminder timers count as open workflows: wait for them or
cancel/reschedule them through the supported application path with the owner,
and record the affected reminders. Do not abandon open workflows by swapping
queues/builds. Proceed only after the drain is complete.

```bash
old_dc exec -T temporal temporal --address temporal:7233 \
  --namespace "$OLD_NAMESPACE" workflow list --query 'ExecutionStatus="Running"'
# Save the old container ID before stopping; its writable layer may hold data.
old_api_id="$(old_dc ps -q aeeis)"
# Stop all writers, including Temporal, while leaving both PG servers up to dump.
old_dc stop temporal-worker aeeis temporal
old_dc exec -T postgres sh -c 'exec pg_dumpall -U "$POSTGRES_USER"' \
  > "$migration_backup/aeeis-pg-dumpall.sql"
old_dc exec -T temporal-postgres sh -c 'exec pg_dumpall -U "$POSTGRES_USER"' \
  > "$migration_backup/temporal-pg-dumpall.sql"
test -s "$migration_backup/aeeis-pg-dumpall.sql"
test -s "$migration_backup/temporal-pg-dumpall.sql"
# Contains both temporal and temporal_visibility plus cluster roles/grants.
# Stop PG too before filesystem copies of persistence volumes.
old_dc stop postgres temporal-postgres
# Inventory mounts without printing container environment or tokens.
docker inspect "$old_api_id" --format '{{json .Mounts}}' \
  > "$migration_backup/old-api-mounts.json"
# Use the inventoried data path if the host overrides /app/data.
docker cp "$old_api_id:/app/data" "$migration_backup/aeeis-data"
```

Archive **both Postgres named volumes**, plus every AEEIS data volume or bind
mount (artifacts, local durable stores, registry/ownhow files). The root stack
may keep `/app/data` in the API writable layer, so keep that container and the
`docker cp` copy even when there is no AEEIS named volume. Example for each
inventoried named volume, after confirming it exists:

```bash
migration_volume='REPLACE_WITH_INVENTORIED_VOLUME_NAME'
docker volume inspect "$migration_volume" >/dev/null
docker run --rm --network none \
  -v "$migration_volume:/source:ro" -v "$migration_backup:/backup" \
  alpine:3.20 sh -c 'tar -C /source -cpf "/backup/$1.tar" .' archive "$migration_volume"
# Repeat for AEEIS PG, Temporal PG, and any data volumes; tar bind mounts separately.
(cd "$migration_backup" && sha256sum *.sql *.tar > SHA256SUMS && sha256sum -c SHA256SUMS)
```

Store the full set together off-host in the approved region (CN backups stay
in CN). Recheck checksums after copying and prove `pg_dumpall` restores into
isolated matching-version Postgres instances before starting the new stack.
Do not rely on successful dump exit codes alone. Backups must precede any new
API/Temporal startup that can migrate schemas. Abort cutover on backup or
restore-test failure and restart the drained old stack.

## 4. Cut over by restoring into fresh volumes

Ensure the old Compose stack and its auto-start units remain stopped. Keep
its containers and volumes for rollback. Confirm its API port has been released.

Use fresh, distinctly named stack volumes and matching-version PG images.
Do not reuse legacy project volumes: foreign Compose labels or mounts referenced
by legacy containers are rejected by the guard. Preserve the stopped legacy
containers and volumes for rollback. Export the selected env and supply the
reviewed release/build ID for Compose interpolation, then start **only** the two
database services. Do not start API or Temporal yet.

```bash
set -a
. "$STACK_ENV"
set +a
export STACK_ENV_FILE="$STACK_ENV"
export AEEIS_IMAGE='REPLACE_WITH_BUILT_RELEASE_IMAGE'
export AEEIS_BUILD_ID='REPLACE_WITH_STACK_NAME-RELEASE_COMMIT'
new_dc() {
  docker compose -p "$AEEIS_STACK" -f "$NEW_REPO/deploy/stack/compose.yml" --env-file "$STACK_ENV" "$@"
}
new_dc config --quiet
# Read-only safety guard + all-image preflight before the first up.
AEEIS_ENV_FILE="$STACK_ENV" bash -euo pipefail -c '
  . "$1/bin/_lib.sh"; stack_guard
' guard "$NEW_REPO/deploy/stack"
AEEIS_ENV_FILE="$STACK_ENV" "$NEW_REPO/deploy/stack/bin/images.sh" prepull
AEEIS_ENV_FILE="$STACK_ENV" "$NEW_REPO/deploy/stack/bin/images.sh" verify
# Fresh-volume restore only: a distinct bootstrap role/database avoids
# colliding with the roles/databases included in pg_dumpall.
# Confirm this name is absent from the old inventory before use.
cat > "$migration_backup/restore-bootstrap.yml" <<'YAML'
services:
  postgres:
    environment:
      POSTGRES_USER: aeeis_migration_restore
      POSTGRES_DB: aeeis_migration_restore
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aeeis_migration_restore -d aeeis_migration_restore"]
  temporal-postgres:
    environment:
      POSTGRES_USER: aeeis_migration_restore
      POSTGRES_DB: aeeis_migration_restore
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aeeis_migration_restore -d aeeis_migration_restore"]
YAML
restore_dc() {
  docker compose -p "$AEEIS_STACK" -f "$NEW_REPO/deploy/stack/compose.yml" \
    -f "$migration_backup/restore-bootstrap.yml" --env-file "$STACK_ENV" "$@"
}
restore_dc up -d --pull never --wait postgres temporal-postgres
restore_dc exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d aeeis_migration_restore' \
  < "$migration_backup/aeeis-pg-dumpall.sql"
restore_dc exec -T temporal-postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d aeeis_migration_restore' \
  < "$migration_backup/temporal-pg-dumpall.sql"
# Inventory may use other restored superuser names; substitute them below.
for migration_db_service in postgres temporal-postgres; do
  migration_restored_user=aeeis
  [[ "$migration_db_service" == temporal-postgres ]] && migration_restored_user=temporal
  restore_dc exec -T "$migration_db_service" psql -X -v ON_ERROR_STOP=1 \
    -U "$migration_restored_user" -d postgres \
    -c 'ALTER ROLE aeeis_migration_restore NOLOGIN;'
done
# Return to production service config on the already-initialized volumes.
new_dc up -d --pull never --wait postgres temporal-postgres
```

This bootstrap override is for **empty, fresh volumes only**. Restore into the
same logical database names/roles as the old deployment, then disable the
bootstrap login with **NOLOGIN only**: the PostgreSQL bootstrap role cannot
be stripped of its superuser attribute. Rehearse the exact commands against
the full dumps first;
abort on any unexpected SQL error. Restore both Temporal persistence and
visibility databases together with AEEIS.

Populate the new AEEIS data volume from `aeeis-data` or its volume archive and
verify file ownership (UID/GID 1000). Complete the per-hop Temporal schema/server
upgrades in section 4a on these restored volumes before deploying the final
release. Confirm database/table and artifact counts against the old snapshot.
After section 4a, deploy the reviewed release:

```bash
cd "$NEW_REPO/deploy/stack"
AEEIS_DEPLOY_IMAGE="$AEEIS_IMAGE" ./bin/deploy.sh --env-file "$STACK_ENV" --no-build
```

The script waits for the correct build's worker to be RUNNING, promotes it to
Current Version, waits for API readiness, then records `.current.<stack>.env`. A failed
deploy may already have started containers or migrated schemas even though
`.current.<stack>.env` was not updated: keep ingress blocked and use the rollback steps.
On an initial migration, the old Compose project is not the new script's replay
source; perform the replay/restore rehearsal before cutover. Start the restored
Temporal server in section 4a before deploying: the gate always queries Temporal
and blocks when it is unavailable. `AEEIS_SKIP_REPLAY` no longer bypasses the gate.
The gate checks every Running AEEIS execution plus a recent closed sample. Install/enable the new stack, backup and health systemd units
only after verification; keep the old units disabled while the new stack owns
these volumes and ports.

### 4a. Temporal schema and server upgrade checkpoints

The old component is **Temporal Server / `temporalio/auto-setup:1.24.2`** in
root `docker-compose.yml`, not PostgreSQL or the SDK. The requested drill
checkpoints are **1.24.2 -> 1.25.2 -> 1.27.4 -> 1.29.7**. At each transition,
update **both** `temporal` persistence and `temporal_visibility` schemas using
the target image's SQL tool, start that server, then verify health and schema
versions before continuing. API/worker remain stopped throughout this sequence.

[Temporal's upgrade guide](https://docs.temporal.io/self-hosted-guide/upgrade-server)
guarantees consecutive minor upgrades, not skipped minors. These checkpoints
skip 1.26 and 1.28: include reviewed/rehearsed 1.26.x and 1.28.x images and the
same schema/health steps between checkpoints unless your release-specific
compatibility review explicitly supports those jumps. Preload any additional
images before draining. Do not infer skip compatibility from successful SQL
migration alone. Wait until the health check passes and both expected schema versions are
confirmed before advancing each hop, with a minimum observation period of about
one minute for shards to load. Continue waiting if those checks have not passed;
review the release notes before proceeding.

Each checkpoint runs the schema/server/health commands below with this target:

| From | Target image pin | Required checkpoint evidence |
| --- | --- | --- |
| 1.24.2 | `temporalio/auto-setup:1.25.2` | Both SQL schemas updated; cluster healthy; schema versions recorded |
| 1.25.2 | `temporalio/auto-setup:1.27.4` | Repeat both schema updates and health checks, including the 1.26.x step |
| 1.27.4 | `temporalio/auto-setup:1.29.7` | Repeat both schema updates and health checks, including the 1.28.x step |

First start only the restored 1.24.2 Temporal server to verify the baseline.
Then run this sequence (insert the required intermediate minor pins after the
compatibility review). Keep ingress/producers blocked and execute each hop
individually, checking its evidence before choosing the next tag:

```bash
# Repeat for 1.24.2 baseline, then 1.25.2, 1.27.4, 1.29.7 checkpoints,
# and any required 1.26.x / 1.28.x intermediate versions.
export AEEIS_TEMPORAL_IMAGE='temporalio/auto-setup:1.25.2'
AEEIS_ENV_FILE="$STACK_ENV" "$NEW_REPO/deploy/stack/bin/images.sh" prepull
AEEIS_ENV_FILE="$STACK_ENV" "$NEW_REPO/deploy/stack/bin/images.sh" verify
new_dc stop temporal
# Run the target image's schema tools BEFORE starting that server. The password
# is read from the container environment, never interpolated into host argv.
new_dc run --rm -T --no-deps --pull never --entrypoint sh temporal -ec '
  export SQL_PASSWORD="$POSTGRES_PWD"
  temporal-sql-tool --plugin postgres12 --ep temporal-postgres -p 5432 \
    -u "$POSTGRES_USER" --db temporal update-schema \
    -d /etc/temporal/schema/postgresql/v12/temporal/versioned
  temporal-sql-tool --plugin postgres12 --ep temporal-postgres -p 5432 \
    -u "$POSTGRES_USER" --db temporal_visibility update-schema \
    -d /etc/temporal/schema/postgresql/v12/visibility/versioned
'
# auto-setup also checks/updates both schemas idempotently on startup.
temporal_hop_started=$SECONDS
new_dc up -d --no-deps --pull never temporal
# Poll until the server reports healthy. Earlier tags may ship tctl rather
# than the temporal CLI; use the CLI present in that image.
until new_dc exec -T temporal sh -ec '
  if command -v temporal >/dev/null; then
    temporal operator cluster health --address temporal:7233
  else
    tctl --address temporal:7233 cluster health
  fi
'; do
  sleep 5
done
# At least about one minute of observation per hop; continue longer as needed.
while (( SECONDS - temporal_hop_started < 60 )); do sleep 5; done
for temporal_db in temporal temporal_visibility; do
  new_dc exec -T temporal-postgres psql -X -v ON_ERROR_STOP=1 \
    -U temporal -d "$temporal_db" \
    -c 'SELECT curr_version, min_compatible_version FROM schema_version;'
done
new_dc logs --tail 200 temporal
# Check for errors, namespace/history visibility and expected release schema
# versions against the target release migrations. Do not advance until health
# passes AND both expected schema versions are confirmed. Save evidence.
```

Abort on any schema/health failure. Preserve the failed volumes for diagnosis;
restore the full snapshot before returning to older binaries. After the final
1.29.7 hop, set `AEEIS_TEMPORAL_IMAGE=temporalio/auto-setup:1.29.7` in the protected
env (or remove its override to use the pinned default), verify images again,
and run the release deploy command in section 4.

## 5. Verify before admitting traffic

Use the existing caller-facing HTTPS URL, then repeat from Toolkit Global (SG)
or the CN caller path. The three authentication checks are on `/api/runs`:
**no token → 401, wrong token → 401, original correct token → 200**. `/readyz`
is a readiness probe and must return 200 with `status=ready`; it is intentionally
reachable without a bearer token. Check `/api/status` for TemporalDispatcher,
a ready dispatcher and the real configured model.

```bash
# Token is inherited from the protected env, rather than placed in argv/logs.
export AEEIS_BASE_URL='https://REPLACE_WITH_EXISTING_CALLER_FACING_HOST'
new_dc exec -T -e AEEIS_BASE_URL api node --input-type=module <<'JS'
const base = process.env.AEEIS_BASE_URL.replace(/\/$/, '');
for (const [label, token, expected] of [
  ['no token', undefined, 401],
  ['wrong token', 'migration-invalid-token', 401],
  ['original token', process.env.AEEIS_ACCESS_TOKEN, 200],
]) {
  const r = await fetch(`${base}/api/runs`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (r.status !== expected) throw new Error(`${label}: ${r.status}, expected ${expected}`);
  console.log(`${label}: ${r.status}`);
  await r.body?.cancel();
}
const r = await fetch(`${base}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
const body = await r.json();
if (!r.ok || body.status !== 'ready') throw new Error('API not ready');
console.log('readyz: ready');
JS
AEEIS_ENV_FILE="$STACK_ENV" ./bin/health.sh
```

Confirm through `new_dc exec -T api node ...`/`bin/health.sh` that worker
`/readyz` reports `RUNNING` with the deployed build and original task queue.
Inspect logs for production validation errors, model auth failures, missing
volumes or migration failures without copying secrets into incident channels.

Complete **one real run end to end** with a small approved, non-sensitive input:
create via the existing workbench or authenticated `POST /api/runs` (body contains
`goal` and `materials`), inspect its generated plan, approve its exact `approval.planHash`
with `POST /api/runs/:id/approve`, then observe `GET /api/runs/:id` until
`status=succeeded`, review `verdict=accepted`, and inspect a real artifact.
Each material must contain `title`, `content`, and `source`. For example:

```json
{
  "goal": "Summarize the approved migration drill notes",
  "materials": [{
    "title": "Drill notes",
    "content": "The isolated restore completed and checksums matched.",
    "source": "sre://migration-drill/approved-notes"
  }]
}
```

Read `approval.planHash` from `GET /api/runs/:id` once `status=needs_approval`
and submit that exact value in the approval request (the request field is still
`planHash`):

```javascript
const run = await (await fetch(`${base}/api/runs/${runId}`, { headers })).json();
if (run.status !== 'needs_approval' || !run.approval?.planHash) throw new Error('Run is not ready for approval');
const response = await fetch(`${base}/api/runs/${runId}/approve`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ planHash: run.approval.planHash }),
});
if (!response.ok) throw new Error(`Approval failed: HTTP ${response.status}`);
```

Record the run ID, model identity and Temporal workflow execution. Verify actual
provider usage from the provider console/response evidence. Fixtures and a 200
health response do not satisfy this acceptance check. Reopen upstream traffic
only after all checks pass; confirm existing callers can still list their runs.
Run a new coordinated backup and schedule a restore drill after acceptance.

## 6. Roll back

1. Block new submissions/producers again and drain new in-flight work when
   possible. Record any post-cutover run/reminder IDs and the recovery point;
   restoring the pre-cutover snapshot loses writes made afterward.
2. Stop the new stack and disable its auto-start units:
   `new_dc stop worker api temporal postgres temporal-postgres`. Do not remove
   volumes. A `.previous.<stack>.env` image rollback alone is insufficient for a
   schema-changing migration from the old root stack.
3. If you restored into fresh volumes and old volumes remain untouched, retain
   the new volumes for investigation and select the original old volumes.
   If the original volumes were modified outside this procedure,
   restore the complete pre-cutover backups into clean matching-version volumes
   using the rehearsed restore procedure: AEEIS `pg_dumpall`, Temporal
   `pg_dumpall` (persistence **and** visibility), and the matching data archive.
   Update a protected rollback override to select those restored volumes if
   needed. Do not run old Temporal/API binaries against upgraded schemas.
4. Return to the recorded old commit/images and original root Compose files,
   including `aeeis-compose-model.yml` and the original regional override with
   its unchanged tokens. Run `old_dc up -d` (include the reviewed rollback
   volume override if restoring to alternate names). Restore the old proxy
   target and unit states. Ensure the new stack cannot auto-start concurrently.
5. Repeat the 401/401/200 authentication checks, readiness and a real run with
   the old configuration, then reopen traffic. Keep both sets of backups and
   migration records until the retention/incident-review window ends.
