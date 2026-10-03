#!/usr/bin/env bash
# Firefox needs an actual output device for its media clock to advance on CI.
set -euo pipefail
if ! command -v pulseaudio >/dev/null || ! command -v pactl >/dev/null; then
  timeout --kill-after=10s 90s sudo apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update
  timeout --kill-after=10s 90s sudo apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install --yes pulseaudio pulseaudio-utils
fi
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=stem_test_audio
pactl set-default-sink stem_test_audio
pactl info
pactl list short sinks
