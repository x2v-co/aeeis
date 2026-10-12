#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# AEEIS_ENV_FILE selects configuration; AEEIS_IMAGE selects a release for an
# initial preload (otherwise .current.env supplies it). Includes ops profiles.
set -euo pipefail
# Explicit transport overrides win over both the selected config and the
# recorded release, so each migration-hop bundle uses the requested pins.
declare -A image_overrides=()
for image_var in AEEIS_IMAGE AEEIS_TEMPORAL_IMAGE AEEIS_POSTGRES_IMAGE AEEIS_NETNS_IMAGE AEEIS_IMAGE_REGISTRY AEEIS_IMAGE_MIRROR; do
  if [[ -v "$image_var" ]]; then image_overrides["$image_var"]="${!image_var}"; fi
done
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
# shellcheck source=_images.sh
. "$STACK_DIR/bin/_images.sh"
for image_var in "${!image_overrides[@]}"; do
  export "$image_var=${image_overrides[$image_var]}"
done
if [[ "${AEEIS_IMAGE_REGISTRY:-}" == */ ]]; then
  echo "AEEIS_IMAGE_REGISTRY must have no trailing slash" >&2; exit 2
fi
export AEEIS_BUILD_ID="${AEEIS_BUILD_ID:-image-preload}"
case "${1:-}" in
  list) [[ $# == 1 ]] || exit 2; stack_images ;;
  prepull) [[ $# == 1 ]] || exit 2; prepull_images ;;
  verify) [[ $# == 1 ]] || exit 2; verify_images ;;
  save)
    [[ $# == 2 ]] || { echo "usage: $0 save <tarball>" >&2; exit 2; }
    verify_images
    refs="$(stack_images)"
    mapfile -t images <<<"$refs"
    docker save -o "$2" "${images[@]}" ;;
  load)
    [[ $# == 2 ]] || { echo "usage: $0 load <tarball>" >&2; exit 2; }
    docker load -i "$2"
    # May retag preloaded upstream images for a selected registry prefix.
    retag_loaded_images ;;
  *) echo "usage: $0 {list|prepull|verify|save <tarball>|load <tarball>}" >&2; exit 2 ;;
esac
