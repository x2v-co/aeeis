#!/bin/sh
# Runs inside the `backup` one-shot container (postgres image). Dumps the AEEIS,
# Temporal and Temporal visibility databases in custom format, verifies each
# archive with pg_restore --list, and writes a SHA-256 manifest.
# Never prints secrets.
set -eu
stamp="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
out="/backups/$stamp"
umask 077
mkdir -p "$out"
dump() { # name host user db password
  PGPASSWORD="$5" pg_dump -h "$2" -U "$3" -d "$4" -Fc --no-owner -f "$out/$1.dump"
  pg_restore --list "$out/$1.dump" >/dev/null
}
dump aeeis postgres aeeis aeeis "$AEEIS_POSTGRES_PASSWORD"
dump temporal temporal-postgres temporal temporal "$TEMPORAL_POSTGRES_PASSWORD"
dump temporal_visibility temporal-postgres temporal temporal_visibility "$TEMPORAL_POSTGRES_PASSWORD"
(cd "$out" && sha256sum aeeis.dump temporal.dump temporal_visibility.dump > SHA256SUMS)
echo "backup ok: $out ($(du -sh "$out" | cut -f1))"
