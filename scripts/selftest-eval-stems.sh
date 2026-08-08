#!/usr/bin/env bash
# Adversarial self-test for scripts/eval-stems.mjs.
#
#   ./scripts/selftest-eval-stems.sh <audio-file>
#
# The eval tool is the thing that decides whether a paid separation run was any
# good, so it needs its own ground truth. Every case below is built with ffmpeg
# from a recording the caller supplies, and the expected verdict is known by
# construction rather than by listening. No audio ships with this script.
#
# Two real defects were caught this way and both are regression-covered here:
#
#   1. A single lenient reconstruction threshold PASSED a deliberately
#      mis-renamed two-track split at 91.6% correlation — the exact failure the
#      tool exists to catch. Fixed by splitting complementary from independent
#      thresholds (cases correct-2 and wrong-rename).
#   2. Aligning each track to the source independently FAILED a split that sums
#      exactly, because a bass-dominated track's correlation peak wanders a few
#      samples and the relative shift destroys the sum. Fixed by summing first
#      and aligning once (case correct-2, which reconstructs to -29.8 dB).

set -euo pipefail

SOURCE="${1:-}"
if [[ -z "$SOURCE" || ! -r "$SOURCE" ]]; then
  echo "usage: $0 <audio-file>    (any recording you are allowed to test)" >&2
  exit 2
fi

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/eval-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
PASSES=0
FAILURES=0

mp3() { ffmpeg -v error -y -i "$1" -c:a libmp3lame -b:a 192k "$2"; }

# -8 dB of headroom so a complementary pair cannot clip, which would make the
# ground truth itself inexact and the whole comparison meaningless.
ffmpeg -v error -y -ss 20 -t 30 -i "$SOURCE" -map 0:a:0 -af "volume=-8dB" \
  -ac 2 -ar 44100 -c:a pcm_f32le "$WORK/mix.wav"
ffmpeg -v error -y -ss 90 -t 30 -i "$SOURCE" -map 0:a:0 -af "volume=-8dB" \
  -ac 2 -ar 44100 -c:a pcm_f32le "$WORK/elsewhere.wav"

# An exact two-way partition: low + high reconstructs the mix by construction.
ffmpeg -v error -y -i "$WORK/mix.wav" -af "lowpass=f=400" -c:a pcm_f32le "$WORK/low.wav"
ffmpeg -v error -y -i "$WORK/mix.wav" -i "$WORK/low.wav" \
  -filter_complex "[1]volume=-1[inv];[0][inv]amix=inputs=2:normalize=0[m]" \
  -map "[m]" -c:a pcm_f32le "$WORK/high.wav"

# A four-way partition, built by successive exact subtraction. Cascaded
# highpass/lowpass bands do NOT work here: those filters are IIR, so they shift
# phase and cross over at -3 dB, and four such bands reconstruct the mix at only
# ~77%. Subtracting each band from the running remainder keeps the sum exact,
# which is what makes the expected verdict knowable by construction.
subtract() {  # subtract <minuend> <subtrahend> <out>
  ffmpeg -v error -y -i "$1" -i "$2" \
    -filter_complex "[1]volume=-1[inv];[0][inv]amix=inputs=2:normalize=0[m]" \
    -map "[m]" -c:a pcm_f32le "$3"
}
ffmpeg -v error -y -i "$WORK/mix.wav" -af "lowpass=f=250" -c:a pcm_f32le "$WORK/q1.wav"
subtract "$WORK/mix.wav" "$WORK/q1.wav" "$WORK/rem1.wav"
ffmpeg -v error -y -i "$WORK/rem1.wav" -af "lowpass=f=1200" -c:a pcm_f32le "$WORK/q2.wav"
subtract "$WORK/rem1.wav" "$WORK/q2.wav" "$WORK/rem2.wav"
ffmpeg -v error -y -i "$WORK/rem2.wav" -af "lowpass=f=5000" -c:a pcm_f32le "$WORK/q3.wav"
subtract "$WORK/rem2.wav" "$WORK/q3.wav" "$WORK/q4.wav"

for name in low high q1 q2 q3 q4; do mp3 "$WORK/$name.wav" "$WORK/$name.mp3"; done
mp3 "$WORK/elsewhere.wav" "$WORK/elsewhere.mp3"

check() {
  local label="$1" expected="$2"; shift 2
  local output verdict
  set +e
  output="$(node scripts/eval-stems.mjs --label "$label" "$@" 2>&1)"
  set -e
  verdict="$(printf '%s\n' "$output" | sed -n 's/^verdict: //p' | tail -1)"
  [[ "$verdict" == "WARN" ]] && verdict="PASS"   # a WARN still exits 0
  if [[ "$verdict" == "$expected" ]]; then
    PASSES=$((PASSES + 1))
    printf '  ok    %-22s %s\n' "$label" "$(printf '%s\n' "$output" | sed -n 's/^reconstruction  //p')"
  else
    FAILURES=$((FAILURES + 1))
    printf '  FAIL  %-22s expected %s, got %s\n' "$label" "$expected" "$verdict"
    printf '%s\n' "$output" | sed 's/^/        /'
  fi
}

echo "eval-stems self-test on $(basename "$SOURCE")"

# The reconstruction must recognise an exact partition despite MP3 delay.
check correct-2 PASS --source "$WORK/mix.wav" --complementary \
  --stem instrumental="$WORK/low.mp3" --stem vocals="$WORK/high.mp3"

# The regression that matters most: "instrumental" pointed at audio that is not
# the complement of "vocals". Reconstruction is the only thing that sees this.
check wrong-rename FAIL --source "$WORK/mix.wav" --complementary \
  --stem instrumental="$WORK/q1.mp3" --stem vocals="$WORK/high.mp3"

# Tracks from a different passage of the same recording: right shape, wrong audio.
check foreign-audio FAIL --source "$WORK/mix.wav" --complementary \
  --stem instrumental="$WORK/elsewhere.mp3" --stem vocals="$WORK/high.mp3"

# One file served under two names — the provider-returned-a-duplicate case.
check duplicate-track FAIL --source "$WORK/mix.wav" --complementary \
  --stem instrumental="$WORK/high.mp3" --stem vocals="$WORK/high.mp3"

# A four-way partition scored with the looser independent thresholds.
check correct-4 PASS --source "$WORK/mix.wav" \
  --stem bass="$WORK/q1.mp3" --stem drums="$WORK/q2.mp3" \
  --stem other="$WORK/q3.mp3" --stem vocals="$WORK/q4.mp3"

# Complementary thresholds must reject what independent thresholds tolerate:
# the same mis-rename above is the case that used to slip through at 91.6%.
check wrong-rename-strict FAIL --source "$WORK/mix.wav" --complementary \
  --stem instrumental="$WORK/q2.mp3" --stem vocals="$WORK/high.mp3"

echo
echo "  $PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
