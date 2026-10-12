#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Host-side backup entrypoint (systemd timer calls this).
#   1. Quiesce writers (default): stop worker + api + temporal so the AEEIS and
#      Temporal dumps describe the same instant; they are always restored
#      together. Downtime is ~1-2 minutes; schedule off-peak.
#      AEEIS_BACKUP_QUIESCE=none skips this (dumps are then only crash-
#      consistent per database - acceptable for ad-hoc copies, not for restore
#      of running workflows).
#   2. pg_dump all three databases through the `backup` one-shot service.
#   3. Prune local copies older than AEEIS_BACKUP_KEEP_DAYS (default 14).
#   4. Optional off-host copy: AEEIS_BACKUP_UPLOAD_CMD runs with the backup dir
#      as $1 (SG: rclone to R2; CN: CN-only storage. CN data never leaves CN).
# Exit code != 0 triggers the unit's OnFailure (notify-failure).
set -euo pipefail
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
: "${AEEIS_IMAGE:?no .current.env; deploy first}"
# shellcheck source=_images.sh
. "$STACK_DIR/bin/_images.sh"
stack_guard
prepull_images
verify_images
backup_dir="${AEEIS_BACKUP_DIR:-$STACK_DIR/backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
quiesced=0
resume() {
  if (( quiesced )); then
    dc up -d --pull never --no-recreate temporal api worker >/dev/null 2>&1 \
      || { echo "WARNING: failed to restart stack after backup" >&2; return 1; }
    wait_http http://127.0.0.1:4324/readyz "j.workerState==='RUNNING'" "worker readyz" 300 \
      && wait_http http://127.0.0.1:4323/readyz "j.status==='ready'" "api readyz" 180
  fi
}
trap resume EXIT
if [[ "${AEEIS_BACKUP_QUIESCE:-full}" == full ]]; then
  quiesced=1
  dc stop worker api temporal >/dev/null
fi
BACKUP_STAMP="$stamp" dc --profile ops run --rm --pull never -T --user "$(id -u):$(id -g)" -e BACKUP_STAMP backup
dest="$backup_dir/$stamp"
for f in aeeis.dump temporal.dump temporal_visibility.dump SHA256SUMS; do test -s "$dest/$f"; done
(cd "$dest" && sha256sum -c --quiet SHA256SUMS)
resume; quiesced=0
find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"${AEEIS_BACKUP_KEEP_DAYS:-14}" -exec rm -rf {} +
if [[ -n "${AEEIS_BACKUP_UPLOAD_CMD:-}" ]]; then
  bash -c "$AEEIS_BACKUP_UPLOAD_CMD" upload "$dest"
fi
echo "aeeis backup ok: $dest ($(du -sh "$dest" | cut -f1))"
