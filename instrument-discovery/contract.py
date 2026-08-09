"""Vocabulary validation and conservative multi-window score aggregation."""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from constants import (
    MAX_RETURNED_DETECTIONS,
    MAX_WINDOW_SECONDS,
    MAX_WINDOWS,
    VOCABULARY_SHA256,
    VOCABULARY_VERSION,
)

ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class DiscoveryContractError(ValueError):
    """The request, vocabulary, or classifier output violates the frozen contract."""


@dataclass(frozen=True)
class FamilyThresholds:
    possible: float
    uncertain: float


@dataclass(frozen=True)
class Instrument:
    id: str
    label: str
    family: str
    prompt_terms: tuple[str, ...]
    confusable_with: tuple[str, ...]


@dataclass(frozen=True)
class Vocabulary:
    version: str
    review_status: str
    maximum_windows: int
    maximum_window_seconds: int
    minimum_window_support: int
    maximum_returned_detections: int
    families: Mapping[str, FamilyThresholds]
    instruments: tuple[Instrument, ...]

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(instrument.id for instrument in self.instruments)


def _exact_keys(value: Mapping[str, object], expected: set[str], context: str) -> None:
    if set(value) != expected:
        raise DiscoveryContractError(f"{context} keys do not match the pinned schema")


def _bounded_probability(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DiscoveryContractError(f"{context} is not numeric")
    converted = float(value)
    if not math.isfinite(converted) or converted < 0 or converted > 1:
        raise DiscoveryContractError(f"{context} is outside [0, 1]")
    return converted


def load_vocabulary(path: Path) -> Vocabulary:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise DiscoveryContractError("instrument vocabulary is unavailable") from error
    digest = hashlib.sha256(raw).hexdigest()
    if not secrets.compare_digest(digest, VOCABULARY_SHA256):
        raise DiscoveryContractError("instrument vocabulary checksum does not match the pin")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DiscoveryContractError("instrument vocabulary is not valid UTF-8 JSON") from error
    if not isinstance(document, dict):
        raise DiscoveryContractError("instrument vocabulary root is invalid")
    _exact_keys(
        document,
        {
            "$schema",
            "version",
            "reviewStatus",
            "updatedAt",
            "aggregation",
            "families",
            "instruments",
        },
        "instrument vocabulary",
    )
    if document["$schema"] != "stem-splitter.instrument-vocabulary.v1":
        raise DiscoveryContractError("instrument vocabulary schema does not match")
    if document["version"] != VOCABULARY_VERSION:
        raise DiscoveryContractError("instrument vocabulary version does not match")
    if document["reviewStatus"] != "uncalibrated-candidate":
        raise DiscoveryContractError("instrument vocabulary review state is invalid")
    if not isinstance(document["updatedAt"], str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}", document["updatedAt"]
    ):
        raise DiscoveryContractError("instrument vocabulary update date is invalid")

    aggregation = document["aggregation"]
    if not isinstance(aggregation, dict):
        raise DiscoveryContractError("instrument vocabulary aggregation is invalid")
    _exact_keys(
        aggregation,
        {
            "maximumWindows",
            "maximumWindowSeconds",
            "minimumWindowSupport",
            "maximumReturnedDetections",
        },
        "instrument vocabulary aggregation",
    )
    if (
        aggregation["maximumWindows"] != MAX_WINDOWS
        or aggregation["maximumWindowSeconds"] != MAX_WINDOW_SECONDS
        or aggregation["minimumWindowSupport"] != 2
        or aggregation["maximumReturnedDetections"] != MAX_RETURNED_DETECTIONS
    ):
        raise DiscoveryContractError("instrument vocabulary aggregation does not match the service")

    families_value = document["families"]
    if not isinstance(families_value, dict) or not (10 <= len(families_value) <= 32):
        raise DiscoveryContractError("instrument vocabulary families are invalid")
    families: dict[str, FamilyThresholds] = {}
    for family_id, thresholds_value in families_value.items():
        if not isinstance(family_id, str) or not ID_PATTERN.fullmatch(family_id):
            raise DiscoveryContractError("instrument family id is invalid")
        if not isinstance(thresholds_value, dict):
            raise DiscoveryContractError(f"instrument family {family_id} is invalid")
        _exact_keys(
            thresholds_value,
            {"possibleThreshold", "uncertainFloor"},
            f"instrument family {family_id}",
        )
        possible = _bounded_probability(
            thresholds_value["possibleThreshold"], f"instrument family {family_id} possible threshold"
        )
        uncertain = _bounded_probability(
            thresholds_value["uncertainFloor"], f"instrument family {family_id} uncertain floor"
        )
        if possible <= uncertain:
            raise DiscoveryContractError(
                f"instrument family {family_id} thresholds are not ordered"
            )
        families[family_id] = FamilyThresholds(possible=possible, uncertain=uncertain)

    instruments_value = document["instruments"]
    if not isinstance(instruments_value, list) or not (40 <= len(instruments_value) <= 64):
        raise DiscoveryContractError("instrument vocabulary list is invalid")
    instruments: list[Instrument] = []
    seen_ids: set[str] = set()
    seen_labels: set[str] = set()
    for item in instruments_value:
        if not isinstance(item, dict):
            raise DiscoveryContractError("instrument vocabulary item is invalid")
        _exact_keys(
            item,
            {"id", "label", "family", "promptTerms", "confusableWith"},
            "instrument vocabulary item",
        )
        instrument_id = item["id"]
        label = item["label"]
        family = item["family"]
        prompt_terms = item["promptTerms"]
        confusable_with = item["confusableWith"]
        if (
            not isinstance(instrument_id, str)
            or not ID_PATTERN.fullmatch(instrument_id)
            or len(instrument_id) > 64
            or instrument_id in seen_ids
        ):
            raise DiscoveryContractError("instrument id is invalid or duplicated")
        if (
            not isinstance(label, str)
            or not label
            or label != label.strip()
            or len(label) > 120
            or label in seen_labels
        ):
            raise DiscoveryContractError(f"instrument label for {instrument_id} is invalid")
        if not isinstance(family, str) or family not in families:
            raise DiscoveryContractError(f"instrument family for {instrument_id} is invalid")
        if (
            not isinstance(prompt_terms, list)
            or not prompt_terms
            or len(set(prompt_terms)) != len(prompt_terms)
            or any(
                not isinstance(term, str)
                or not term
                or term != term.strip()
                or len(term) > 80
                for term in prompt_terms
            )
        ):
            raise DiscoveryContractError(f"prompt terms for {instrument_id} are invalid")
        if (
            not isinstance(confusable_with, list)
            or len(set(confusable_with)) != len(confusable_with)
            or instrument_id in confusable_with
            or any(not isinstance(candidate, str) for candidate in confusable_with)
        ):
            raise DiscoveryContractError(f"confusable ids for {instrument_id} are invalid")
        seen_ids.add(instrument_id)
        seen_labels.add(label)
        instruments.append(
            Instrument(
                id=instrument_id,
                label=label,
                family=family,
                prompt_terms=tuple(prompt_terms),
                confusable_with=tuple(confusable_with),
            )
        )
    for instrument in instruments:
        for candidate in instrument.confusable_with:
            if candidate not in seen_ids:
                raise DiscoveryContractError(
                    f"instrument {instrument.id} references unknown confusable id {candidate}"
                )

    return Vocabulary(
        version=VOCABULARY_VERSION,
        review_status=document["reviewStatus"],
        maximum_windows=aggregation["maximumWindows"],
        maximum_window_seconds=aggregation["maximumWindowSeconds"],
        minimum_window_support=aggregation["minimumWindowSupport"],
        maximum_returned_detections=aggregation["maximumReturnedDetections"],
        families=families,
        instruments=tuple(instruments),
    )


def aggregate_window_scores(
    vocabulary: Vocabulary, window_scores: Sequence[Mapping[str, float]]
) -> list[dict[str, object]]:
    """Aggregate independent windows while refusing one-window transients.

    Scores are pairwise CLAP presence scores, not calibrated probabilities. The
    candidate thresholds remain explicitly uncalibrated until the Phase 2
    evaluation gate is complete.
    """

    windows_analyzed = len(window_scores)
    if windows_analyzed < 1 or windows_analyzed > vocabulary.maximum_windows:
        raise DiscoveryContractError("classifier returned an invalid window count")
    expected_ids = set(vocabulary.ids)
    normalized: list[dict[str, float]] = []
    for window in window_scores:
        if set(window) != expected_ids:
            raise DiscoveryContractError("classifier score ids do not match the vocabulary")
        normalized.append(
            {
                instrument_id: _bounded_probability(score, f"score for {instrument_id}")
                for instrument_id, score in window.items()
            }
        )

    minimum_support = min(vocabulary.minimum_window_support, windows_analyzed)
    detections: list[dict[str, object]] = []
    for instrument in vocabulary.instruments:
        thresholds = vocabulary.families[instrument.family]
        scores = [window[instrument.id] for window in normalized]
        confidence = sum(scores) / windows_analyzed
        support = sum(score >= thresholds.uncertain for score in scores)
        if support < minimum_support or confidence < thresholds.uncertain:
            continue
        detections.append(
            {
                "id": instrument.id,
                "label": instrument.label,
                "confidence": round(confidence, 6),
                "state": "possible" if confidence >= thresholds.possible else "uncertain",
                "windowSupport": support,
                "windowsAnalyzed": windows_analyzed,
            }
        )
    detections.sort(key=lambda item: (-float(item["confidence"]), str(item["id"])))
    return detections[: vocabulary.maximum_returned_detections]
