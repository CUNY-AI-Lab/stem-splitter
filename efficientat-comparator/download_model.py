#!/usr/bin/env python3
"""Download, verify, and safely convert the exact EfficientAT release weight."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from constants import (
    CLASS_MAP_BYTES,
    CLASS_MAP_NAME,
    CLASS_MAP_SHA256,
    CLASS_MAP_URL,
    MODEL_ASSET_ID,
    MODEL_ASSET_NAME,
    MODEL_BYTES,
    MODEL_REDIRECT_HOST,
    MODEL_REDIRECT_PATH,
    MODEL_SHA256,
    MODEL_TENSOR_COUNT,
    MODEL_TENSOR_ELEMENTS,
    MODEL_URL,
    RELEASE_METADATA_URL,
    SAFE_WEIGHTS_BYTES,
    SAFE_WEIGHTS_NAME,
    SAFE_WEIGHTS_SHA256,
    UPSTREAM_LICENSE,
    UPSTREAM_LICENSE_BYTES,
    UPSTREAM_LICENSE_NAME,
    UPSTREAM_LICENSE_SHA256,
    UPSTREAM_LICENSE_URL,
    UPSTREAM_RELEASE_ID,
    UPSTREAM_RELEASE_PUBLISHED_AT,
    UPSTREAM_RELEASE_TAG,
    UPSTREAM_REPOSITORY,
    UPSTREAM_REVISION,
    UPSTREAM_SOURCE_SHA256,
)


class DownloadError(RuntimeError):
    """The official metadata, artifact, or conversion did not match its pin."""


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def bounded_download(url: str, maximum_bytes: int) -> tuple[bytes, str, str]:
    request = Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "stem-splitter-efficientat-pin/1",
        },
    )
    try:
        with urlopen(request, timeout=45) as response:
            declared = response.headers.get("Content-Length")
            if declared is not None and (not declared.isdigit() or int(declared) > maximum_bytes):
                raise DownloadError("remote content length exceeds the pin")
            body = bytearray()
            while True:
                block = response.read(min(1024 * 1024, maximum_bytes + 1 - len(body)))
                if not block:
                    break
                body.extend(block)
                if len(body) > maximum_bytes:
                    raise DownloadError("remote body exceeds the pin")
            return bytes(body), response.geturl(), response.headers.get_content_type()
    except DownloadError:
        raise
    except Exception as error:
        raise DownloadError("pinned EfficientAT download failed") from error


def verify_release_metadata() -> None:
    raw, final_url, content_type = bounded_download(RELEASE_METADATA_URL, 1024 * 1024)
    if final_url != RELEASE_METADATA_URL or content_type != "application/json":
        raise DownloadError("EfficientAT release metadata transport drifted")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DownloadError("EfficientAT release metadata is invalid") from error
    if (
        not isinstance(document, dict)
        or document.get("id") != UPSTREAM_RELEASE_ID
        or document.get("tag_name") != UPSTREAM_RELEASE_TAG
        or document.get("published_at") != UPSTREAM_RELEASE_PUBLISHED_AT
        or document.get("html_url")
        != f"https://github.com/{UPSTREAM_REPOSITORY}/releases/tag/{UPSTREAM_RELEASE_TAG}"
        or not isinstance(document.get("assets"), list)
    ):
        raise DownloadError("EfficientAT release identity drifted")
    matches = [
        asset
        for asset in document["assets"]
        if isinstance(asset, dict) and asset.get("id") == MODEL_ASSET_ID
    ]
    if len(matches) != 1 or {
        "name": matches[0].get("name"),
        "size": matches[0].get("size"),
        "state": matches[0].get("state"),
        "content_type": matches[0].get("content_type"),
        "browser_download_url": matches[0].get("browser_download_url"),
    } != {
        "name": MODEL_ASSET_NAME,
        "size": MODEL_BYTES,
        "state": "uploaded",
        "content_type": "application/octet-stream",
        "browser_download_url": MODEL_URL,
    }:
        raise DownloadError("EfficientAT release asset metadata drifted")


def pinned_file(url: str, expected_bytes: int, expected_sha256: str, context: str) -> bytes:
    raw, final_url, _content_type = bounded_download(url, expected_bytes)
    if final_url != url or len(raw) != expected_bytes or sha256(raw) != expected_sha256:
        raise DownloadError(f"{context} does not match the pin")
    return raw


def model_bytes() -> bytes:
    raw, final_url, content_type = bounded_download(MODEL_URL, MODEL_BYTES)
    final = urlsplit(final_url)
    if (
        final.scheme != "https"
        or final.hostname != MODEL_REDIRECT_HOST
        or final.path != MODEL_REDIRECT_PATH
        or final.username
        or final.password
        or final.fragment
        or content_type != "application/octet-stream"
        or len(raw) != MODEL_BYTES
        or sha256(raw) != MODEL_SHA256
    ):
        raise DownloadError("EfficientAT model artifact does not match the pin")
    return raw


def convert_weights(source_path: Path, output_path: Path) -> None:
    import torch
    from safetensors.torch import load_file, save_file

    try:
        unsafe_globals = torch.serialization.get_unsafe_globals_in_checkpoint(source_path)
    except Exception as error:
        raise DownloadError("EfficientAT checkpoint safety scan failed") from error
    if unsafe_globals:
        raise DownloadError("EfficientAT checkpoint contains unsafe globals")
    try:
        state = torch.load(source_path, map_location="cpu", weights_only=True)
    except Exception as error:
        raise DownloadError("EfficientAT checkpoint could not be loaded safely") from error
    if (
        type(state).__name__ != "OrderedDict"
        or len(state) != MODEL_TENSOR_COUNT
        or sum(value.numel() for value in state.values()) != MODEL_TENSOR_ELEMENTS
        or any(
            not isinstance(name, str)
            or not name
            or not isinstance(value, torch.Tensor)
            or value.device.type != "cpu"
            or not value.is_contiguous()
            for name, value in state.items()
        )
    ):
        raise DownloadError("EfficientAT state dictionary surface drifted")
    # safetensors 0.5.3 stores multiple metadata entries through a Rust hash
    # map, so their serialized order is not deterministic. Provenance remains
    # in the separately pinned JSON file; omitting embedded metadata makes the
    # safe artifact reproducible byte for byte across builds.
    try:
        save_file(dict(state), output_path)
    except Exception as error:
        raise DownloadError("EfficientAT safetensors write failed") from error
    if output_path.stat().st_size != SAFE_WEIGHTS_BYTES:
        raise DownloadError("EfficientAT safetensors byte length drifted")
    if sha256(output_path.read_bytes()) != SAFE_WEIGHTS_SHA256:
        raise DownloadError("EfficientAT safetensors conversion drifted")
    try:
        restored = load_file(output_path, device="cpu")
    except Exception as error:
        raise DownloadError("EfficientAT safetensors reload failed") from error
    if set(restored) != set(state) or any(
        not torch.equal(state[name], restored[name]) for name in state
    ):
        raise DownloadError("EfficientAT safetensors round trip drifted")


def download(target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise DownloadError("EfficientAT target already exists")
    verify_release_metadata()
    model = model_bytes()
    class_map = pinned_file(
        CLASS_MAP_URL, CLASS_MAP_BYTES, CLASS_MAP_SHA256, "EfficientAT class map"
    )
    license_text = pinned_file(
        UPSTREAM_LICENSE_URL,
        UPSTREAM_LICENSE_BYTES,
        UPSTREAM_LICENSE_SHA256,
        "EfficientAT license",
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="efficientat-", dir=target.parent))
    checkpoint = temporary / MODEL_ASSET_NAME
    installed = False
    stage = "checkpoint-write"
    try:
        checkpoint.write_bytes(model)
        stage = "safe-conversion"
        convert_weights(checkpoint, temporary / SAFE_WEIGHTS_NAME)
        stage = "checkpoint-removal"
        checkpoint.unlink()
        stage = "metadata-write"
        (temporary / CLASS_MAP_NAME).write_bytes(class_map)
        (temporary / UPSTREAM_LICENSE_NAME).write_bytes(license_text)
        provenance = {
            "conversion": {
                "format": "safetensors",
                "sourceBytes": MODEL_BYTES,
                "sourceSha256": MODEL_SHA256,
                "tensorCount": MODEL_TENSOR_COUNT,
                "tensorElements": MODEL_TENSOR_ELEMENTS,
                "weightsBytes": SAFE_WEIGHTS_BYTES,
                "weightsSha256": SAFE_WEIGHTS_SHA256,
                "weightsOnlyLoad": True,
                "exactTensorRoundTrip": True,
            },
            "license": {
                "name": UPSTREAM_LICENSE,
                "bytes": UPSTREAM_LICENSE_BYTES,
                "sha256": UPSTREAM_LICENSE_SHA256,
            },
            "release": {
                "assetId": MODEL_ASSET_ID,
                "assetName": MODEL_ASSET_NAME,
                "releaseId": UPSTREAM_RELEASE_ID,
                "repository": UPSTREAM_REPOSITORY,
                "tag": UPSTREAM_RELEASE_TAG,
            },
            "source": {
                "revision": UPSTREAM_REVISION,
                "sha256": UPSTREAM_SOURCE_SHA256,
            },
        }
        (temporary / "stem-splitter-model.json").write_text(
            json.dumps(provenance, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        stage = "artifact-permissions"
        for path in temporary.iterdir():
            path.chmod(0o444)
        stage = "atomic-install"
        os.replace(temporary, target)
        installed = True
        stage = "directory-permissions"
        target.chmod(0o555)
    except Exception as error:
        cleanup = target if installed else temporary
        if cleanup.exists():
            cleanup.chmod(0o755)
            shutil.rmtree(cleanup, ignore_errors=True)
        if isinstance(error, DownloadError):
            raise
        raise DownloadError(f"EfficientAT model could not be installed during {stage}") from error


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: download_model.py TARGET", file=sys.stderr)
        return 2
    try:
        download(Path(sys.argv[1]))
    except DownloadError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
