"""Pinned, offline LiteRT inference backend for the YAMNet comparator."""

from __future__ import annotations

import hashlib
import json
import math
import secrets
import time
from pathlib import Path
from typing import Optional, Sequence, Union

from constants import (
    CLASS_COUNT,
    CLASS_MAP_BYTES,
    CLASS_MAP_SHA256,
    INPUT_SAMPLE_RATE,
    KAGGLE_INSTANCE_ID,
    KAGGLE_LICENSE,
    KAGGLE_MODEL_ID,
    KAGGLE_VERSION_ID,
    KAGGLE_VERSION_NUMBER,
    LICENSE_BYTES,
    LICENSE_NAME,
    LICENSE_SHA256,
    MODEL_ARCHIVE_BYTES,
    MODEL_ARCHIVE_SHA256,
    MODEL_BYTES,
    MODEL_MEMBER_NAME,
    MODEL_MINIMUM_SAMPLES,
    MODEL_SAMPLE_RATE,
    MODEL_SHA256,
    TENSORFLOW_MODELS_REVISION,
    TOP_CLASS_COUNT,
    TOP_PATCH_COUNT,
)
from contract import (
    AudioSetClass,
    ComparatorContractError,
    ComparatorMapping,
    load_class_map,
    load_mapping,
    summarize_patch_values,
)

MODEL_PROVENANCE_NAME = "stem-splitter-model.json"
CLASS_MAP_NAME = "yamnet_class_map.csv"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise ComparatorContractError("YAMNet model artifact is unavailable") from error
    return digest.hexdigest()


def verify_model_directory(model_dir: Path) -> tuple[Path, Path]:
    expected_names = {
        MODEL_MEMBER_NAME,
        CLASS_MAP_NAME,
        LICENSE_NAME,
        MODEL_PROVENANCE_NAME,
    }
    try:
        entries = tuple(model_dir.iterdir())
    except OSError as error:
        raise ComparatorContractError("YAMNet model directory is unavailable") from error
    if (
        {entry.name for entry in entries} != expected_names
        or any(entry.is_symlink() or not entry.is_file() for entry in entries)
    ):
        raise ComparatorContractError("YAMNet model directory surface does not match")
    model_path = model_dir / MODEL_MEMBER_NAME
    class_map_path = model_dir / CLASS_MAP_NAME
    license_path = model_dir / LICENSE_NAME
    try:
        if (
            model_path.stat().st_size != MODEL_BYTES
            or class_map_path.stat().st_size != CLASS_MAP_BYTES
            or license_path.stat().st_size != LICENSE_BYTES
        ):
            raise ComparatorContractError("YAMNet model artifact byte length does not match")
    except OSError as error:
        raise ComparatorContractError("YAMNet model artifact is unavailable") from error
    if not secrets.compare_digest(_sha256_file(model_path), MODEL_SHA256):
        raise ComparatorContractError("YAMNet model checksum does not match")
    # load_class_map also validates its exact byte length, digest, row count,
    # sequential indexes, and unique AudioSet machine ids.
    load_class_map(class_map_path)
    if not secrets.compare_digest(_sha256_file(license_path), LICENSE_SHA256):
        raise ComparatorContractError("YAMNet model license checksum does not match")
    try:
        provenance = json.loads((model_dir / MODEL_PROVENANCE_NAME).read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ComparatorContractError("YAMNet model provenance is unavailable") from error
    if provenance != {
        "artifact": {
            "archiveBytes": MODEL_ARCHIVE_BYTES,
            "archiveSha256": MODEL_ARCHIVE_SHA256,
            "modelBytes": MODEL_BYTES,
            "modelSha256": MODEL_SHA256,
        },
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
        "officialMetadata": {
            "provider": "Google via Kaggle Models",
            "modelId": KAGGLE_MODEL_ID,
            "instanceId": KAGGLE_INSTANCE_ID,
            "versionId": KAGGLE_VERSION_ID,
            "versionNumber": KAGGLE_VERSION_NUMBER,
            "license": KAGGLE_LICENSE,
        },
    }:
        raise ComparatorContractError("YAMNet model provenance does not match")
    return model_path, class_map_path


def _rounded(value: float) -> float:
    converted = float(value)
    if not math.isfinite(converted) or converted < 0 or converted > 1:
        raise ComparatorContractError("YAMNet score is outside [0, 1]")
    return round(converted, 8)


class YamnetBackend:
    """One-thread comparator that loads no code or artifact from the network."""

    def __init__(
        self,
        model_dir: Path,
        mapping_path: Path,
        vocabulary_path: Path,
        *,
        threads: int = 1,
    ) -> None:
        if threads < 1 or threads > 2:
            raise ComparatorContractError("LiteRT thread count is invalid")
        self.model_dir = model_dir
        self.mapping_path = mapping_path
        self.vocabulary_path = vocabulary_path
        self.threads = threads
        self.mapping: Optional[ComparatorMapping] = None
        self.class_map: tuple[AudioSetClass, ...] = ()
        self.load_ms = 0
        self._interpreter = None
        self._input_index: Optional[int] = None
        self._scores_index: Optional[int] = None
        self._numpy = None
        self._resample_poly = None

    def warm(self) -> None:
        started = time.monotonic()
        model_path, class_map_path = verify_model_directory(self.model_dir)
        mapping = load_mapping(self.mapping_path, self.vocabulary_path, class_map_path)

        # Heavy candidate-only dependencies stay out of contract tests and the
        # application runtime. LiteRT loads the already verified local flatbuffer.
        import numpy as np
        from ai_edge_litert.interpreter import Interpreter
        from scipy.signal import resample_poly

        interpreter = Interpreter(model_path=str(model_path), num_threads=self.threads)
        inputs = interpreter.get_input_details()
        outputs = interpreter.get_output_details()
        if (
            len(inputs) != 1
            or inputs[0]["name"] != "waveform"
            or inputs[0]["shape_signature"].tolist() != [-1]
            or inputs[0]["dtype"] != np.float32
            or len(outputs) != 3
        ):
            raise ComparatorContractError("YAMNet LiteRT input contract does not match")
        output_by_width: dict[int, dict[str, object]] = {}
        for output in outputs:
            signature = output["shape_signature"].tolist()
            if (
                len(signature) != 2
                or signature[0] != -1
                or signature[1] not in {CLASS_COUNT, 1024, 64}
                or output["dtype"] != np.float32
                or signature[1] in output_by_width
            ):
                raise ComparatorContractError("YAMNet LiteRT output contract does not match")
            output_by_width[signature[1]] = output
        if set(output_by_width) != {CLASS_COUNT, 1024, 64}:
            raise ComparatorContractError("YAMNet LiteRT output widths do not match")

        self.mapping = mapping
        self.class_map = load_class_map(class_map_path)
        self._interpreter = interpreter
        self._input_index = int(inputs[0]["index"])
        self._scores_index = int(output_by_width[CLASS_COUNT]["index"])
        self._numpy = np
        self._resample_poly = resample_poly
        self.load_ms = round((time.monotonic() - started) * 1000)

    def score(
        self, windows: Sequence[Sequence[float]], sample_rate: int
    ) -> list[dict[str, object]]:
        if (
            self.mapping is None
            or not self.class_map
            or self._interpreter is None
            or self._input_index is None
            or self._scores_index is None
            or self._numpy is None
            or self._resample_poly is None
        ):
            raise RuntimeError("YAMNet backend is not ready")
        if sample_rate != INPUT_SAMPLE_RATE:
            raise ComparatorContractError("PCM sample rate does not match the comparator pin")
        np = self._numpy
        results: list[dict[str, object]] = []
        for window in windows:
            source = np.asarray(window, dtype=np.float32)
            if source.ndim != 1 or source.size < 1:
                raise ComparatorContractError("PCM window is invalid")
            resampled = self._resample_poly(
                source, MODEL_SAMPLE_RATE, INPUT_SAMPLE_RATE
            ).astype(np.float32, copy=False)
            resampled = np.clip(resampled, -1.0, 1.0)
            if resampled.size < MODEL_MINIMUM_SAMPLES:
                resampled = np.pad(
                    resampled,
                    (0, MODEL_MINIMUM_SAMPLES - resampled.size),
                    mode="constant",
                )

            started = time.monotonic()
            self._interpreter.resize_tensor_input(
                self._input_index, [int(resampled.size)], strict=True
            )
            self._interpreter.allocate_tensors()
            self._interpreter.set_tensor(self._input_index, resampled)
            self._interpreter.invoke()
            scores = self._interpreter.get_tensor(self._scores_index)
            inference_ms = round((time.monotonic() - started) * 1000)
            if (
                scores.ndim != 2
                or scores.shape[0] < 1
                or scores.shape[1] != CLASS_COUNT
                or not np.isfinite(scores).all()
                or float(scores.min()) < 0
                or float(scores.max()) > 1
            ):
                raise ComparatorContractError("YAMNet LiteRT scores are invalid")

            metrics: dict[str, dict[str, Union[float, int]]] = {}
            for instrument in self.mapping.instruments:
                indexes = [item.index for item in instrument.classes]
                patch_values = scores[:, indexes].max(axis=1).tolist()
                summary = summarize_patch_values(patch_values)
                metrics[instrument.instrument_id] = {
                    "top3Mean": _rounded(float(summary["top3Mean"])),
                    "maximum": _rounded(float(summary["maximum"])),
                    "mean": _rounded(float(summary["mean"])),
                    "patchesAtLeastHalf": int(summary["patchesAtLeastHalf"]),
                }

            selected_count = min(TOP_PATCH_COUNT, int(scores.shape[0]))
            if selected_count == scores.shape[0]:
                class_scores = scores.mean(axis=0)
            else:
                class_scores = np.partition(
                    scores, scores.shape[0] - selected_count, axis=0
                )[-selected_count:, :].mean(axis=0)
            order = np.argsort(class_scores)[::-1][:TOP_CLASS_COUNT]
            top_classes = [
                {
                    "index": int(index),
                    "mid": self.class_map[int(index)].mid,
                    "displayName": self.class_map[int(index)].display_name,
                    "top3Mean": _rounded(float(class_scores[int(index)])),
                }
                for index in order
            ]
            results.append(
                {
                    "resampledSamples": int(resampled.size),
                    "patches": int(scores.shape[0]),
                    "inferenceMs": inference_ms,
                    "metrics": metrics,
                    "topClasses": top_classes,
                }
            )
        return results
