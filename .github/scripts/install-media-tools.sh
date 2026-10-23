#!/usr/bin/env bash
# Avoid an unbounded apt mirror wait when the hosted image has the tool already.
set -euo pipefail

case "${1:-}" in
  ffmpeg)
    if command -v ffmpeg >/dev/null 2>&1; then
      ffmpeg -version
      exit 0
    fi
    # Hosted Azure package downloads can exhaust the setup deadline. Use the
    # official Ubuntu archive with the same signed package metadata instead.
    if [[ "${GITHUB_ACTIONS:-}" == true && -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
      sudo sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources
    fi
    # Hosted runners usually have a usable package index. Refresh it only when
    # installation needs newer metadata, rather than waiting on every mirror.
    if timeout --kill-after=10s 45s sudo apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10 install --yes --no-install-recommends ffmpeg; then
      ffmpeg -version
      exit 0
    fi
    for attempt in 1 2; do
      if timeout --kill-after=10s 180s sudo apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update &&
         timeout --kill-after=10s 240s sudo apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install --yes --no-install-recommends ffmpeg; then
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
