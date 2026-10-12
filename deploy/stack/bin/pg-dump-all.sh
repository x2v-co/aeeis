#!/bin/sh
# Runs inside the `backup` one-shot container (postgres image). Dumps the AEEIS,
# Temporal and Temporal visibility databases online in custom format. Each
# pg_dump takes its own consistent snapshot without stopping writers. Verify
# each archive and manifest before atomically publishing the complete set.
# Never prints secrets.
set -eu
stamp="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
backup_root="${AEEIS_BACKUP_ROOT:-/backups}"
out="$backup_root/$stamp"
umask 077
mkdir -p "$backup_root"
test ! -e "$out" || { echo "backup already exists: $out" >&2; exit 1; }
tmp="$(mktemp -d "$backup_root/.tmp-$stamp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
dump() { # name host user db password
  PGPASSWORD="$5" pg_dump -h "$2" -U "$3" -d "$4" -Fc --no-owner -f "$tmp/$1.dump"
  test -s "$tmp/$1.dump"
  pg_restore --list "$tmp/$1.dump" >/dev/null
}
dump aeeis postgres aeeis aeeis "$AEEIS_POSTGRES_PASSWORD"
dump temporal temporal-postgres temporal temporal "$TEMPORAL_POSTGRES_PASSWORD"
dump temporal_visibility temporal-postgres temporal temporal_visibility "$TEMPORAL_POSTGRES_PASSWORD"
(cd "$tmp" && sha256sum aeeis.dump temporal.dump temporal_visibility.dump > SHA256SUMS \
  && sha256sum -c --quiet SHA256SUMS)
mv -T "$tmp" "$out"
echo "backup ok: $out ($(du -sh "$out" | cut -f1))"
