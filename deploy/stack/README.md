# AEEIS single-host production stack

Run one independent stack on `aeeis-sg` (SG) and one on `kk-cn` (CN).
**For existing installations, follow the [production migration runbook](../../docs/runbooks/aeeis-production-migration.md)
before starting this stack.** It covers draining workflows, preserving tokens,
backing up both Postgres clusters and application data, restoring into fresh volumes,
verification with a real model and schema-aware rollback.

## Production configuration

`compose.yml` fixes `AEEIS_ENV=production`, `AEEIS_TEMPORAL_USE_VERSIONING=1`,
`AEEIS_DEMO_MODE=0`, and defaults `AEEIS_TRUSTED_INTERNAL_HOSTS=api,worker`.
There are no fixture services or fixture model defaults in the production file.

Choose the regional placeholder template and keep the selected file private:

```bash
cd deploy/stack
cp stack.env.example.sg stack.env   # kk-cn: stack.env.example.cn
chmod 600 stack.env
# Edit locally: replace every REPLACE_WITH_* value, preserving existing tokens.
./bin/deploy.sh --env-file ./stack.env
# Or deploy a prebuilt, reviewed release:
AEEIS_DEPLOY_IMAGE=registry/aeeis:REPLACE_WITH_COMMIT ./bin/deploy.sh --env-file ./stack.env --no-build
```

`bin/deploy.sh` refuses to run without `--env-file`. Compose requires
`STACK_ENV_FILE` and the deployment settings with `${VAR:?}` guards; there is
no implicit `stack.env` fallback. For direct Compose commands, the selected file
must set `STACK_ENV_FILE` to its own path relative to `compose.yml` (templates
use `./stack.env`) or an absolute path. Supply the recorded image/build file too:

```bash
set -a; . ./stack.env; set +a
export AEEIS_STACK="${AEEIS_STACK:-aeeis-cn-prod}"
docker compose -p "$AEEIS_STACK" -f compose.yml --env-file stack.env --env-file ".current.$AEEIS_STACK.env" config --quiet
./bin/stack.sh start  # guard + preload all images + up --pull never
```

The default project is `aeeis-cn-prod`; `AEEIS_STACK` overrides it. Every helper
passes an explicit `-p`. Set `AEEIS_LEGACY_STACK` to the inventoried old project
(default `aeeis-cn`). Startup refuses that project name, volumes labeled for a
different Compose project, and target volumes/container names/writable bind mounts
referenced by legacy containers, even stopped ones. Restore into fresh volumes.
Defaults are `<project>-postgres`, `<project>-temporal-postgres`, and
`<project>-data`. The existing CN queue is `aeeis-agent`; queue and project names
are independent. Preserve the inventoried queue during migration.

The env file is also sourced by bash helpers, so single-quote JSON and values
with spaces. Runtime secrets support `*_FILE`, but direct and file variants
cannot coexist, even with an empty direct value. `STACK_ENV_FILE` deliberately
avoids the runtime's `AEEIS_*_FILE` secret convention.

`AEEIS_GIT_COMMIT` identifies the release in Run debug bundles. `bin/deploy.sh`
passes the checkout's full SHA as a Docker build argument; the image stores it
in both `ENV AEEIS_GIT_COMMIT` and the OCI `org.opencontainers.image.revision`
label. For `--no-build`, the helper reads that label after pulling the image,
then falls back to a hex commit image tag (never the local checkout's SHA).
An explicit shell/systemd value takes precedence over the selected env file;
both override derived metadata. Use a 7–40 character git SHA. Untagged legacy
images without metadata retain their image environment; helpers omit the
override instead of exporting `unknown`. Systemd startup also resolves image
labels after pulling, so an image absent at startup can supply its SHA.

The resolved SHA is recorded in `.candidate.<stack>.env`, `.current.<stack>.env`
and `.previous.<stack>.env`, so promotion, rollback and systemd restarts retain
the release identity. Helpers include `compose.commit.yml` for both API and
worker only when a SHA is available. For direct Compose commands, include
`-f compose.yml -f compose.commit.yml` and supply `AEEIS_GIT_COMMIT` in the
selected `--env-file`, recorded release file, or shell environment. Omit that
override file to retain the image's metadata; helpers resolve older release
files too.
The older `deploy/production/compose.yml` passes the build argument and leaves
runtime precedence to the image and `.env.production` (no empty environment
override); build it with `--env-file .env.production` when the SHA is there.

Configure a **real provider** through `AEEIS_MODEL_BASE_URL` (HTTPS
OpenAI-compatible base), `AEEIS_MODEL` (actual model or ARK endpoint ID), and
`AEEIS_MODEL_API_KEY`. SG can use an approved overseas provider; CN can use ARK
or another approved mainland provider. Examples contain placeholders only;
obtain the endpoint/model/key from the approved provider account. For a file
key, remove `AEEIS_MODEL_API_KEY` and use
`AEEIS_MODEL_API_KEY_FILE=/run/aeeis-secrets/model-key`; install
`secrets/model-key` owned by UID 1000, mode 0400. Only configure
`AEEIS_MODEL_HEALTH_URL` if the provider exposes an appropriate real endpoint.
Do not enable insecure-HTTP flags in production.

Keep the **existing access and worker tokens** during migration so Toolkit
Global and other callers continue to work. Preserve the old Temporal namespace,
queue and database credentials when carrying over state. A fresh installation
can generate secrets locally with `openssl rand -hex 32`. Never commit live env
files or secrets. The regional templates contain no actual IPs, domains or keys.

## Network and trust

`netns` owns a stable network namespace shared by API and worker. Worker → API
uses `http://127.0.0.1:4323`; API → worker readiness uses
`http://127.0.0.1:4324/readyz`. Loopback stays allowed in production. The
namespace-holder image is pinned independently, so application releases do not
recreate it. Only API ports are published, on the selected tailnet IPv4 and
host loopback; worker health, PostgreSQL and unauthenticated Temporal gRPC
remain inside Compose. Keep the caller-facing HTTPS proxy/Tailscale Serve URL.

`AEEIS_TRUSTED_INTERNAL_HOSTS` additionally permits HTTP to exact single-label
Docker service names matching `^[a-z0-9][a-z0-9-]{0,62}$`. Dots, wildcards and IP
entries are rejected; loopback is implicit. This exception is used **only** by
`AEEIS_INTERNAL_URL` and `AEEIS_TEMPORAL_WORKER_HEALTH_URL`/worker probes. It does
not relax model URLs, competition model URLs, provider maps or other external
integrations. `AEEIS_TRUSTED_HOSTS` is the separate inbound `/internal/` Host
allowlist; configure it independently if switching to service URLs.

## Release and operations

- `bin/deploy.sh` builds the checked-out release (or uses `--no-build`), replays
  all Running AEEIS histories plus a closed sample on the candidate image, starts the stack,
  waits for that build's RUNNING worker, promotes the Worker Deployment Current
  Version, then waits for API readiness. `.current.<stack>.env` is written only after
  success; `.previous.<stack>.env` records the preceding release. A failed deploy may
  already have changed running containers or schemas.
- Worker Deployment name equals `AEEIS_TASK_QUEUE`. `AUTO_UPGRADE` keeps workflows
  following the current worker on this single-worker host. Candidate histories
  must replay before upgrades. The gate cannot be bypassed with
  `AEEIS_SKIP_REPLAY`; bootstrap Temporal before the first deploy. Migration
  from an old Compose project needs a separate rehearsal.
- `bin/health.sh` checks API readiness, worker RUNNING and the tailnet API listener.
  `bin/replay.sh <workflow-id>...` exports histories and replays them with the
  current image (or `AEEIS_REPLAY_IMAGE`). Helpers accept `AEEIS_ENV_FILE` to
  select a nondefault env file; the deploy entrypoint always requires its flag.
- `AEEIS_ENV_FILE=/absolute/path/stack.env bin/reconcile-workflows.sh` lists
  Running run workflows with terminal app Runs in dry-run mode. Add `--apply`
  to terminate the exact listed executions. Pause operator retries while applying;
  unknown, paused and waiting Runs are preserved. Status lookup or termination
  failures abort the tool. The API image must include the new internal status route.
- Model transport uses `AEEIS_MODEL_TIMEOUT_MS` for each request, including
  response bodies, and `AEEIS_MODEL_MAX_ATTEMPTS` (default 3). Retryable failures
  are network errors/timeouts, 429 and 5xx; other 4xx fail immediately. Backoff
  uses `AEEIS_MODEL_RETRY_BASE_MS` / `AEEIS_MODEL_RETRY_MAX_MS` with jitter.
  The run activity allows 20 minutes, with a 25 minute Temporal deadline, so
  the default 180s requests, transport retries and one length retry can finish.
  Keep custom retry/timeout combinations within that overall activity budget.
  Inspect `aeeis-model-error/1` logs for status, request ID, attempt, elapsed time,
  code and a bounded body excerpt. Exhausted network/5xx failures remain unknown;
  retrying the same idempotency key can still incur additional provider charges.
- Run workflows complete on `succeeded`, `failed` and `cancelled`. `unknown`
  provider outcomes park without polling until explicit reconciliation signals
  `wake`; Temporal still reports a parked workflow as RUNNING. Unchanged active
  advances use durable delays of 1, 2, 4, 8, 16, 30 and 30 seconds, then park
  after eight advances without progress. The counter survives continue-as-new
  and resets on real progress or wake. The workflow patch preserves existing
  histories; older API responses without progress metadata receive the same
  bounded backoff. No-progress metadata is opt-in so older workers retain their
  strict status-only response contract during deployment.
- State files use `AEEIS_STACK`: `.current.<stack>.env`, `.previous.<stack>.env`
  and `.candidate.<stack>.env`. Legacy `.current.env` is read only if its
  `AEEIS_STACK` or build ID identifies this exact stack. New releases use keyed files.
- `bin/backup.sh` dumps AEEIS, Temporal persistence and visibility databases
  online with `pg_dump -Fc`; API, worker and Temporal keep running. Each database
  has a consistent snapshot, but the three snapshots are taken at different
  instants. Archives and hashes are checked in a temporary directory before
  atomic publication; failures exit nonzero. It applies retention and can upload off-host. CN
  backups stay in approved CN storage; SG backups use the approved SG destination.
  Restore the three databases together plus application data as needed.
- `systemd/` supplies stack, backup, health and notification units. The default
  deploy directory is `/opt/aeeis/deploy/stack`; override `AEEIS_DEPLOY_DIR` in
  `/etc/aeeis/<instance>.env` (and `AEEIS_ENV_FILE` for a custom stack env).
  Install after successful acceptance; leave old units disabled. The stack unit
  uses `bin/stack.sh` with project/volume guards and image preflight at boot,
  reads `stack.env` and `.current.<stack>.env`, and waits for the tailnet address.
  Backup and health timers run daily and every 5 minutes.
  Both services use `OnFailure=aeeis-notify@<instance>.service`; set
  `AEEIS_NOTIFY_WEBHOOK` in the protected stack env to receive JSON `text`
  messages. For Telegram set `AEEIS_NOTIFY_TG_BOT_TOKEN` and
  `AEEIS_NOTIFY_TG_CHAT_ID` (text prefixed `[aeeis]`; may be combined with the
  webhook). curl uses `AEEIS_NOTIFY_PROXY`, else the first line of
  `AEEIS_NOTIFY_PROXY_FILE` (default `/etc/notify-failure/proxy`; `KEY=url`
  form accepted) when present. With no target configured, alerts log to the
  journal only; delivery failures are best effort.
  Follow the runbook's installation steps, including removing the old
  `10-notify.conf` drop-ins now that notifications are in the repo units.
- Optional `AEEIS_POSTGRES_VOLUME`, `AEEIS_TEMPORAL_POSTGRES_VOLUME` and
  `AEEIS_DATA_VOLUME` override the explicit volume names. Foreign project labels
  and legacy-container mounts are rejected; use isolated restored volumes.

For normal operations:

```bash
./bin/health.sh
# Select a custom file for read-only helpers:
AEEIS_ENV_FILE=/REPLACE_WITH_ENV_PATH ./bin/health.sh
# Upgrade after checking out the reviewed commit:
./bin/deploy.sh --env-file ./stack.env
```

## Image preload and CN registry fallback

`bin/images.sh list` prints all refs from Compose config with every profile
enabled (`--profile '*' config --images`), including ops and smoke services. `prepull` tries local images,
`AEEIS_IMAGE_REGISTRY` (if set), `AEEIS_IMAGE_MIRROR` (default `m.daocloud.io`),
then upstream, retagging to the exact Compose ref. A mirror failure never counts
as success. Set `AEEIS_IMAGE_MIRROR=` to skip mirrors. `verify` checks every image
locally; deploy completes both checks before any `up` or container replacement.
Startup uses `--pull never`, so missing images cannot trigger a late pull.

```bash
# Use the same reviewed release and image pins on SG/dev and CN.
AEEIS_ENV_FILE=/REPLACE_WITH_ENV_PATH AEEIS_IMAGE=aeeis:REPLACE_WITH_COMMIT ./bin/images.sh prepull
AEEIS_ENV_FILE=/REPLACE_WITH_ENV_PATH AEEIS_IMAGE=aeeis:REPLACE_WITH_COMMIT ./bin/images.sh save /tmp/aeeis-images.tar
scp /tmp/aeeis-images.tar kk-cn:/tmp/aeeis-images.tar
# On CN, with the production env selected:
AEEIS_IMAGE=aeeis:REPLACE_WITH_COMMIT ./bin/images.sh load /tmp/aeeis-images.tar
```

`images.sh` honors explicit image/registry variables over the selected env and
`.current.<stack>.env`, so a preload can select the candidate release or upgrade hop.
`save` requires all images already local. `load` runs Docker load, retags local
upstream refs when a registry prefix is selected, and verifies the complete set
without pulling. Image tarballs contain code only; never transfer CN data/secrets
overseas. Include each Temporal upgrade-hop image in separate tarballs before
cutover; see the [runbook](../../docs/runbooks/aeeis-production-migration.md).

For TCR, set `AEEIS_IMAGE_REGISTRY=ccr.ccs.tencentyun.com/x2v-co` in the selected
env. Compose prefixes each image repository; leave pins and
`AEEIS_DEPLOY_IMAGE` as repository:tag (e.g. `aeeis:<commit>`). Without a prefix,
fully qualified upstream release refs also work. Publish all repositories under
the selected prefix using the same paths/tags, log in with `docker login`, and
prepull before the maintenance window. Prefixes must have no trailing slash.
Local upstream tarballs can be retagged for TCR without network access.

Run `./bin/selftest.sh` for the mocked deployment, online backup, notification
and systemd checks (including `systemd-analyze verify` when available).
The normal `npm run verify` unit tests also run this selftest.

## Fixture smoke in CI only

`compose.smoke.yml` adds loopback fixture model/projection services in an
**isolated CI stack**. It retains production validation and needs `CI=true`.
Use disposable volumes and an env file with throwaway tokens/passwords and a
direct dummy model key; do not point `_FILE` secrets at missing files. Production
provider placeholders satisfy base-file interpolation and are replaced by the
overlay's fixture URLs. Do not use this path to verify SG/CN production.

```bash
CI=true AEEIS_STACK_SMOKE=1 ./bin/deploy.sh --env-file ./stack.env
CI=true ./bin/smoke.sh
# Teardown this disposable CI project only:
CI=true docker compose -p "$AEEIS_STACK" -f compose.yml -f compose.smoke.yml \
  --env-file stack.env --env-file ".current.$AEEIS_STACK.env" down -v
```

The fixture smoke checks a Temporal Run, a Reminder/projection delivery and
workflow replay. Production acceptance instead requires 401/401/200 token
checks, ready API/worker and one completed run using the real provider, as
specified in the migration runbook.

## Limits

This is a single-host stack without HA. Temporal auto-setup performs schema
checks/upgrades; rehearse supported minor upgrades and restore paths before
reusing older persistence. PostgreSQL physical volumes require a matching
major version. Reminder projections currently need an explicit
`POST /api/collaborations/projections/deliver-pending`; no background delivery
pump or Telegram sink is provided here.
