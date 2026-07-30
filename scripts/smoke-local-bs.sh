#!/usr/bin/env bash
# End-to-end localhost smoke test:
# synthetic WAV -> local R2 -> BS-RoFormer -> vocals + instrumental -> local R2

set -u

BASE="${BASE:-http://127.0.0.1:8787}"
CODE="${CLASS_CODE:-local-class-code}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1200}"
WORK_DIR="$(mktemp -d /tmp/stem-splitter-local-smoke.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

json_field() {
  python3 -c "import json,sys; print(json.load(sys.stdin)$1)"
}

fail() {
  echo "FAIL  $1" >&2
  exit 1
}

echo "== generate synthetic stereo source =="
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=220:duration=8" \
  -f lavfi -i "sine=frequency=880:duration=8" \
  -filter_complex "[0:a][1:a]amix=inputs=2,pan=stereo|c0=c0|c1=c0" \
  -c:a pcm_s16le "$WORK_DIR/source.wav"

echo "== upload to local Worker/R2 =="
UPLOAD_JSON="$(curl -sSf -X POST "$BASE/api/uploads" \
  -H 'content-type: application/json' \
  -H "x-class-code: $CODE" \
  -d '{"filename":"local-bs-roformer-smoke.wav"}')" || fail "could not create upload"
KEY="$(printf '%s' "$UPLOAD_JSON" | json_field "['key']")"
UPLOAD_URL="$(printf '%s' "$UPLOAD_JSON" | json_field "['uploadUrl']")"
curl -sSf -X PUT "$BASE$UPLOAD_URL" \
  -H 'content-type: audio/wav' \
  -H "x-class-code: $CODE" \
  --data-binary "@$WORK_DIR/source.wav" >/dev/null || fail "could not upload source"

echo "== create two-track BS-RoFormer job =="
JOB_JSON="$(curl -sSf -X POST "$BASE/api/jobs" \
  -H 'content-type: application/json' \
  -H "x-class-code: $CODE" \
  -d "{\"key\":\"$KEY\",\"filename\":\"local-bs-roformer-smoke.wav\",\"model\":\"bs_roformer_vocals\"}")" \
  || fail "could not create separation job"
JOB_ID="$(printf '%s' "$JOB_JSON" | json_field "['id']")"
echo "job $JOB_ID; waiting for the first model download/inference"

STARTED_AT="$(date +%s)"
while true; do
  STATUS_JSON="$(curl -sSf "$BASE/api/jobs/$JOB_ID")" || fail "could not poll job"
  STATUS="$(printf '%s' "$STATUS_JSON" | json_field "['status']")"
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  NOW="$(date +%s)"
  if [ $((NOW - STARTED_AT)) -ge "$TIMEOUT_SECONDS" ]; then
    fail "job timed out after ${TIMEOUT_SECONDS}s"
  fi
  sleep 5
done

if [ "$STATUS" = "failed" ]; then
  ERROR="$(printf '%s' "$STATUS_JSON" | json_field "['error']")"
  fail "separation failed: $ERROR"
fi

NAMES="$(printf '%s' "$STATUS_JSON" | python3 -c \
  'import json,sys; print(",".join(sorted(x["name"] for x in json.load(sys.stdin)["stems"])))')"
[ "$NAMES" = "instrumental,vocals" ] || fail "expected instrumental,vocals; got $NAMES"

printf '%s' "$STATUS_JSON" | python3 -c \
  'import json,sys; [print(x["name"], x["url"]) for x in json.load(sys.stdin)["stems"]]' \
  >"$WORK_DIR/stems.txt"
while read -r NAME URL; do
  curl -sSf "$BASE$URL?download" -o "$WORK_DIR/$NAME.mp3" || fail "could not download $NAME"
  ffprobe -v error -show_entries format=format_name -of default=nw=1:nk=1 \
    "$WORK_DIR/$NAME.mp3" | grep -q mp3 || fail "$NAME is not a readable MP3"
done <"$WORK_DIR/stems.txt"

echo "PASS  local BS-RoFormer job produced readable vocals + instrumental MP3s"
