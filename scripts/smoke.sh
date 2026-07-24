#!/usr/bin/env bash
# Smoke test for the deployed stem-splitter Worker.
#
#   ./scripts/smoke.sh                  # free checks only (no predictions created)
#   ./scripts/smoke.sh <job-id>         # + labels/annotations round-trip on a done job
#   ./scripts/smoke.sh --full           # + real YouTube import → 6 stems (~$0.06, ~2 min)
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

check "uploads/ keys never served → 404" 404 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/files/uploads/x/source.m4a")"

check "unknown job → 404" 404 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/jobs/00000000-0000-0000-0000-000000000000")"

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
fi

if [ "$FULL" = 1 ]; then
  echo "== full pipeline (costs ~\$0.06): YouTube → 6 stems =="
  R=$(curl -sS -m 300 -X POST "$BASE/api/jobs" -H 'content-type: application/json' -H "x-class-code: $CODE" \
    -d '{"youtubeUrl":"https://www.youtube.com/watch?v=jNQXAC9IVRw","model":"htdemucs_6s"}')
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
    check "6 stems produced" 6 "$(curl -sS "$BASE/api/jobs/$NEW_JOB" | json "['stems'].__len__()")"
  fi
fi

echo "== $PASS passed, $FAIL failed =="
exit $((FAIL > 0))
