#!/usr/bin/env bash
# Smoke test for the deployed stem-splitter Worker.
#
#   ./scripts/smoke.sh                  # free checks only (no predictions created)
#   ./scripts/smoke.sh <job-id>         # + labels/annotations round-trip on a done job
#   SMOKE_YOUTUBE_URL=<url> ./scripts/smoke.sh --full   # + real YouTube import → 6 stems
#   SMOKE_MODEL=vocals_instrumental SMOKE_YOUTUBE_URL=<url> ./scripts/smoke.sh --full   # 2-stem instead
#   SMOKE_ASSISTANT=1 ./scripts/smoke.sh <job-id>   # + listening-guy guide/chat checks (<1¢)
#
# Class code comes from $CLASS_CODE (required — never hardcode it here).

set -u
BASE="${BASE:-https://stem-splitter.ailab-452.workers.dev}"
CODE="${CLASS_CODE:?set CLASS_CODE to the current class code}"
JOB_ID=""
FULL=0
[ "${1:-}" = "--full" ] && FULL=1
[ -n "${1:-}" ] && [ "$1" != "--full" ] && JOB_ID="$1"

PASS=0; FAIL=0
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok    $1"
  else FAIL=$((FAIL+1)); echo "  FAIL  $1  (expected: $2, got: $3)"; fi
}
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)" 2>/dev/null; }

echo "== free checks against $BASE =="

check "frontend serves import UI" 1 \
  "$(curl -sS "$BASE/" | grep -q 'yt-form' && echo 1 || echo 0)"

check "auth-check with class code → 200" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/auth-check" -H "x-class-code: $CODE")"

check "auth-check with wrong code → 401" 401 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/auth-check" -H 'x-class-code: definitely-wrong')"

check "job create without class code → 401" 401 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs" -H 'content-type: application/json' -d '{}')"

check "bad model rejected → 400" 400 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{"youtubeUrl":"x","model":"bogus"}')"

check "non-YouTube URL rejected → 400" 400 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{"youtubeUrl":"https://example.com/x","model":"htdemucs_ft"}')"

check "split choices advertise 2, 4 and 6 tracks" "2 4 6" \
  "$(curl -sS "$BASE/api/separation-options" | python3 -c "import json,sys; print(*sorted(len(m['stems']) for m in json.load(sys.stdin)['models']))")"

check "split choices keep the 4-track default" htdemucs_ft \
  "$(curl -sS "$BASE/api/separation-options" | json "['defaultModel']")"

check "split choices never leak runner wiring" 1 \
  "$(curl -sS "$BASE/api/separation-options" | python3 -c "import json,sys; print(int(all(set(m)=={'id','stems','label','engine'} for m in json.load(sys.stdin)['models'])))")"

# The model allowlist (src/index.ts) runs before the URL parse, so a 400 with
# code invalid_youtube_url proves the two-track id passed the allowlist in
# production without creating a prediction. Costs nothing.
check "two-track choice accepted by the allowlist" invalid_youtube_url \
  "$(curl -sS -X POST "$BASE/api/jobs" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{"youtubeUrl":"x","model":"vocals_instrumental"}' | json "['code']")"

check "uploads/ keys never served → 404" 404 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/files/uploads/x/source.m4a")"

check "unknown job → 404" 404 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/jobs/00000000-0000-0000-0000-000000000000")"

check "guide without class code → 401" 401 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs/00000000-0000-0000-0000-000000000000/guide" -H 'content-type: application/json' -d '{}')"

check "guide on unknown job → 404" 404 \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs/00000000-0000-0000-0000-000000000000/guide" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{}')"

if [ -n "$JOB_ID" ]; then
  echo "== round-trip checks on job $JOB_ID =="
  STATUS=$(curl -sS "$BASE/api/jobs/$JOB_ID" | json "['status']")
  check "job is done" done "$STATUS"

  STEM=$(curl -sS "$BASE/api/jobs/$JOB_ID" | json "['stems'][0]['name']")
  curl -sS -o /dev/null -X PUT "$BASE/api/jobs/$JOB_ID/labels" -H 'content-type: application/json' -H "x-class-code: $CODE" -d "{\"labels\":{\"$STEM\":\"smoke-label\"}}"
  check "label round-trip" smoke-label \
    "$(curl -sS "$BASE/api/jobs/$JOB_ID" | json "['labels']['$STEM']")"
  curl -sS -o /dev/null -X PUT "$BASE/api/jobs/$JOB_ID/labels" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{"labels":{}}'

  NOTE_ID=$(curl -sS -X POST "$BASE/api/jobs/$JOB_ID/annotations" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{"atSeconds":1.5,"text":"smoke"}' | json "['id']")
  check "annotation created" smoke \
    "$(curl -sS "$BASE/api/jobs/$JOB_ID/annotations" -o /dev/null; curl -sS "$BASE/api/jobs/$JOB_ID" | json "['annotations'][-1]['text']")"
  curl -sS -o /dev/null -X DELETE "$BASE/api/jobs/$JOB_ID/annotations/$NOTE_ID" -H "x-class-code: $CODE"
  check "annotation deleted" 0 \
    "$(curl -sS "$BASE/api/jobs/$JOB_ID" | json "['annotations']" | python3 -c 'import sys; print(0 if "smoke" not in sys.stdin.read() else 1)')"

  STEM_URL=$(curl -sS "$BASE/api/jobs/$JOB_ID" | json "['stems'][0]['url']")
  check "stem serves as audio" audio/mpeg \
    "$(curl -sS -o /dev/null -w '%{content_type}' "$BASE$STEM_URL")"

  check "chat with empty messages → 400" 400 \
    "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs/$JOB_ID/chat" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{"messages":[]}')"
fi

if [ "${SMOKE_ASSISTANT:-0}" = 1 ] && [ -n "$JOB_ID" ]; then
  echo "== listening-guy checks on job $JOB_ID (one guide + one chat, <1¢) =="
  G=$(mktemp)
  GCODE=$(curl -sS -o "$G" -w '%{http_code}' -m 120 -X POST "$BASE/api/jobs/$JOB_ID/guide" \
    -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{}')
  if [ "$GCODE" = "503" ]; then
    echo "  skip  assistant not configured on this deployment (503)"
  else
    check "guide endpoint → 200" 200 "$GCODE"
    check "guide has text" 1 "$(json "['guide']['text']" <"$G" | grep -q . && echo 1 || echo 0)"
    check "second guide call cached" True \
      "$(curl -sS -m 30 -X POST "$BASE/api/jobs/$JOB_ID/guide" -H 'content-type: application/json' -H "x-class-code: $CODE" -d '{}' | json "['cached']")"
    check "chat replies" 1 \
      "$(curl -sS -m 120 -X POST "$BASE/api/jobs/$JOB_ID/chat" -H 'content-type: application/json' -H "x-class-code: $CODE" \
        -d '{"messages":[{"role":"user","content":"One short sentence: what should I listen for in the bass?"}]}' | json "['reply']" | grep -q . && echo 1 || echo 0)"
  fi
  rm -f "$G"
fi

if [ "$FULL" = 1 ]; then
  # SMOKE_MODEL=vocals_instrumental exercises the two-track split instead.
  SMOKE_MODEL="${SMOKE_MODEL:-htdemucs_6s}"
  echo "== full pipeline (costs ~\$0.06): YouTube → $SMOKE_MODEL =="
  if [ -z "${SMOKE_YOUTUBE_URL:-}" ]; then
    FAIL=$((FAIL+1)); echo "  FAIL  set SMOKE_YOUTUBE_URL to audio you are allowed to test"
  else
    YOUTUBE_PAYLOAD=$(python3 -c \
      'import json,sys; print(json.dumps({"youtubeUrl":sys.argv[1],"model":sys.argv[2]}))' \
      "$SMOKE_YOUTUBE_URL" "$SMOKE_MODEL")
    R=$(curl -sS -m 300 -X POST "$BASE/api/jobs" -H 'content-type: application/json' -H "x-class-code: $CODE" \
      -d "$YOUTUBE_PAYLOAD")
    NEW_JOB=$(echo "$R" | json "['id']")
    if [ -z "$NEW_JOB" ]; then
      FAIL=$((FAIL+1)); echo "  FAIL  youtube import: $R"
    else
      echo "  ...   job $NEW_JOB created, polling (up to 5 min)"
      for i in $(seq 1 20); do
        S=$(curl -sS "$BASE/api/jobs/$NEW_JOB" | json "['status']")
        [ "$S" = "done" ] || [ "$S" = "failed" ] && break
        sleep 15
      done
      check "youtube import completes" done "$S"
      # Derived from the contract the Worker promised, not a hardcoded count.
      EXPECTED=$(curl -sS "$BASE/api/jobs/$NEW_JOB" | json "['expectedStems'].__len__()")
      check "promised stems produced" "$EXPECTED" \
        "$(curl -sS "$BASE/api/jobs/$NEW_JOB" | json "['stems'].__len__()")"
      check "stem names match the contract" 1 \
        "$(curl -sS "$BASE/api/jobs/$NEW_JOB" | python3 -c "import json,sys; j=json.load(sys.stdin); print(int([s['name'] for s in j['stems']]==j['expectedStems']))")"
    fi
  fi
fi

echo "== $PASS passed, $FAIL failed =="
exit $((FAIL > 0))
