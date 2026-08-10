#!/usr/bin/env python3
"""Download and verify the exact official YAMNet TFLite comparator artifact."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from constants import (
    CLASS_MAP_BYTES,
    CLASS_MAP_SHA256,
    CLASS_MAP_URL,
    KAGGLE_INSTANCE_ID,
    KAGGLE_LICENSE,
    KAGGLE_METADATA_URL,
    KAGGLE_MODEL_ID,
    KAGGLE_VERSION_ID,
    KAGGLE_VERSION_NUMBER,
    LICENSE_BYTES,
    LICENSE_NAME,
    LICENSE_SHA256,
    LICENSE_URL,
    MODEL_ARCHIVE_ALLOWED_REDIRECT_HOST,
    MODEL_ARCHIVE_ALLOWED_REDIRECT_PATH,
    MODEL_ARCHIVE_BYTES,
    MODEL_ARCHIVE_SHA256,
    MODEL_ARCHIVE_URL,
    MODEL_BYTES,
    MODEL_MEMBER_NAME,
    MODEL_SHA256,
    TENSORFLOW_MODELS_REVISION,
)


class DownloadError(RuntimeError):
    """A remote artifact or its metadata drifted from the reviewed pin."""


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _bounded_download(url: str, maximum_bytes: int) -> tuple[bytes, str]:
    request = Request(url, headers={"User-Agent": "stem-splitter-yamnet-pin/1"})
    try:
        with urlopen(request, timeout=30) as response:
            declared = response.headers.get("Content-Length")
            if declared is not None:
                try:
                    declared_bytes = int(declared)
                except ValueError as error:
                    raise DownloadError("remote content length is invalid") from error
                if declared_bytes < 1 or declared_bytes > maximum_bytes:
                    raise DownloadError("remote content length exceeds the pin")
            result = bytearray()
            while True:
                block = response.read(min(1024 * 1024, maximum_bytes + 1 - len(result)))
                if not block:
                    break
                result.extend(block)
                if len(result) > maximum_bytes:
                    raise DownloadError("remote body exceeds the pin")
            return bytes(result), response.geturl()
    except DownloadError:
        raise
    except Exception as error:
        raise DownloadError("pinned YAMNet download failed") from error


def _official_metadata() -> dict[str, object]:
    raw, final_url = _bounded_download(KAGGLE_METADATA_URL, 512 * 1024)
    if final_url != KAGGLE_METADATA_URL:
        raise DownloadError("Kaggle metadata redirected unexpectedly")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DownloadError("Kaggle metadata is invalid") from error
    if not isinstance(document, dict) or not isinstance(document.get("models"), list):
        raise DownloadError("Kaggle metadata schema is invalid")
    matches = [
        model
        for model in document["models"]
        if isinstance(model, dict) and model.get("ref") == "google/yamnet"
    ]
    if len(matches) != 1 or matches[0].get("id") != KAGGLE_MODEL_ID:
        raise DownloadError("Kaggle YAMNet identity does not match")
    instances = matches[0].get("instances")
    if not isinstance(instances, list):
        raise DownloadError("Kaggle YAMNet instances are unavailable")
    candidates = [
        instance
        for instance in instances
        if isinstance(instance, dict)
        and instance.get("id") == KAGGLE_INSTANCE_ID
        and instance.get("slug") == "tflite"
        and instance.get("framework") == "tfLite"
        and instance.get("versionId") == KAGGLE_VERSION_ID
        and instance.get("versionNumber") == KAGGLE_VERSION_NUMBER
    ]
    if len(candidates) != 1:
        raise DownloadError("Kaggle YAMNet TFLite version does not match")
    instance = candidates[0]
    if (
        instance.get("licenseName") != KAGGLE_LICENSE
        or instance.get("totalUncompressedBytes") != MODEL_BYTES
        or instance.get("downloadUrl")
        != "/models/google/yamnet/TfLite/tflite/1/download"
    ):
        raise DownloadError("Kaggle YAMNet license or artifact metadata drifted")
    return {
        "provider": "Google via Kaggle Models",
        "modelId": KAGGLE_MODEL_ID,
        "instanceId": KAGGLE_INSTANCE_ID,
        "versionId": KAGGLE_VERSION_ID,
        "versionNumber": KAGGLE_VERSION_NUMBER,
        "license": KAGGLE_LICENSE,
    }


def _model_bytes() -> tuple[bytes, dict[str, object]]:
    archive, final_url = _bounded_download(MODEL_ARCHIVE_URL, MODEL_ARCHIVE_BYTES)
    final = urlsplit(final_url)
    if (
        final.scheme != "https"
        or final.hostname != MODEL_ARCHIVE_ALLOWED_REDIRECT_HOST
        or final.path != MODEL_ARCHIVE_ALLOWED_REDIRECT_PATH
        or final.username
        or final.password
        or final.fragment
    ):
        raise DownloadError("Kaggle model redirect left the reviewed artifact path")
    if len(archive) != MODEL_ARCHIVE_BYTES or _sha256(archive) != MODEL_ARCHIVE_SHA256:
        raise DownloadError("YAMNet archive does not match the pin")
    try:
        with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as bundle:
            members = bundle.getmembers()
            if (
                len(members) != 1
                or members[0].name != MODEL_MEMBER_NAME
                or not members[0].isfile()
                or members[0].issym()
                or members[0].islnk()
                or members[0].size != MODEL_BYTES
            ):
                raise DownloadError("YAMNet archive surface does not match the pin")
            source = bundle.extractfile(members[0])
            if source is None:
                raise DownloadError("YAMNet model member is unavailable")
            model = source.read(MODEL_BYTES + 1)
    except (tarfile.TarError, OSError) as error:
        raise DownloadError("YAMNet archive is invalid") from error
    if len(model) != MODEL_BYTES or _sha256(model) != MODEL_SHA256:
        raise DownloadError("YAMNet model does not match the pin")
    return model, {
        "archiveBytes": MODEL_ARCHIVE_BYTES,
        "archiveSha256": MODEL_ARCHIVE_SHA256,
        "modelBytes": MODEL_BYTES,
        "modelSha256": MODEL_SHA256,
    }


def _class_map_bytes() -> bytes:
    raw, final_url = _bounded_download(CLASS_MAP_URL, CLASS_MAP_BYTES)
    if final_url != CLASS_MAP_URL:
        raise DownloadError("YAMNet class map redirected unexpectedly")
    if len(raw) != CLASS_MAP_BYTES or _sha256(raw) != CLASS_MAP_SHA256:
        raise DownloadError("YAMNet class map does not match the pin")
    return raw


def _license_bytes() -> bytes:
    raw, final_url = _bounded_download(LICENSE_URL, LICENSE_BYTES)
    if final_url != LICENSE_URL:
        raise DownloadError("TensorFlow Models license redirected unexpectedly")
    if len(raw) != LICENSE_BYTES or _sha256(raw) != LICENSE_SHA256:
        raise DownloadError("TensorFlow Models license does not match the pin")
    return raw


def download(target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise DownloadError("YAMNet target already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    metadata = _official_metadata()
    model, artifact = _model_bytes()
    class_map = _class_map_bytes()
    license_text = _license_bytes()
    provenance = {
        "artifact": artifact,
        "classMap": {
            "bytes": CLASS_MAP_BYTES,
            "sha256": CLASS_MAP_SHA256,
            "tensorflowModelsRevision": TENSORFLOW_MODELS_REVISION,
        },
        "license": {
            "bytes": LICENSE_BYTES,
            "name": KAGGLE_LICENSE,
            "sha256": LICENSE_SHA256,
            "tensorflowModelsRevision": TENSORFLOW_MODELS_REVISION,
        },
        "officialMetadata": metadata,
    }
    temporary = Path(tempfile.mkdtemp(prefix="yamnet-", dir=target.parent))
    try:
        (temporary / MODEL_MEMBER_NAME).write_bytes(model)
        (temporary / "yamnet_class_map.csv").write_bytes(class_map)
        (temporary / LICENSE_NAME).write_bytes(license_text)
        (temporary / "stem-splitter-model.json").write_text(
            json.dumps(provenance, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        for path in temporary.iterdir():
            path.chmod(0o444)
        temporary.chmod(0o555)
        os.replace(temporary, target)
    except Exception:
        temporary.chmod(0o755)
        shutil.rmtree(temporary, ignore_errors=True)
        raise


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
