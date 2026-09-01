#!/bin/sh
set -eu

efficientat_eval_image="${EFFICIENTAT_COMPARATOR_IMAGE:-stem-splitter-efficientat-comparator:v3.2-candidate}"

case "$efficientat_eval_image" in
  ''|*[!A-Za-z0-9_./:@+-]*)
    printf '%s\n' 'EFFICIENTAT_COMPARATOR_IMAGE is invalid' >&2
    exit 2
    ;;
esac

exec node --import tsx scripts/eval-efficientat-comparator.mts \
  --image "$efficientat_eval_image" "$@"
