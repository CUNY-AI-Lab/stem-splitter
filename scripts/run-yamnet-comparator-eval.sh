#!/bin/sh
set -eu

yamnet_eval_image="${YAMNET_COMPARATOR_IMAGE:-stem-splitter-yamnet-comparator:v3.2-candidate}"

case "$yamnet_eval_image" in
  ''|*[!A-Za-z0-9_./:@+-]*)
    printf '%s\n' 'YAMNET_COMPARATOR_IMAGE is invalid' >&2
    exit 2
    ;;
esac

exec npm run --silent eval:yamnet -- --image "$yamnet_eval_image" "$@"
