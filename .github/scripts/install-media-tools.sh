#!/usr/bin/env bash
# Avoid an unbounded apt mirror wait when the hosted image has the tool already.
set -euo pipefail

case "${1:-}" in
  ffmpeg)
    if command -v ffmpeg >/dev/null 2>&1; then
      ffmpeg -version
      exit 0
    fi
    for attempt in 1 2; do
      if timeout --kill-after=10s 180s sudo apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update &&
         timeout --kill-after=10s 180s sudo apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install --yes ffmpeg; then
        ffmpeg -version
        exit 0
      fi
      echo "FFmpeg setup attempt $attempt failed."
    done
    ;;
  chrome)
    # This is the executable Playwright's chrome channel uses on Linux.
    if test -x /opt/google/chrome/chrome; then
      /opt/google/chrome/chrome --version
      exit 0
    fi
    for attempt in 1 2; do
      if timeout --kill-after=10s 240s bun run playwright -- install --with-deps chrome; then
        /opt/google/chrome/chrome --version
        exit 0
      fi
      echo "Chrome setup attempt $attempt failed."
    done
    ;;
  *) echo 'Expected ffmpeg or chrome.' >&2; exit 2 ;;
esac
echo 'Required media dependency is unavailable; tests cannot run.' >&2
exit 1
