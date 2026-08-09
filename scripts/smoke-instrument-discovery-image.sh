#!/usr/bin/env bash
set -euo pipefail

discovery_smoke_image="${1:-${INSTRUMENT_DISCOVERY_IMAGE:-stem-splitter-instrument-discovery:v3.2-candidate}}"
discovery_smoke_timeout="${INSTRUMENT_DISCOVERY_SMOKE_READY_SECONDS:-180}"
discovery_smoke_container="stem-splitter-instrument-discovery-smoke-$$"
discovery_smoke_token="local-only-discovery-token-000000000000"

case "$discovery_smoke_timeout" in
  ''|*[!0-9]*)
    printf '%s\n' 'INSTRUMENT_DISCOVERY_SMOKE_READY_SECONDS must be an integer.' >&2
    exit 2
    ;;
esac
if (( discovery_smoke_timeout < 10 || discovery_smoke_timeout > 900 )); then
  printf '%s\n' 'INSTRUMENT_DISCOVERY_SMOKE_READY_SECONDS must be between 10 and 900.' >&2
  exit 2
fi

cleanup_discovery_smoke() {
  case "$discovery_smoke_container" in
    stem-splitter-instrument-discovery-smoke-*)
      docker rm --force "$discovery_smoke_container" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup_discovery_smoke EXIT

test "$(docker image inspect --format '{{.Config.User}}' "$discovery_smoke_image")" = '65532:65532'

docker run --detach \
  --name "$discovery_smoke_container" \
  --network none \
  --memory 4g \
  --cpus 2 \
  --pids-limit 128 \
  --read-only \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --env "INSTRUMENT_DISCOVERY_TOKEN=$discovery_smoke_token" \
  --env PORT=8080 \
  "$discovery_smoke_image" >/dev/null

test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$discovery_smoke_container")" = 'none'
test "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$discovery_smoke_container")" = 'true'

discovery_smoke_started="$(date +%s)"
while true; do
  if ! test "$(docker inspect --format '{{.State.Running}}' "$discovery_smoke_container")" = 'true'; then
    docker logs "$discovery_smoke_container" >&2
    exit 1
  fi
  discovery_smoke_health="$(docker inspect --format '{{.State.Health.Status}}' "$discovery_smoke_container")"
  if test "$discovery_smoke_health" = 'healthy'; then
    break
  fi
  if test "$discovery_smoke_health" = 'unhealthy'; then
    docker logs "$discovery_smoke_container" >&2
    printf '%s\n' 'instrument-discovery failed its image health window' >&2
    exit 1
  fi
  if (( $(date +%s) - discovery_smoke_started >= discovery_smoke_timeout )); then
    docker logs "$discovery_smoke_container" >&2
    printf 'instrument-discovery did not become ready within %s seconds\n' "$discovery_smoke_timeout" >&2
    exit 1
  fi
  sleep 2
done

docker exec "$discovery_smoke_container" python -c \
  "import json,urllib.request; result=json.load(urllib.request.urlopen('http://127.0.0.1:8080/readyz',timeout=4)); assert result == {'ready':True,'classifierVersion':'laion-larger-clap-music-pairwise-presence-rand-trunc-v1@a0b4534a14f58e20944452dff00a22a06ce629d1','weightsSha256':'5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1','vocabularyVersion':'classroom-instruments-v1','vocabularySha256':'72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140'}; print(json.dumps(result,sort_keys=True))"

docker exec "$discovery_smoke_container" python -c \
  "import http.client,json; connection=http.client.HTTPConnection('127.0.0.1',8080,timeout=4); connection.request('POST','/v1/classify',body=b''); response=connection.getresponse(); result=json.loads(response.read()); assert response.status == 401, (response.status,result); assert response.getheader('WWW-Authenticate') == 'Bearer'; assert result == {'error':'unauthorized'}"

docker exec "$discovery_smoke_container" python -c \
  "import http.client,json,math,numpy as np; from constants import CLASSIFIER_VERSION,MODEL_WEIGHTS_SHA256,VOCABULARY_VERSION,VOCABULARY_SHA256; rate=22050; samples=(0.15*np.sin(2*math.pi*440*np.arange(rate*3,dtype=np.float32)/rate)).astype('<f4'); body=samples.tobytes(); headers={'Authorization':'Bearer $discovery_smoke_token','Content-Type':'application/octet-stream','X-Audio-Sample-Rate':str(rate),'X-Audio-Window-Samples':str(len(samples)),'X-Discovery-Schema-Version':'1','X-Expected-Classifier-Version':CLASSIFIER_VERSION,'X-Expected-Weights-SHA256':MODEL_WEIGHTS_SHA256,'X-Vocabulary-Version':VOCABULARY_VERSION,'X-Vocabulary-SHA256':VOCABULARY_SHA256}; connection=http.client.HTTPConnection('127.0.0.1',8080,timeout=40); connection.request('POST','/v1/classify',body=body,headers=headers); response=connection.getresponse(); result=json.loads(response.read()); assert response.status == 200, (response.status,result); assert result['schemaVersion'] == '1'; assert result['classifier'] == {'version':CLASSIFIER_VERSION,'weightsSha256':MODEL_WEIGHTS_SHA256}; assert result['vocabularyVersion'] == VOCABULARY_VERSION; assert result['vocabularySha256'] == VOCABULARY_SHA256; assert result['windowsAnalyzed'] == 1; assert isinstance(result['detections'],list); assert 0 <= result['timingMs'] <= 30000; print(json.dumps({'detections':len(result['detections']),'timingMs':result['timingMs']},sort_keys=True))"

docker stats --no-stream "$discovery_smoke_container" \
  --format 'instrument-discovery runtime cpu={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}'
