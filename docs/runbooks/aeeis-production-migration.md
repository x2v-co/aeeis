# Migrate aeeis-sg and kk-cn to the production stack

Run this procedure separately on **aeeis-sg** (SG, stack `aeeis-sg`) and
**kk-cn** (CN, stack `aeeis-cn`). Both currently run the root
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
  image is 1.24.2; the stack default is 1.29.7. Rehearse the intermediate minor
  upgrades described in the stack's image comments rather than jumping an old
  persistence volume straight to the new default. Record each image and schema
  transition. Match the Postgres major when reusing physical volumes; use a
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
- Preserve the current Temporal namespace and task queue for restored state.
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
- On reused/restored databases preserve the database passwords and roles from
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

## 4. Cut over with volume reuse or restore

Ensure the old Compose stack and its auto-start units remain stopped. Keep
its containers and volumes for rollback. Confirm its API port has been released.

Choose one rehearsed path:

- **Reuse:** Set `AEEIS_POSTGRES_VOLUME`, `AEEIS_TEMPORAL_POSTGRES_VOLUME` and,
  when present, `AEEIS_DATA_VOLUME` to the exact inventoried names in `stack.env`.
  Run `docker volume inspect` on each first; a typo could otherwise create an
  empty volume. Keep the existing PG major, credentials and data permissions.
  If the old data was a bind mount or writable layer, create a new AEEIS data
  volume and copy the backup into it with UID/GID 1000 before API startup.
- **Restore (preferred for retaining untouched rollback volumes):** Use fresh,
  distinctly named stack volumes and matching-version PG images. Export the
  selected env and supply a temporary release/build ID for Compose interpolation,
  then start **only** the two database services. Do not start API or Temporal yet.

```bash
set -a
. "$STACK_ENV"
set +a
export STACK_ENV_FILE="$STACK_ENV"
export AEEIS_IMAGE='REPLACE_WITH_BUILT_RELEASE_IMAGE'
export AEEIS_BUILD_ID='REPLACE_WITH_STACK_NAME-RELEASE_COMMIT'
new_dc() {
  docker compose -f "$NEW_REPO/deploy/stack/compose.yml" --env-file "$STACK_ENV" "$@"
}
new_dc config --quiet
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
  docker compose -f "$NEW_REPO/deploy/stack/compose.yml" \
    -f "$migration_backup/restore-bootstrap.yml" --env-file "$STACK_ENV" "$@"
}
restore_dc up -d --wait postgres temporal-postgres
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
    -c 'ALTER ROLE aeeis_migration_restore NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;'
done
# Return to production service config on the already-initialized volumes.
new_dc up -d --wait postgres temporal-postgres
```

This bootstrap override is for **empty, fresh volumes only**. Restore into the
same logical database names/roles as the old deployment, then disable the
bootstrap login. Rehearse the exact commands against the full dumps first;
abort on any unexpected SQL error. Restore both Temporal persistence and
visibility databases together with AEEIS.

Populate the new AEEIS data volume from `aeeis-data` or its volume archive and
verify file ownership (UID/GID 1000). Rehearse Temporal minor schema upgrades
on restored volumes before the final target starts. Confirm database/table and
artifact counts against the old snapshot. Then deploy the reviewed release:

```bash
cd "$NEW_REPO/deploy/stack"
AEEIS_DEPLOY_IMAGE="$AEEIS_IMAGE" ./bin/deploy.sh --env-file "$STACK_ENV" --no-build
```

The script waits for the correct build's worker to be RUNNING, promotes it to
Current Version, waits for API readiness, then records `.current.env`. A failed
deploy may already have started containers or migrated schemas even though
`.current.env` was not updated: keep ingress blocked and use the rollback steps.
On an initial migration, the old Compose project is not the new script's replay
source; perform the replay/restore rehearsal before cutover. Do not skip replay
on later upgrades. Install/enable the new stack, backup and health systemd units
only after verification; keep the old units disabled while the new stack owns
these volumes and ports.

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
`goal` and `materials`), inspect its generated plan, approve its exact `planHash`
with `POST /api/runs/:id/approve`, then observe `GET /api/runs/:id` until
`status=succeeded`, review `verdict=accepted`, and inspect a real artifact.
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
   volumes. A `.previous.env` image rollback alone is insufficient for a
   schema-changing migration from the old root stack.
3. If you restored into fresh volumes and old volumes remain untouched, retain
   the new volumes for investigation and select the original old volumes.
   If physical volumes were reused and **any** AEEIS or Temporal schema migrated,
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
