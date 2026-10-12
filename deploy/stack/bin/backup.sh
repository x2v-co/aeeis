#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Host-side backup entrypoint (systemd timer calls this).
#   1. Online pg_dump all three databases through the `backup` one-shot service.
#      Each database has a consistent snapshot; no writers are stopped, and
#      snapshots across databases are not taken at the same instant.
#   2. Validate and atomically publish the complete backup directory.
#   3. Prune local copies older than AEEIS_BACKUP_KEEP_DAYS (default 14).
#   4. Optional off-host copy: AEEIS_BACKUP_UPLOAD_CMD runs with the backup dir
#      as $1 (SG: rclone to R2; CN: CN-only storage. CN data never leaves CN).
# Exit code != 0 triggers the unit's OnFailure (aeeis-notify@).
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
# --no-deps prevents Compose from starting/recreating any running service.
BACKUP_STAMP="$stamp" dc --profile ops run --rm --no-deps --pull never -T --user "$(id -u):$(id -g)" -e BACKUP_STAMP backup
dest="$backup_dir/$stamp"
for f in aeeis.dump temporal.dump temporal_visibility.dump SHA256SUMS; do test -s "$dest/$f"; done
(cd "$dest" && sha256sum -c --quiet SHA256SUMS)
find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"${AEEIS_BACKUP_KEEP_DAYS:-14}" -exec rm -rf {} +
if [[ -n "${AEEIS_BACKUP_UPLOAD_CMD:-}" ]]; then
  bash -c "$AEEIS_BACKUP_UPLOAD_CMD" upload "$dest"
fi
echo "aeeis backup ok: $dest ($(du -sh "$dest" | cut -f1))"
