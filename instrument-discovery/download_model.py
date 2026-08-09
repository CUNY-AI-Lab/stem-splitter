#!/usr/bin/env python3
"""Bake the exact CLAP snapshot into the image and record verified provenance."""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
from pathlib import Path

from constants import (
    MODEL_ARTIFACT_SHA256,
    MODEL_REPOSITORY,
    MODEL_REVISION,
    MODEL_WEIGHTS_SHA256,
)
from clap_backend import MODEL_PROVENANCE_FILE

MODEL_FILES = tuple(filename for filename, _digest in MODEL_ARTIFACT_SHA256)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(destination: Path) -> None:
    from huggingface_hub import snapshot_download

    destination.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        local_dir=destination,
        allow_patterns=list(MODEL_FILES),
    )
    missing = [filename for filename in MODEL_FILES if not (destination / filename).is_file()]
    if missing:
        raise RuntimeError(f"pinned CLAP snapshot is incomplete: {', '.join(missing)}")
    mismatched = [
        filename
        for filename, expected in MODEL_ARTIFACT_SHA256
        if not secrets.compare_digest(sha256_file(destination / filename), expected)
    ]
    if mismatched:
        raise RuntimeError(f"pinned CLAP artifact checksum mismatch: {', '.join(mismatched)}")
    (destination / MODEL_PROVENANCE_FILE).write_text(
        json.dumps(
            {
                "modelRevision": MODEL_REVISION,
                "weightsSha256": MODEL_WEIGHTS_SHA256,
                "artifactSha256": dict(MODEL_ARTIFACT_SHA256),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    download(args.destination)


if __name__ == "__main__":
    main()
