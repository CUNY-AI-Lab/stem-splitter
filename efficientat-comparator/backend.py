"""Pinned, offline EfficientAT MN10 inference backend."""

from __future__ import annotations

import hashlib
import json
import math
import secrets
import time
from pathlib import Path
from typing import Optional, Sequence

from constants import (
    CLASS_COUNT,
    CLASS_MAP_BYTES,
    CLASS_MAP_NAME,
    CLASS_MAP_SHA256,
    INPUT_SAMPLE_RATE,
    MODEL_ASSET_ID,
    MODEL_ASSET_NAME,
    MODEL_BYTES,
    MODEL_SAMPLE_RATE,
    MODEL_SHA256,
    MODEL_TENSOR_COUNT,
    MODEL_TENSOR_ELEMENTS,
    SAFE_WEIGHTS_BYTES,
    SAFE_WEIGHTS_NAME,
    SAFE_WEIGHTS_SHA256,
    TOP_CLASS_COUNT,
    UPSTREAM_LICENSE,
    UPSTREAM_LICENSE_BYTES,
    UPSTREAM_LICENSE_NAME,
    UPSTREAM_LICENSE_SHA256,
    UPSTREAM_RELEASE_ID,
    UPSTREAM_RELEASE_TAG,
    UPSTREAM_REPOSITORY,
    UPSTREAM_REVISION,
    UPSTREAM_SOURCE_SHA256,
)
from contract import (
    AudioSetClass,
    ComparatorContractError,
    ComparatorMapping,
    load_class_map,
    load_mapping,
    summarize_clip_values,
)
from model import build_mn10_audioset

MODEL_PROVENANCE_NAME = "stem-splitter-model.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise ComparatorContractError("EfficientAT model artifact is unavailable") from error
    return digest.hexdigest()


def expected_provenance() -> dict[str, object]:
    return {
        "conversion": {
            "exactTensorRoundTrip": True,
            "format": "safetensors",
            "sourceBytes": MODEL_BYTES,
            "sourceSha256": MODEL_SHA256,
            "tensorCount": MODEL_TENSOR_COUNT,
            "tensorElements": MODEL_TENSOR_ELEMENTS,
            "weightsBytes": SAFE_WEIGHTS_BYTES,
            "weightsOnlyLoad": True,
            "weightsSha256": SAFE_WEIGHTS_SHA256,
        },
        "license": {
            "bytes": UPSTREAM_LICENSE_BYTES,
            "name": UPSTREAM_LICENSE,
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


def verify_model_directory(model_dir: Path) -> tuple[Path, Path]:
    expected_names = {
        SAFE_WEIGHTS_NAME,
        CLASS_MAP_NAME,
        UPSTREAM_LICENSE_NAME,
        MODEL_PROVENANCE_NAME,
    }
    try:
        entries = tuple(model_dir.iterdir())
    except OSError as error:
        raise ComparatorContractError("EfficientAT model directory is unavailable") from error
    if (
        {entry.name for entry in entries} != expected_names
        or any(entry.is_symlink() or not entry.is_file() for entry in entries)
    ):
        raise ComparatorContractError("EfficientAT model directory surface does not match")
    weights_path = model_dir / SAFE_WEIGHTS_NAME
    class_map_path = model_dir / CLASS_MAP_NAME
    license_path = model_dir / UPSTREAM_LICENSE_NAME
    if (
        weights_path.stat().st_size != SAFE_WEIGHTS_BYTES
        or class_map_path.stat().st_size != CLASS_MAP_BYTES
        or license_path.stat().st_size != UPSTREAM_LICENSE_BYTES
        or not secrets.compare_digest(sha256_file(weights_path), SAFE_WEIGHTS_SHA256)
        or not secrets.compare_digest(sha256_file(license_path), UPSTREAM_LICENSE_SHA256)
    ):
        raise ComparatorContractError("EfficientAT model artifact does not match")
    load_class_map(class_map_path)
    try:
        provenance = json.loads((model_dir / MODEL_PROVENANCE_NAME).read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ComparatorContractError("EfficientAT model provenance is unavailable") from error
    if provenance != expected_provenance():
        raise ComparatorContractError("EfficientAT model provenance does not match")
    return weights_path, class_map_path


def rounded(value: float) -> float:
    converted = float(value)
    if not math.isfinite(converted) or converted < 0 or converted > 1:
        raise ComparatorContractError("EfficientAT score is outside [0, 1]")
    return round(converted, 8)


class EfficientatBackend:
    def __init__(
        self,
        model_dir: Path,
        mapping_path: Path,
        vocabulary_path: Path,
        *,
        threads: int = 1,
    ) -> None:
        if threads < 1 or threads > 2:
            raise ComparatorContractError("EfficientAT thread count is invalid")
        self.model_dir = model_dir
        self.mapping_path = mapping_path
        self.vocabulary_path = vocabulary_path
        self.threads = threads
        self.mapping: Optional[ComparatorMapping] = None
        self.class_map: tuple[AudioSetClass, ...] = ()
        self.load_ms = 0
        self._model = None
        self._torch = None
        self._torchaudio = None
        self._mel_basis = None
        self._window = None
        self._preemphasis = None

    def warm(self) -> None:
        started = time.monotonic()
        weights_path, class_map_path = verify_model_directory(self.model_dir)
        mapping = load_mapping(self.mapping_path, self.vocabulary_path, class_map_path)

        import torch
        import torch.nn.functional as functional
        import torchaudio
        from safetensors.torch import load_file

        torch.set_num_threads(self.threads)
        torch.set_num_interop_threads(1)
        model = build_mn10_audioset()
        state = load_file(weights_path, device="cpu")
        if (
            len(state) != MODEL_TENSOR_COUNT
            or sum(value.numel() for value in state.values()) != MODEL_TENSOR_ELEMENTS
        ):
            raise ComparatorContractError("EfficientAT safetensors surface drifted")
        try:
            incompatible = model.load_state_dict(state, strict=True)
        except Exception as error:
            raise ComparatorContractError("EfficientAT state dictionary is incompatible") from error
        if incompatible.missing_keys or incompatible.unexpected_keys:
            raise ComparatorContractError("EfficientAT state dictionary keys drifted")
        model.eval()

        mel_basis, _ = torchaudio.compliance.kaldi.get_mel_banks(
            128,
            1024,
            MODEL_SAMPLE_RATE,
            0.0,
            15_000.0,
            vtln_low=100.0,
            vtln_high=-500.0,
            vtln_warp_factor=1.0,
        )
        self.mapping = mapping
        self.class_map = load_class_map(class_map_path)
        self._model = model
        self._torch = torch
        self._torchaudio = torchaudio
        self._mel_basis = functional.pad(mel_basis, (0, 1), mode="constant", value=0)
        self._window = torch.hann_window(800, periodic=False)
        self._preemphasis = torch.tensor([[[-0.97, 1.0]]], dtype=torch.float32)
        self.load_ms = round((time.monotonic() - started) * 1000)

    def spectrogram(self, waveform):
        torch = self._torch
        if torch is None or self._preemphasis is None or self._window is None or self._mel_basis is None:
            raise ComparatorContractError("EfficientAT backend is not warm")
        value = torch.nn.functional.conv1d(
            waveform.reshape(1, 1, -1), self._preemphasis
        ).squeeze(1)
        spectrum = torch.stft(
            value,
            1024,
            hop_length=320,
            win_length=800,
            center=True,
            normalized=False,
            window=self._window,
            return_complex=True,
        )
        power = spectrum.abs().square()
        mel = torch.matmul(self._mel_basis, power)
        return (torch.log(mel + 0.00001) + 4.5) / 5.0

    def score(self, windows: Sequence[Sequence[float]], sample_rate: int) -> list[dict[str, object]]:
        if (
            self.mapping is None
            or not self.class_map
            or self._model is None
            or self._torch is None
            or self._torchaudio is None
        ):
            raise ComparatorContractError("EfficientAT backend is not warm")
        if sample_rate != INPUT_SAMPLE_RATE:
            raise ComparatorContractError("EfficientAT input sample rate does not match")
        torch = self._torch
        results: list[dict[str, object]] = []
        for raw_window in windows:
            waveform = torch.as_tensor(raw_window, dtype=torch.float32)
            if waveform.numel() < 2:
                raise ComparatorContractError("EfficientAT window is too short")
            resampled = self._torchaudio.functional.resample(
                waveform,
                sample_rate,
                MODEL_SAMPLE_RATE,
                lowpass_filter_width=6,
                rolloff=0.99,
                resampling_method="sinc_interp_hann",
            )
            started = time.monotonic()
            with torch.inference_mode():
                spectrogram = self.spectrogram(resampled.reshape(1, -1))
                logits, _features = self._model(spectrogram.unsqueeze(0))
                scores = torch.sigmoid(logits.float()).reshape(-1)
            inference_ms = round((time.monotonic() - started) * 1000)
            if scores.numel() != CLASS_COUNT or not bool(torch.isfinite(scores).all()):
                raise ComparatorContractError("EfficientAT output shape is invalid")
            converted = [rounded(value) for value in scores.tolist()]
            metrics: dict[str, object] = {}
            for instrument in self.mapping.instruments:
                score = max(converted[item.index] for item in instrument.classes)
                metrics[instrument.instrument_id] = summarize_clip_values([score])
            top_indexes = sorted(
                range(CLASS_COUNT), key=lambda index: (-converted[index], index)
            )[:TOP_CLASS_COUNT]
            results.append(
                {
                    "resampledSamples": int(resampled.numel()),
                    "patches": 1,
                    "inferenceMs": inference_ms,
                    "metrics": metrics,
                    "topClasses": [
                        {
                            "index": index,
                            "mid": self.class_map[index].mid,
                            "displayName": self.class_map[index].display_name,
                            "top3Mean": converted[index],
                        }
                        for index in top_indexes
                    ],
                }
            )
        return results
