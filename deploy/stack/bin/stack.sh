#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Guarded boot/stop entrypoint for the systemd stack unit.
set -euo pipefail
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
# shellcheck source=_images.sh
. "$STACK_DIR/bin/_images.sh"
stack_guard
case "${1:-}" in
  start)
    prepull_images
    verify_images
    resolve_git_commit "${AEEIS_IMAGE_REGISTRY:+$AEEIS_IMAGE_REGISTRY/}${AEEIS_IMAGE:-aeeis:unknown}"
    dc up -d --pull never ;;
  stop) dc stop ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
