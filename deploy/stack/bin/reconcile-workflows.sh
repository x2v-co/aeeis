#!/usr/bin/env bash
# List Running workflows with terminal app Runs. Dry-run is the default.
# Pause operator retries while applying so status cannot change after recheck.
set -euo pipefail
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
for arg in "$@"; do
  [[ "$arg" == --apply || "$arg" == --dry-run ]] || { echo "usage: $0 [--dry-run | --apply]" >&2; exit 2; }
done
dc exec -T api node scripts/reconcile-workflows.mjs "$@"
