#!/usr/bin/env python3
"""Bounded stdin/stdout interface for offline YAMNet candidate evaluation."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from backend import YamnetBackend
from constants import (
    CLASSIFIER_VERSION,
    CLASS_MAP_SHA256,
    INPUT_SAMPLE_RATE,
    MAPPING_SHA256,
    MAX_OUTPUT_BYTES,
    MAX_PCM_BYTES,
    MODEL_SHA256,
    OUTPUT_SCHEMA,
    SCORING_POLICY_VERSION,
    VOCABULARY_SHA256,
    VOCABULARY_VERSION,
)
from contract import ComparatorContractError, decode_pcm_windows, parse_window_counts


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="offline YAMNet comparator")
    parser.add_argument("--window-samples", required=True)
    parser.add_argument("--sample-rate", type=int, required=True)
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        payload = sys.stdin.buffer.read(MAX_PCM_BYTES + 1)
        if len(payload) > MAX_PCM_BYTES:
            raise ComparatorContractError("PCM body exceeds the comparator limit")
        counts = parse_window_counts(args.window_samples, len(payload))
        windows = decode_pcm_windows(payload, counts)
        backend = YamnetBackend(
            Path("/models/yamnet"),
            Path("/app/mapping.json"),
            Path("/app/vocabulary.json"),
            threads=args.threads,
        )
        started = time.monotonic()
        backend.warm()
        results = backend.score(windows, args.sample_rate)
        total_ms = round((time.monotonic() - started) * 1000)
        response = {
            "$schema": OUTPUT_SCHEMA,
            "classifierVersion": CLASSIFIER_VERSION,
            "modelSha256": MODEL_SHA256,
            "classMapSha256": CLASS_MAP_SHA256,
            "mappingSha256": MAPPING_SHA256,
            "vocabularyVersion": VOCABULARY_VERSION,
            "vocabularySha256": VOCABULARY_SHA256,
            "scoringPolicyVersion": SCORING_POLICY_VERSION,
            "inputSampleRate": INPUT_SAMPLE_RATE,
            "windowsAnalyzed": len(results),
            "loadMs": backend.load_ms,
            "timingMs": total_ms,
            "windows": results,
        }
        encoded = (json.dumps(response, sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        if len(encoded) > MAX_OUTPUT_BYTES:
            raise ComparatorContractError("YAMNet comparator output exceeds the limit")
        sys.stdout.buffer.write(encoded)
        return 0
    except ComparatorContractError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        # Do not reflect model/runtime details into an evaluator that may retain logs.
        print("YAMNet comparator failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
