"""Offline-only, revision-pinned LAION CLAP scoring backend."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Sequence

from constants import (
    CLAP_MAX_INPUT_SECONDS,
    CLAP_SAMPLE_RATE,
    CLAP_TRUNCATION_MODE,
    MODEL_ARTIFACT_SHA256,
    MODEL_PROVENANCE_FILE,
    MODEL_REVISION,
    MODEL_WEIGHTS_SHA256,
    NEGATIVE_PROMPT_TEMPLATE,
    POSITIVE_PROMPT_TEMPLATE,
)
from contract import DiscoveryContractError, Vocabulary

LOG = logging.getLogger("instrument-discovery")


def build_prompt_pairs(vocabulary: Vocabulary) -> tuple[tuple[str, ...], tuple[tuple[int, ...], ...]]:
    """Return positive/negative text pairs and their per-instrument pair indexes."""

    prompts: list[str] = []
    instrument_pairs: list[tuple[int, ...]] = []
    pair_index = 0
    for instrument in vocabulary.instruments:
        indexes: list[int] = []
        for term in instrument.prompt_terms:
            prompts.extend(
                (
                    POSITIVE_PROMPT_TEMPLATE.format(term=term),
                    NEGATIVE_PROMPT_TEMPLATE.format(term=term),
                )
            )
            indexes.append(pair_index)
            pair_index += 1
        instrument_pairs.append(tuple(indexes))
    return tuple(prompts), tuple(instrument_pairs)


def pairwise_presence_scores(
    logits: Sequence[float], instrument_pairs: Sequence[Sequence[int]]
) -> list[float]:
    """Convert positive/negative logits to independent per-instrument scores."""

    expected_pairs = sum(len(indexes) for indexes in instrument_pairs)
    if len(logits) != expected_pairs * 2:
        raise DiscoveryContractError("CLAP text-logit count does not match the prompt policy")
    scores: list[float] = []
    for indexes in instrument_pairs:
        if not indexes:
            raise DiscoveryContractError("CLAP prompt policy has an empty instrument")
        term_scores: list[float] = []
        for pair_index in indexes:
            positive = float(logits[pair_index * 2])
            negative = float(logits[pair_index * 2 + 1])
            if not math.isfinite(positive) or not math.isfinite(negative):
                raise DiscoveryContractError("CLAP returned a non-finite text logit")
            # Stable two-class softmax. Scores remain candidate signals, not
            # calibrated probabilities, until the fixed-corpus gate passes.
            delta = max(-60.0, min(60.0, negative - positive))
            term_scores.append(1.0 / (1.0 + math.exp(delta)))
        scores.append(max(term_scores))
    return scores


def validate_audio_preprocessing(model: object, feature_extractor: object) -> str:
    """Freeze the checkpoint-compatible crop path before advertising readiness."""

    model_config = getattr(model, "config", None)
    audio_config = getattr(model_config, "audio_config", None)
    if getattr(audio_config, "enable_fusion", None) is not False:
        raise DiscoveryContractError("CLAP fusion mode does not match the service pin")
    if getattr(feature_extractor, "truncation", None) != CLAP_TRUNCATION_MODE:
        raise DiscoveryContractError("CLAP truncation mode does not match the service pin")
    if getattr(feature_extractor, "sampling_rate", None) != CLAP_SAMPLE_RATE:
        raise DiscoveryContractError("CLAP sample rate does not match the service pin")
    if getattr(feature_extractor, "nb_max_samples", None) != (
        CLAP_SAMPLE_RATE * CLAP_MAX_INPUT_SECONDS
    ):
        raise DiscoveryContractError("CLAP crop length does not match the service pin")
    return CLAP_TRUNCATION_MODE


def verify_model_directory(model_dir: Path) -> None:
    expected_entries = {
        MODEL_PROVENANCE_FILE,
        *(filename for filename, _digest in MODEL_ARTIFACT_SHA256),
    }
    try:
        entries = tuple(model_dir.iterdir())
    except OSError as error:
        raise DiscoveryContractError("CLAP model directory is unavailable") from error
    if (
        {entry.name for entry in entries} != expected_entries
        or any(entry.is_symlink() or not entry.is_file() for entry in entries)
    ):
        raise DiscoveryContractError("CLAP model directory surface does not match the pin")
    try:
        provenance = json.loads((model_dir / MODEL_PROVENANCE_FILE).read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DiscoveryContractError("CLAP model provenance is unavailable") from error
    if provenance != {
        "modelRevision": MODEL_REVISION,
        "weightsSha256": MODEL_WEIGHTS_SHA256,
        "artifactSha256": dict(MODEL_ARTIFACT_SHA256),
    }:
        raise DiscoveryContractError("CLAP model provenance does not match the service pin")
    for filename, expected in MODEL_ARTIFACT_SHA256:
        digest = hashlib.sha256()
        try:
            with (model_dir / filename).open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
        except OSError as error:
            raise DiscoveryContractError("CLAP model artifact is unavailable") from error
        if not secrets.compare_digest(digest.hexdigest(), expected):
            raise DiscoveryContractError("CLAP model artifact does not match the service pin")


class ClapBackend:
    """Serial CPU scorer that never contacts the model hub at runtime."""

    def __init__(
        self,
        model_dir: Path,
        vocabulary: Vocabulary,
        *,
        torch_threads: int = 1,
    ) -> None:
        if torch_threads < 1 or torch_threads > 4:
            raise DiscoveryContractError("CLAP torch thread count is invalid")
        self.model_dir = model_dir
        self.vocabulary = vocabulary
        self.torch_threads = torch_threads
        self._lock = threading.Lock()
        self._model = None
        self._feature_extractor = None
        self._truncation_mode = None
        self._text_features = None
        self._instrument_pairs: tuple[tuple[int, ...], ...] = ()
        self._numpy = None
        self._resample_poly = None
        self._torch = None

    def warm(self) -> None:
        started = time.monotonic()
        LOG.info("discovery_warm phase=verify_model")
        verify_model_directory(self.model_dir)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

        LOG.info("discovery_warm phase=import_runtime")
        # Heavy dependencies are intentionally imported only in the model
        # service. Contract tests and the warmed app never install them.
        import numpy as np
        import torch
        from scipy.signal import resample_poly
        from transformers import ClapModel, ClapProcessor

        torch.set_num_threads(self.torch_threads)
        torch.manual_seed(0)
        LOG.info("discovery_warm phase=load_checkpoint")
        model = ClapModel.from_pretrained(
            self.model_dir,
            local_files_only=True,
            use_safetensors=False,
            weights_only=True,
            trust_remote_code=False,
        )
        processor = ClapProcessor.from_pretrained(
            self.model_dir,
            local_files_only=True,
            trust_remote_code=False,
        )
        truncation_mode = validate_audio_preprocessing(model, processor.feature_extractor)
        model.eval()
        prompts, instrument_pairs = build_prompt_pairs(self.vocabulary)
        text_inputs = processor(text=list(prompts), padding=True, return_tensors="pt")
        LOG.info("discovery_warm phase=embed_vocabulary prompts=%d", len(prompts))
        with torch.inference_mode():
            text_features = model.get_text_features(**text_inputs)
            text_features = torch.nn.functional.normalize(text_features, dim=-1)

        self._model = model
        self._feature_extractor = processor.feature_extractor
        self._truncation_mode = truncation_mode
        self._text_features = text_features
        self._instrument_pairs = instrument_pairs
        self._numpy = np
        self._resample_poly = resample_poly
        self._torch = torch
        LOG.info("discovery_warm_complete total_ms=%d", round((time.monotonic() - started) * 1000))

    def score(self, windows: Sequence[Sequence[float]], sample_rate: int) -> list[dict[str, float]]:
        if (
            self._model is None
            or self._feature_extractor is None
            or self._truncation_mode is None
            or self._text_features is None
            or self._numpy is None
            or self._resample_poly is None
            or self._torch is None
        ):
            raise RuntimeError("CLAP backend is not ready")
        if sample_rate <= 0:
            raise DiscoveryContractError("PCM sample rate is invalid")

        np = self._numpy
        torch = self._torch
        outputs: list[dict[str, float]] = []
        with self._lock, torch.inference_mode():
            for window_index, window in enumerate(windows):
                source = np.asarray(window, dtype=np.float32)
                resampled = self._resample_poly(source, CLAP_SAMPLE_RATE, sample_rate).astype(
                    np.float32, copy=False
                )

                # This non-fusion checkpoint accepts one ten-second mel crop.
                # A fixed per-window seed makes rand_trunc deterministic for
                # longer analyzer windows. Concurrency is one and this lock
                # contains the temporary global NumPy state.
                random_state = np.random.get_state()
                np.random.seed(10_000 + window_index)
                try:
                    audio_inputs = self._feature_extractor(
                        [resampled],
                        sampling_rate=CLAP_SAMPLE_RATE,
                        truncation=self._truncation_mode,
                        padding="repeatpad",
                        return_tensors="pt",
                    )
                finally:
                    np.random.set_state(random_state)
                audio_features = self._model.get_audio_features(**audio_inputs)
                audio_features = torch.nn.functional.normalize(audio_features, dim=-1)
                scale = self._model.logit_scale_a.exp()
                logits = (audio_features @ self._text_features.T * scale)[0].tolist()
                instrument_scores = pairwise_presence_scores(logits, self._instrument_pairs)
                outputs.append(
                    {
                        instrument.id: instrument_scores[index]
                        for index, instrument in enumerate(self.vocabulary.instruments)
                    }
                )
        return outputs
