# Image transport helpers; source after _lib.sh.
stack_images() { dc --profile '*' config --images | sort -u; }

verify_images() {
  local refs ref failed=0
  refs="$(stack_images)" || return 1
  [[ -n "$refs" ]] || { echo 'compose returned no images' >&2; return 1; }
  while IFS= read -r ref; do
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      echo "missing local image: $ref" >&2
      failed=1
    fi
  done <<<"$refs"
  return "$failed"
}

prepull_images() {
  local refs ref upstream registry mirror mirror_ref source available failed=0
  refs="$(stack_images)" || return 1
  [[ -n "$refs" ]] || { echo 'compose returned no images' >&2; return 1; }
  registry="${AEEIS_IMAGE_REGISTRY:-}"
  mirror="${AEEIS_IMAGE_MIRROR-m.daocloud.io}"
  while IFS= read -r ref; do
    upstream="$ref"
    [[ -n "$registry" ]] && upstream="${ref#"$registry/"}"
    if docker image inspect "$ref" >/dev/null 2>&1; then continue; fi
    # Preloaded upstream tags work offline even when Compose uses a TCR prefix.
    if [[ "$upstream" != "$ref" ]] && docker image inspect "$upstream" >/dev/null 2>&1; then
      docker tag "$upstream" "$ref" || return 1
      continue
    fi
    mirror_ref="$upstream"
    if [[ "$upstream" != */* ]]; then
      mirror_ref="docker.io/library/$upstream"
    elif [[ "${upstream%%/*}" != *.* && "${upstream%%/*}" != *:* && "${upstream%%/*}" != localhost ]]; then
      mirror_ref="docker.io/$upstream"
    fi
    available=0
    # Registry prefix first, mirror second, upstream last. Pull/tag failures
    # never count as success; each canonical ref must pass a final inspect.
    local sources=()
    [[ -n "$registry" ]] && sources+=("$ref")
    [[ -n "$mirror" ]] && sources+=("${mirror%/}/$mirror_ref")
    sources+=("$upstream")
    for source in "${sources[@]}"; do
      echo "pulling $source for $ref" >&2
      if docker pull "$source"; then
        if [[ "$source" != "$ref" ]]; then docker tag "$source" "$ref" || return 1; fi
        if docker image inspect "$ref" >/dev/null 2>&1; then available=1; break; fi
      fi
    done
    if (( ! available )); then echo "unable to preload $ref; refusing deployment" >&2; failed=1; fi
  done <<<"$refs"
  (( ! failed )) || return 1
  verify_images
}

retag_loaded_images() {
  local refs ref upstream registry="${AEEIS_IMAGE_REGISTRY:-}"
  refs="$(stack_images)" || return 1
  while IFS= read -r ref; do
    if docker image inspect "$ref" >/dev/null 2>&1; then continue; fi
    upstream="$ref"
    [[ -n "$registry" ]] && upstream="${ref#"$registry/"}"
    if [[ "$upstream" != "$ref" ]] && docker image inspect "$upstream" >/dev/null 2>&1; then
      docker tag "$upstream" "$ref" || return 1
    fi
  done <<<"$refs"
  verify_images
}
