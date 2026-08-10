#!/usr/bin/env bash
set -euo pipefail

analysis_smoke_image="${1:-${AUDIO_ANALYSIS_IMAGE:-stem-splitter-audio-analysis:v3.2-candidate}}"
analysis_smoke_timeout="${AUDIO_ANALYSIS_SMOKE_READY_SECONDS:-120}"
analysis_smoke_expected_platform="${AUDIO_ANALYSIS_EXPECTED_PLATFORM:-}"
analysis_smoke_max_image_bytes="${AUDIO_ANALYSIS_MAX_IMAGE_BYTES:-251658240}"
analysis_smoke_container="stem-splitter-audio-analysis-smoke-$$"
analysis_smoke_fixture="stem-splitter-audio-analysis-fixture-$$"
analysis_smoke_network="stem-splitter-audio-analysis-net-$$"
analysis_smoke_token="local-only-analysis-token-0000000000000000"

case "$analysis_smoke_timeout" in
  ''|*[!0-9]*)
    printf '%s\n' 'AUDIO_ANALYSIS_SMOKE_READY_SECONDS must be an integer.' >&2
    exit 2
    ;;
esac
if (( analysis_smoke_timeout < 10 || analysis_smoke_timeout > 900 )); then
  printf '%s\n' 'AUDIO_ANALYSIS_SMOKE_READY_SECONDS must be between 10 and 900.' >&2
  exit 2
fi
case "$analysis_smoke_expected_platform" in
  ''|linux/amd64|linux/arm64) ;;
  *)
    printf '%s\n' 'AUDIO_ANALYSIS_EXPECTED_PLATFORM must be linux/amd64 or linux/arm64.' >&2
    exit 2
    ;;
esac
case "$analysis_smoke_max_image_bytes" in
  ''|*[!0-9]*)
    printf '%s\n' 'AUDIO_ANALYSIS_MAX_IMAGE_BYTES must be an integer.' >&2
    exit 2
    ;;
esac
if (( analysis_smoke_max_image_bytes < 1 )); then
  printf '%s\n' 'AUDIO_ANALYSIS_MAX_IMAGE_BYTES must be positive.' >&2
  exit 2
fi

cleanup_analysis_smoke() {
  case "$analysis_smoke_container" in
    stem-splitter-audio-analysis-smoke-*)
      docker rm --force "$analysis_smoke_container" >/dev/null 2>&1 || true
      ;;
  esac
  case "$analysis_smoke_fixture" in
    stem-splitter-audio-analysis-fixture-*)
      docker rm --force "$analysis_smoke_fixture" >/dev/null 2>&1 || true
      ;;
  esac
  case "$analysis_smoke_network" in
    stem-splitter-audio-analysis-net-*)
      docker network rm "$analysis_smoke_network" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup_analysis_smoke EXIT

test "$(docker image inspect --format '{{.Config.User}}' "$analysis_smoke_image")" = 'node'
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$analysis_smoke_image")" = '["node","--max-old-space-size=256","dist/server.mjs"]'

analysis_smoke_platform="$(
  docker image inspect --format '{{.Os}}/{{.Architecture}}' "$analysis_smoke_image"
)"
if test -n "$analysis_smoke_expected_platform" \
  && test "$analysis_smoke_platform" != "$analysis_smoke_expected_platform"; then
  printf 'audio-analysis platform mismatch: expected %s, received %s\n' \
    "$analysis_smoke_expected_platform" "$analysis_smoke_platform" >&2
  exit 1
fi

analysis_smoke_image_bytes="$(
  docker image inspect --format '{{.Size}}' "$analysis_smoke_image"
)"
if (( analysis_smoke_image_bytes > analysis_smoke_max_image_bytes )); then
  printf 'audio-analysis image exceeds the %s-byte gate: %s bytes\n' \
    "$analysis_smoke_max_image_bytes" "$analysis_smoke_image_bytes" >&2
  exit 1
fi

analysis_smoke_protocols="$(docker run --rm --network none "$analysis_smoke_image" ffmpeg -hide_banner -protocols 2>&1)"
analysis_smoke_enabled_protocols="$(
  printf '%s\n' "$analysis_smoke_protocols" |
    awk '/^  [[:alnum:]_]+$/ { print $1 }' |
    sort -u |
    paste -sd' ' -
)"
test "$analysis_smoke_enabled_protocols" = 'file pipe'

analysis_smoke_demuxers="$(docker run --rm --network none "$analysis_smoke_image" ffmpeg -hide_banner -demuxers 2>&1)"
analysis_smoke_enabled_demuxers="$(
  printf '%s\n' "$analysis_smoke_demuxers" |
    awk '$1 == "D" { print $2 }' |
    sort |
    paste -sd' ' -
)"
test "$analysis_smoke_enabled_demuxers" = 'aiff flac mov,mp4,m4a,3gp,3g2,mj2 mp3 ogg wav'

analysis_smoke_decoders="$(docker run --rm --network none "$analysis_smoke_image" ffmpeg -hide_banner -decoders 2>&1)"
if printf '%s\n' "$analysis_smoke_decoders" | awk '
  $1 == "------" { components = 1; next }
  components && $1 ~ /^[VS]/ { forbidden = 1 }
  END { exit forbidden ? 0 : 1 }
'; then
  printf '%s\n' 'unexpected video or subtitle decoder in audio-analysis image' >&2
  exit 1
fi

docker network create --internal "$analysis_smoke_network" >/dev/null
test "$(docker network inspect --format '{{.Internal}}' "$analysis_smoke_network")" = 'true'

docker run --detach \
  --name "$analysis_smoke_fixture" \
  --network "$analysis_smoke_network" \
  --network-alias fixture \
  --memory 256m \
  --memory-swap 256m \
  --cpus 0.5 \
  --pids-limit 32 \
  --cap-drop ALL \
  --read-only \
  --security-opt no-new-privileges \
  --no-healthcheck \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --volume "$PWD/scripts/fixtures:/fixture-scripts:ro" \
  --volume "$PWD/tests/fixtures/audio:/fixture-audio:ro" \
  "$analysis_smoke_image" \
  node --max-old-space-size=64 /fixture-scripts/audio-analysis-source-server.mjs >/dev/null

docker run --detach \
  --name "$analysis_smoke_container" \
  --network "$analysis_smoke_network" \
  --memory 1g \
  --memory-swap 1g \
  --cpus 1 \
  --pids-limit 64 \
  --cap-drop ALL \
  --read-only \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --env "AUDIO_ANALYSIS_TOKEN=$analysis_smoke_token" \
  --env AUDIO_ANALYSIS_SOURCE_ORIGINS=http://fixture:9090 \
  --env AUDIO_ANALYSIS_ALLOW_HTTP=true \
  --env AUDIO_ANALYSIS_MAX_CONCURRENCY=1 \
  --env AUDIO_ANALYSIS_MAX_SOURCE_BYTES=8388608 \
  --env AUDIO_ANALYSIS_MAX_SOURCE_SECONDS=900 \
  --env AUDIO_ANALYSIS_FETCH_TIMEOUT_MS=1000 \
  --env AUDIO_ANALYSIS_DECODER_TIMEOUT_MS=12000 \
  --env PORT=8080 \
  "$analysis_smoke_image" >/dev/null

test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$analysis_smoke_container")" = "$analysis_smoke_network"
test "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$analysis_smoke_container")" = 'true'
test "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$analysis_smoke_container")" = '["ALL"]'
test "$(docker inspect --format '{{.HostConfig.Memory}}' "$analysis_smoke_container")" = '1073741824'
test "$(docker inspect --format '{{.HostConfig.MemorySwap}}' "$analysis_smoke_container")" = '1073741824'
test "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$analysis_smoke_container")" = '1000000000'
test "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$analysis_smoke_container")" = '64'
test "$(docker inspect --format '{{json .Mounts}}' "$analysis_smoke_container")" = '[]'
case "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$analysis_smoke_container")" in
  *no-new-privileges*) ;;
  *)
    printf '%s\n' 'audio-analysis is missing no-new-privileges' >&2
    exit 1
    ;;
esac

analysis_smoke_started="$(date +%s)"
while true; do
  if ! test "$(docker inspect --format '{{.State.Running}}' "$analysis_smoke_fixture")" = 'true'; then
    docker logs "$analysis_smoke_fixture" >&2
    exit 1
  fi
  if ! test "$(docker inspect --format '{{.State.Running}}' "$analysis_smoke_container")" = 'true'; then
    docker logs "$analysis_smoke_container" >&2
    exit 1
  fi
  if docker exec "$analysis_smoke_container" node -e \
    "Promise.all([fetch('http://fixture:9090/healthz'),fetch('http://127.0.0.1:8080/readyz')]).then(async responses=>{const [fixture,ready]=await Promise.all(responses.map(response=>response.json()));if(!responses.every(response=>response.ok)||fixture.ok!==true||ready.ready!==true||ready.ffmpegVersion!=='8.0.3'||ready.classifierVersion!=='autosplit-role-v3'||ready.sourceScopeVersion!=='analysis-source-scope-v2')process.exit(1)}).catch(()=>process.exit(1))"; then
    break
  fi
  if (( $(date +%s) - analysis_smoke_started >= analysis_smoke_timeout )); then
    docker logs "$analysis_smoke_container" >&2
    printf 'audio-analysis did not become ready within %s seconds\n' "$analysis_smoke_timeout" >&2
    exit 1
  fi
  sleep 2
done

docker exec "$analysis_smoke_container" node -e '
  const { readdirSync } = require("node:fs");
  if (process.getuid() === 0) throw new Error("runtime is root");
  const app = readdirSync("/app", { recursive: true }).sort();
  const expected = ["dist", "dist/server.mjs"];
  if (JSON.stringify(app) !== JSON.stringify(expected)) {
    throw new Error(`unexpected /app runtime surface: ${JSON.stringify(app)}`);
  }
'

docker exec -i "$analysis_smoke_container" node --input-type=module <<'NODE'
import { readdir } from 'node:fs/promises';

const serviceBase = 'http://127.0.0.1:8080';
const fixtureBase = 'http://fixture:9090';
const token = process.env.AUDIO_ANALYSIS_TOKEN;
const coreModels = [
  { id: 'vocals_instrumental', stems: ['vocals', 'instrumental'] },
  { id: 'htdemucs_ft', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceUrl(name) {
  const expires = Math.floor(Date.now() / 1000) + 600;
  return `${fixtureBase}/api/local-sources/uploads/${name}?expires=${expires}&signature=${'a'.repeat(43)}`;
}

function authoritativeSourceUrl() {
  const expires = Math.floor(Date.now() / 1000) + 600;
  return `${fixtureBase}/api/local-sources/auto-inputs/v1/smoke_auto_upload?expires=${expires}&signature=${'b'.repeat(43)}`;
}

function payload(name) {
  return {
    schemaVersion: '1',
    sourceUrl: sourceUrl(name),
    sourceType: 'upload',
    coreModels,
    fallbackModel: 'htdemucs_ft',
    instrumentDiscovery: false,
  };
}

async function analyze(name) {
  return fetch(`${serviceBase}/v1/analyze`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload(name)),
  });
}

async function analyzeAuthoritativeSnapshot(sourceType = 'upload') {
  return fetch(`${serviceBase}/v1/analyze`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...payload('valid.wav'),
      sourceUrl: authoritativeSourceUrl(),
      sourceType,
    }),
  });
}

async function fingerprint(name) {
  return fetch(`${serviceBase}/v1/fingerprint`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schemaVersion: '1',
      sourceUrl: sourceUrl(name),
      sourceType: 'upload',
    }),
  });
}

async function body(response) {
  const value = await response.json();
  assert(value && typeof value === 'object', 'response body is not an object');
  return value;
}

async function assertClean() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const leftovers = (await readdir('/tmp')).filter((name) =>
    name.startsWith('stem-splitter-analysis-')
  );
  assert(leftovers.length === 0, `temporary sources remain: ${leftovers.join(',')}`);
}

const healthResponse = await fetch(`${serviceBase}/healthz`);
assert(healthResponse.status === 200, `health status ${healthResponse.status}`);
assert(
  JSON.stringify(await body(healthResponse)) ===
    JSON.stringify({ ok: true, service: 'audio-analysis', schemaVersion: '1' }),
  'health contract drifted'
);

const readyResponse = await fetch(`${serviceBase}/readyz`);
const ready = await body(readyResponse);
assert(readyResponse.status === 200 && ready.ready === true, 'service is not ready');
assert(ready.ffmpegVersion === '8.0.3', 'FFmpeg pin drifted');
assert(ready.classifierVersion === 'autosplit-role-v3', 'classifier pin drifted');
assert(ready.sourceScopeVersion === 'analysis-source-scope-v2', 'source-scope pin drifted');
assert(ready.instrumentDiscovery === 'unconfigured', 'discovery must remain unconfigured');

const unauthorized = await fetch(`${serviceBase}/v1/analyze`, { method: 'POST' });
assert(unauthorized.status === 401, `unauthorized status ${unauthorized.status}`);
assert(unauthorized.headers.get('www-authenticate') === 'Bearer', 'missing bearer challenge');
assert(JSON.stringify(await body(unauthorized)) === '{"error":"unauthorized"}', '401 body drifted');
const unauthorizedFingerprint = await fetch(`${serviceBase}/v1/fingerprint`, { method: 'POST' });
assert(unauthorizedFingerprint.status === 401, `fingerprint unauthorized status ${unauthorizedFingerprint.status}`);
assert(
  unauthorizedFingerprint.headers.get('www-authenticate') === 'Bearer',
  'fingerprint missing bearer challenge'
);
assert(
  JSON.stringify(await body(unauthorizedFingerprint)) === '{"error":"unauthorized"}',
  'fingerprint 401 body drifted'
);

const validResponse = await analyze('valid.wav');
const valid = await body(validResponse);
assert(validResponse.status === 200, `valid analysis status ${validResponse.status}`);
assert(valid.schemaVersion === '1', 'analysis schema drifted');
assert(valid.roleClassifier?.version === 'autosplit-role-v3', 'role version drifted');
assert(coreModels.some((model) => model.id === valid.decision?.resolvedCoreModel), 'unsupported decision');
assert(valid.timing?.analyzedSeconds > 0 && valid.timing.analyzedSeconds <= 45, 'invalid timing');
assert(valid.source?.schemaVersion === '1', 'analysis source identity schema drifted');
assert(/^[0-9a-f]{64}$/.test(valid.source?.sha256), 'analysis source hash is invalid');
assert(Number.isSafeInteger(valid.source?.bytes) && valid.source.bytes > 0, 'analysis source bytes are invalid');
await assertClean();

const authoritativeResponse = await analyzeAuthoritativeSnapshot();
const authoritative = await body(authoritativeResponse);
assert(authoritativeResponse.status === 200, `authoritative snapshot status ${authoritativeResponse.status}`);
assert(
  authoritative.source?.sha256 === valid.source.sha256 &&
    authoritative.source?.bytes === valid.source.bytes,
  'authoritative snapshot did not analyze the same stored bytes'
);
await assertClean();

const mismatchedScopeResponse = await analyzeAuthoritativeSnapshot('archive');
const mismatchedScope = await body(mismatchedScopeResponse);
assert(mismatchedScopeResponse.status === 400, `source-scope mismatch status ${mismatchedScopeResponse.status}`);
assert(mismatchedScope.error === 'source_type_scope_mismatch', 'source-scope mismatch was not rejected');
await assertClean();

const fingerprintResponse = await fingerprint('valid.wav');
const fingerprintResult = await body(fingerprintResponse);
assert(fingerprintResponse.status === 200, `valid fingerprint status ${fingerprintResponse.status}`);
assert(
  JSON.stringify(Object.keys(fingerprintResult).sort()) ===
    JSON.stringify(['schemaVersion', 'source', 'timing']),
  'fingerprint response surface drifted'
);
assert(fingerprintResult.schemaVersion === '1', 'fingerprint schema drifted');
assert(fingerprintResult.source?.sha256 === valid.source.sha256, 'fingerprint hash disagrees with analysis');
assert(fingerprintResult.source?.bytes === valid.source.bytes, 'fingerprint bytes disagree with analysis');
assert(fingerprintResult.timing?.totalMs >= 0, 'fingerprint timing is invalid');
await assertClean();

const maximumResponse = await analyze('max-duration.wav');
const maximum = await body(maximumResponse);
assert(maximumResponse.status === 200, `maximum-duration status ${maximumResponse.status}`);
assert(maximum.timing?.analyzedSeconds >= 44.9 && maximum.timing.analyzedSeconds <= 45, 'maximum-duration windows drifted');
await assertClean();

for (const [name, status, error] of [
  ['malformed.wav', 422, 'audio_unsupported'],
  ['declared-oversize.wav', 413, 'source_too_large'],
  ['streamed-oversize.wav', 413, 'source_too_large'],
  ['slow.wav', 502, 'source_fetch_timeout'],
]) {
  const response = await analyze(name);
  const result = await body(response);
  assert(response.status === status, `${name} status ${response.status}, expected ${status}`);
  assert(result.error === error, `${name} error ${result.error}, expected ${error}`);
  await assertClean();
}

const held = analyze('hold.wav');
await new Promise((resolve) => setTimeout(resolve, 250));
const busyResponse = await analyze('valid.wav');
const busy = await body(busyResponse);
assert(busyResponse.status === 503, `busy status ${busyResponse.status}`);
assert(busyResponse.headers.get('retry-after') === '1', 'busy response omitted Retry-After');
assert(busy.error === 'analysis_busy', `busy error ${busy.error}`);
const heldResponse = await held;
const heldResult = await body(heldResponse);
assert(heldResponse.status === 502, `held status ${heldResponse.status}`);
assert(heldResult.error === 'source_fetch_timeout', `held error ${heldResult.error}`);
await assertClean();

console.log(
  JSON.stringify({
    status: 'passed',
    ffmpegVersion: ready.ffmpegVersion,
    classifierVersion: ready.classifierVersion,
    sourceScopeVersion: ready.sourceScopeVersion,
    sourceFingerprint: 'verified',
    authoritativeSnapshot: 'verified',
    maximumAnalyzedSeconds: maximum.timing.analyzedSeconds,
    malformed: 'rejected',
    declaredOversize: 'rejected',
    streamedOversize: 'rejected',
    fetchTimeout: 'bounded',
    concurrency: 'bounded',
    temporarySources: 'clean',
  })
);
NODE

analysis_smoke_logs="$(docker logs "$analysis_smoke_container" 2>&1)"
if printf '%s\n' "$analysis_smoke_logs" | grep -E \
  'local-only-analysis-token|/api/local-sources/|signature=' >/dev/null; then
  printf '%s\n' 'audio-analysis logs exposed a token or signed source URL' >&2
  exit 1
fi

docker stats --no-stream "$analysis_smoke_container" \
  --format 'audio-analysis runtime cpu={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}'
