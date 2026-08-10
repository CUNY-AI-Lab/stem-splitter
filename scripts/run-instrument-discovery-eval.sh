#!/bin/sh
set -eu

discovery_eval_image="${INSTRUMENT_DISCOVERY_IMAGE:-stem-splitter-instrument-discovery:v3.2-candidate}"
discovery_eval_port="${INSTRUMENT_DISCOVERY_EVAL_PORT:-}"
discovery_eval_ready_seconds="${INSTRUMENT_DISCOVERY_EVAL_READY_SECONDS:-240}"
discovery_eval_publish='127.0.0.1::8080'
discovery_eval_container="stem-splitter-discovery-eval-$$"
discovery_eval_network="stem-splitter-discovery-eval-$$"
discovery_eval_token="$(openssl rand -hex 32)"

case "$discovery_eval_port" in
  '') ;;
  *[!0-9]*)
    printf '%s\n' 'INSTRUMENT_DISCOVERY_EVAL_PORT must be numeric' >&2
    exit 2
    ;;
esac
if [ -n "$discovery_eval_port" ] \
  && { [ "$discovery_eval_port" -lt 1024 ] || [ "$discovery_eval_port" -gt 65535 ]; }; then
  printf '%s\n' 'INSTRUMENT_DISCOVERY_EVAL_PORT must be between 1024 and 65535' >&2
  exit 2
fi
if [ -n "$discovery_eval_port" ]; then
  discovery_eval_publish="127.0.0.1:${discovery_eval_port}:8080"
fi
case "$discovery_eval_ready_seconds" in
  ''|*[!0-9]*)
    printf '%s\n' 'INSTRUMENT_DISCOVERY_EVAL_READY_SECONDS must be an integer' >&2
    exit 2
    ;;
esac
if [ "$discovery_eval_ready_seconds" -lt 10 ] \
  || [ "$discovery_eval_ready_seconds" -gt 900 ]; then
  printf '%s\n' 'INSTRUMENT_DISCOVERY_EVAL_READY_SECONDS must be between 10 and 900' >&2
  exit 2
fi

cleanup() {
  docker rm -f "$discovery_eval_container" >/dev/null 2>&1 || true
  docker network rm "$discovery_eval_network" >/dev/null 2>&1 || true
  discovery_eval_token=''
}
trap cleanup EXIT HUP INT TERM

docker image inspect "$discovery_eval_image" >/dev/null
test "$(docker image inspect --format '{{.Config.User}}' "$discovery_eval_image")" = '65532:65532'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$discovery_eval_image")" = '["python","service.py"]'
docker network create \
  --opt com.docker.network.bridge.enable_ip_masquerade=false \
  "$discovery_eval_network" >/dev/null
INSTRUMENT_DISCOVERY_TOKEN="$discovery_eval_token" docker run --detach --rm \
  --pull never \
  --name "$discovery_eval_container" \
  --network "$discovery_eval_network" \
  --publish "$discovery_eval_publish" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --cpus 2 \
  --memory 2g \
  --memory-swap 2g \
  --env INSTRUMENT_DISCOVERY_TOKEN \
  --env PORT=8080 \
  "$discovery_eval_image" >/dev/null

if [ -z "$discovery_eval_port" ]; then
  discovery_eval_binding="$(docker port "$discovery_eval_container" 8080/tcp)"
  case "$discovery_eval_binding" in
    127.0.0.1:*) discovery_eval_port="${discovery_eval_binding##*:}" ;;
    *)
      printf '%s\n' 'instrument-discovery received an invalid loopback port binding' >&2
      exit 1
      ;;
  esac
fi
case "$discovery_eval_port" in
  ''|*[!0-9]*)
    printf '%s\n' 'instrument-discovery did not receive a numeric loopback port' >&2
    exit 1
    ;;
esac

discovery_eval_ready=false
discovery_eval_failure_reason=timeout
discovery_eval_started="$(date +%s)"
while true; do
  if curl --fail --silent --show-error \
    "http://127.0.0.1:${discovery_eval_port}/readyz" >/dev/null 2>&1; then
    discovery_eval_ready=true
    break
  fi
  if ! docker container inspect "$discovery_eval_container" >/dev/null 2>&1; then
    discovery_eval_failure_reason=disappeared
    break
  fi
  discovery_eval_running="$(
    docker container inspect --format '{{.State.Running}}' "$discovery_eval_container"
  )"
  discovery_eval_health="$(
    docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$discovery_eval_container"
  )"
  if [ "$discovery_eval_running" != true ]; then
    discovery_eval_failure_reason=stopped
    break
  fi
  if [ "$discovery_eval_health" = unhealthy ]; then
    discovery_eval_failure_reason=unhealthy
    break
  fi
  if [ $(( $(date +%s) - discovery_eval_started )) -ge "$discovery_eval_ready_seconds" ]; then
    break
  fi
  sleep 2
done

if [ "$discovery_eval_ready" != true ]; then
  case "$discovery_eval_failure_reason" in
    timeout)
      printf 'instrument-discovery did not become ready for corpus evaluation within %s seconds\n' \
        "$discovery_eval_ready_seconds" >&2
      ;;
    *)
      printf 'instrument-discovery readiness failed because the container became %s\n' \
        "$discovery_eval_failure_reason" >&2
      ;;
  esac
  docker logs --tail 200 "$discovery_eval_container" >&2 || true
  exit 1
fi

INSTRUMENT_DISCOVERY_EVAL_URL="http://127.0.0.1:${discovery_eval_port}" \
INSTRUMENT_DISCOVERY_EVAL_TOKEN="$discovery_eval_token" \
  npm run eval:instruments -- "$@"
