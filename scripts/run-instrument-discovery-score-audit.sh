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
  --entrypoint python \
  "$discovery_score_image" \
  /audit/score_audit.py /input/manifest.json
