# AEEIS single-host production stack

Run one independent stack on `aeeis-sg` (SG) and one on `kk-cn` (CN).
**For existing installations, follow the [production migration runbook](../../docs/runbooks/aeeis-production-migration.md)
before starting this stack.** It covers draining workflows, preserving tokens,
backing up both Postgres clusters and application data, restoring/reusing volumes,
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
docker compose -f compose.yml --env-file stack.env --env-file .current.env config --quiet
docker compose -f compose.yml --env-file stack.env --env-file .current.env up -d --remove-orphans
```

The env file is also sourced by bash helpers, so single-quote JSON and values
with spaces. Runtime secrets support `*_FILE`, but direct and file variants
cannot coexist, even with an empty direct value. `STACK_ENV_FILE` deliberately
avoids the runtime's `AEEIS_*_FILE` secret convention.

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
  sampled existing workflow histories on the candidate image, starts the stack,
  waits for that build's RUNNING worker, promotes the Worker Deployment Current
  Version, then waits for API readiness. `.current.env` is written only after
  success; `.previous.env` records the preceding release. A failed deploy may
  already have changed running containers or schemas.
- Worker Deployment name equals `AEEIS_TASK_QUEUE`. `AUTO_UPGRADE` keeps workflows
  following the current worker on this single-worker host. Candidate histories
  must replay before ordinary upgrades; `AEEIS_SKIP_REPLAY=1` is an emergency
  override. Migration from an old Compose project needs a separate rehearsal.
- `bin/health.sh` checks API readiness, worker RUNNING and the tailnet API listener.
  `bin/replay.sh <workflow-id>...` exports histories and replays them with the
  current image (or `AEEIS_REPLAY_IMAGE`). Helpers accept `AEEIS_ENV_FILE` to
  select a nondefault env file; the deploy entrypoint always requires its flag.
- `bin/backup.sh` defaults to stopping API/worker/Temporal while dumping AEEIS,
  Temporal persistence and visibility databases as a coordinated set. It checks
  hashes, restores services, applies retention and can upload off-host. CN
  backups stay in approved CN storage; SG backups use the approved SG destination.
  Restore the three databases together plus application data as needed.
- `systemd/` supplies stack, backup and health units for `/opt/<instance>/aeeis`.
  Install after successful acceptance; leave old units disabled. The stack unit
  uses explicit `--env-file stack.env --env-file .current.env` at boot and waits
  for the tailnet address. Backup and health timers run daily and every 5 minutes.
- Optional `AEEIS_POSTGRES_VOLUME`, `AEEIS_TEMPORAL_POSTGRES_VOLUME` and
  `AEEIS_DATA_VOLUME` select inventoried existing volumes. Otherwise volumes use
  the stack project prefix. Back up and inspect named volumes before reuse;
  never mount one PG data directory into old and new servers concurrently.

For normal operations:

```bash
./bin/health.sh
# Select a custom file for read-only helpers:
AEEIS_ENV_FILE=/REPLACE_WITH_ENV_PATH ./bin/health.sh
# Upgrade after checking out the reviewed commit:
./bin/deploy.sh --env-file ./stack.env
```

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
CI=true docker compose -f compose.yml -f compose.smoke.yml \
  --env-file stack.env --env-file .current.env down -v
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
