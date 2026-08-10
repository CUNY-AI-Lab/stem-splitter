#!/bin/sh
set -eu

discovery_score_image="${INSTRUMENT_DISCOVERY_IMAGE:-stem-splitter-instrument-discovery:v3.2-candidate}"
discovery_score_repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
discovery_score_work="$(mktemp -d "${discovery_score_repo}/.instrument-discovery-score-audit.XXXXXX")"
discovery_score_container="stem-splitter-discovery-score-audit-$$"
chmod 700 "$discovery_score_work"

cleanup() {
  case "${discovery_score_container:-}" in
    stem-splitter-discovery-score-audit-*)
      docker rm --force "$discovery_score_container" >/dev/null 2>&1 || true
      ;;
  esac
  if [ -n "${discovery_score_work:-}" ] && [ -d "$discovery_score_work" ]; then
    find "$discovery_score_work" -type f -delete 2>/dev/null || true
    rmdir "$discovery_score_work" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

docker image inspect "$discovery_score_image" >/dev/null
test "$(docker image inspect --format '{{.Config.User}}' "$discovery_score_image")" = '65532:65532'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$discovery_score_image")" = '["python","service.py"]'
discovery_score_image_id="$(docker image inspect --format '{{.Id}}' "$discovery_score_image")"
discovery_score_image_digest="${discovery_score_image_id#sha256:}"
case "$discovery_score_image_id" in
  sha256:*) ;;
  *)
    printf '%s\n' 'instrument-discovery image ID is not a canonical SHA-256 digest' >&2
    exit 1
    ;;
esac
case "$discovery_score_image_digest" in
  *[!a-f0-9]*|'')
    printf '%s\n' 'instrument-discovery image ID is not a canonical SHA-256 digest' >&2
    exit 1
    ;;
esac
if [ "${#discovery_score_image_digest}" -ne 64 ]; then
  printf '%s\n' 'instrument-discovery image ID is not a canonical SHA-256 digest' >&2
  exit 1
fi
discovery_score_platform="$(
  docker image inspect --format '{{.Os}}/{{.Architecture}}' "$discovery_score_image_id"
)"
if [ "$discovery_score_platform" != 'linux/amd64' ]; then
  printf 'instrument-discovery score audit requires linux/amd64, received %s\n' \
    "$discovery_score_platform" >&2
  exit 1
fi
if ! discovery_score_lock_sha="$(
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 32 --memory 64m --memory-swap 64m \
    --entrypoint cat "$discovery_score_image_id" \
    /opt/instrument-discovery-provenance/uv-lock.sha256
)"; then
  printf '%s\n' 'instrument-discovery image lacks baked dependency-lock provenance' >&2
  exit 1
fi
case "$discovery_score_lock_sha" in
  *[!a-f0-9]*|'')
    printf '%s\n' 'instrument-discovery image dependency-lock identity is invalid' >&2
    exit 1
    ;;
esac
if [ "${#discovery_score_lock_sha}" -ne 64 ]; then
  printf '%s\n' 'instrument-discovery image dependency-lock identity is invalid' >&2
  exit 1
fi
discovery_score_repo_lock_sha="$(
  openssl dgst -sha256 "$discovery_score_repo/instrument-discovery/uv.lock" | awk '{print $NF}'
)"
if [ "$discovery_score_lock_sha" != "$discovery_score_repo_lock_sha" ]; then
  printf '%s\n' 'instrument-discovery image was built from a different dependency lock' >&2
  exit 1
fi

node --import tsx \
  "$discovery_score_repo/scripts/prepare-instrument-discovery-score-audit.mts" \
  "$discovery_score_work" "$@"

docker run --rm \
  --pull never \
  --name "$discovery_score_container" \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --cpus 2 \
  --memory 2g \
  --memory-swap 2g \
  --mount "type=bind,src=${discovery_score_work},dst=/input,readonly" \
  --mount "type=bind,src=${discovery_score_repo}/instrument-discovery/score_audit.py,dst=/audit/score_audit.py,readonly" \
  --mount "type=bind,src=${discovery_score_repo}/instrument-discovery/clap_backend.py,dst=/app/clap_backend.py,readonly" \
  --env PYTHONPATH=/app \
  --env "INSTRUMENT_DISCOVERY_EXECUTION_IMAGE_ID=$discovery_score_image_id" \
  --env "INSTRUMENT_DISCOVERY_EXECUTION_PLATFORM=$discovery_score_platform" \
  --env "INSTRUMENT_DISCOVERY_DEPENDENCY_LOCK_SHA256=$discovery_score_lock_sha" \
  --entrypoint python \
  "$discovery_score_image_id" \
  /audit/score_audit.py /input/manifest.json
