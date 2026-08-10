"""Strict, dependency-light contract checks for the YAMNet comparator."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import secrets
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional, Sequence, Union

from constants import (
    CLASS_COUNT,
    CLASS_MAP_BYTES,
    CLASS_MAP_SHA256,
    CLASSIFIER_VERSION,
    MAPPING_SCHEMA,
    MAPPING_SHA256,
    MAX_PCM_BYTES,
    MAX_WINDOWS,
    MAX_WINDOW_SAMPLES,
    MODEL_SHA256,
    SCORING_POLICY_VERSION,
    TOP_PATCH_COUNT,
    VOCABULARY_SHA256,
    VOCABULARY_VERSION,
)

ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MID_PATTERN = re.compile(r"^/(?:g|m|t)/[A-Za-z0-9_]+$")


class ComparatorContractError(ValueError):
    """Input, mapping, or artifact metadata does not match the frozen candidate."""


@dataclass(frozen=True)
class AudioSetClass:
    index: int
    mid: str
    display_name: str


@dataclass(frozen=True)
class InstrumentMapping:
    instrument_id: str
    classes: tuple[AudioSetClass, ...]


@dataclass(frozen=True)
class UnsupportedInstrument:
    instrument_id: str
    reason: str


@dataclass(frozen=True)
class ComparatorMapping:
    instruments: tuple[InstrumentMapping, ...]
    unsupported: tuple[UnsupportedInstrument, ...]

    @property
    def supported_ids(self) -> tuple[str, ...]:
        return tuple(item.instrument_id for item in self.instruments)


def _exact_keys(value: Mapping[str, object], expected: set[str], context: str) -> None:
    if set(value) != expected:
        raise ComparatorContractError(f"{context} keys do not match the pinned schema")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _read_pinned(path: Path, expected_sha256: str, context: str) -> bytes:
    try:
        if path.is_symlink() or not path.is_file():
            raise OSError("not a regular file")
        raw = path.read_bytes()
    except OSError as error:
        raise ComparatorContractError(f"{context} is unavailable") from error
    if not secrets.compare_digest(_sha256(raw), expected_sha256):
        raise ComparatorContractError(f"{context} checksum does not match the pin")
    return raw


def _load_vocabulary_ids(path: Path) -> tuple[str, ...]:
    raw = _read_pinned(path, VOCABULARY_SHA256, "instrument vocabulary")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ComparatorContractError("instrument vocabulary is invalid") from error
    if (
        not isinstance(document, dict)
        or document.get("version") != VOCABULARY_VERSION
        or not isinstance(document.get("instruments"), list)
    ):
        raise ComparatorContractError("instrument vocabulary identity does not match")
    ids: list[str] = []
    for item in document["instruments"]:
        if not isinstance(item, dict):
            raise ComparatorContractError("instrument vocabulary item is invalid")
        instrument_id = item.get("id")
        if (
            not isinstance(instrument_id, str)
            or not ID_PATTERN.fullmatch(instrument_id)
            or instrument_id in ids
        ):
            raise ComparatorContractError("instrument vocabulary id is invalid")
        ids.append(instrument_id)
    if len(ids) != 51:
        raise ComparatorContractError("instrument vocabulary size does not match")
    return tuple(ids)


def load_class_map(path: Path) -> tuple[AudioSetClass, ...]:
    raw = _read_pinned(path, CLASS_MAP_SHA256, "YAMNet class map")
    if len(raw) != CLASS_MAP_BYTES:
        raise ComparatorContractError("YAMNet class map byte length does not match")
    try:
        text = raw.decode("utf-8")
        rows = list(csv.DictReader(text.splitlines()))
    except (UnicodeDecodeError, csv.Error) as error:
        raise ComparatorContractError("YAMNet class map is invalid") from error
    if len(rows) != CLASS_COUNT or set(rows[0] if rows else {}) != {
        "index",
        "mid",
        "display_name",
    }:
        raise ComparatorContractError("YAMNet class map schema does not match")
    classes: list[AudioSetClass] = []
    seen_mids: set[str] = set()
    for expected_index, row in enumerate(rows):
        try:
            index = int(row["index"])
        except (KeyError, TypeError, ValueError) as error:
            raise ComparatorContractError("YAMNet class index is invalid") from error
        mid = row.get("mid")
        display_name = row.get("display_name")
        if (
            index != expected_index
            or not isinstance(mid, str)
            or not MID_PATTERN.fullmatch(mid)
            or mid in seen_mids
            or not isinstance(display_name, str)
            or not display_name
            or display_name != display_name.strip()
        ):
            raise ComparatorContractError("YAMNet class map row is invalid")
        seen_mids.add(mid)
        classes.append(AudioSetClass(index=index, mid=mid, display_name=display_name))
    return tuple(classes)


def load_mapping(
    mapping_path: Path,
    vocabulary_path: Path,
    class_map_path: Optional[Path] = None,
) -> ComparatorMapping:
    raw = _read_pinned(mapping_path, MAPPING_SHA256, "YAMNet candidate mapping")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ComparatorContractError("YAMNet candidate mapping is invalid") from error
    if not isinstance(document, dict):
        raise ComparatorContractError("YAMNet candidate mapping root is invalid")
    _exact_keys(
        document,
        {
            "$schema",
            "classifierVersion",
            "modelSha256",
            "classMapSha256",
            "vocabularyVersion",
            "vocabularySha256",
            "reviewStatus",
            "scoringPolicy",
            "mapped",
            "unsupported",
        },
        "YAMNet candidate mapping",
    )
    if (
        document["$schema"] != MAPPING_SCHEMA
        or document["classifierVersion"] != CLASSIFIER_VERSION
        or document["modelSha256"] != MODEL_SHA256
        or document["classMapSha256"] != CLASS_MAP_SHA256
        or document["vocabularyVersion"] != VOCABULARY_VERSION
        or document["vocabularySha256"] != VOCABULARY_SHA256
        or document["reviewStatus"] != "offline-comparator-uncalibrated"
    ):
        raise ComparatorContractError("YAMNet candidate mapping identity does not match")
    policy = document["scoringPolicy"]
    if not isinstance(policy, dict):
        raise ComparatorContractError("YAMNet scoring policy is invalid")
    _exact_keys(
        policy,
        {
            "classAggregation",
            "patchAggregation",
            "topPatchCount",
            "trackAggregation",
            "singleWindowException",
            "thresholdSelection",
        },
        "YAMNet scoring policy",
    )
    if policy != {
        "classAggregation": "maximum",
        "patchAggregation": "top-k-mean",
        "topPatchCount": TOP_PATCH_COUNT,
        "trackAggregation": "second-highest-window",
        "singleWindowException": True,
        "thresholdSelection": "none",
    } or SCORING_POLICY_VERSION != "max-class-top3-patch-mean-second-window-v1":
        raise ComparatorContractError("YAMNet scoring policy does not match the code pin")

    vocabulary_ids = _load_vocabulary_ids(vocabulary_path)
    class_map = load_class_map(class_map_path) if class_map_path is not None else None
    raw_mapped = document["mapped"]
    raw_unsupported = document["unsupported"]
    if not isinstance(raw_mapped, list) or not isinstance(raw_unsupported, list):
        raise ComparatorContractError("YAMNet mapping lists are invalid")

    instruments: list[InstrumentMapping] = []
    seen_ids: set[str] = set()
    seen_indexes: set[int] = set()
    for item in raw_mapped:
        if not isinstance(item, dict):
            raise ComparatorContractError("YAMNet mapped instrument is invalid")
        _exact_keys(item, {"instrumentId", "classes"}, "YAMNet mapped instrument")
        instrument_id = item["instrumentId"]
        classes_value = item["classes"]
        if (
            not isinstance(instrument_id, str)
            or instrument_id not in vocabulary_ids
            or instrument_id in seen_ids
            or not isinstance(classes_value, list)
            or not classes_value
        ):
            raise ComparatorContractError("YAMNet mapped instrument identity is invalid")
        classes: list[AudioSetClass] = []
        for class_value in classes_value:
            if not isinstance(class_value, dict):
                raise ComparatorContractError("YAMNet mapped class is invalid")
            _exact_keys(class_value, {"index", "mid", "displayName"}, "YAMNet mapped class")
            index = class_value["index"]
            mid = class_value["mid"]
            display_name = class_value["displayName"]
            if (
                isinstance(index, bool)
                or not isinstance(index, int)
                or index < 0
                or index >= CLASS_COUNT
                or index in seen_indexes
                or not isinstance(mid, str)
                or not MID_PATTERN.fullmatch(mid)
                or not isinstance(display_name, str)
                or not display_name
                or display_name != display_name.strip()
            ):
                raise ComparatorContractError("YAMNet mapped class identity is invalid")
            candidate = AudioSetClass(index=index, mid=mid, display_name=display_name)
            if class_map is not None and class_map[index] != candidate:
                raise ComparatorContractError("YAMNet mapped class does not match the class map")
            seen_indexes.add(index)
            classes.append(candidate)
        seen_ids.add(instrument_id)
        instruments.append(InstrumentMapping(instrument_id, tuple(classes)))

    unsupported: list[UnsupportedInstrument] = []
    for item in raw_unsupported:
        if not isinstance(item, dict):
            raise ComparatorContractError("YAMNet unsupported instrument is invalid")
        _exact_keys(item, {"instrumentId", "reason"}, "YAMNet unsupported instrument")
        instrument_id = item["instrumentId"]
        reason = item["reason"]
        if (
            not isinstance(instrument_id, str)
            or instrument_id not in vocabulary_ids
            or instrument_id in seen_ids
            or not isinstance(reason, str)
            or len(reason) < 20
            or reason != reason.strip()
        ):
            raise ComparatorContractError("YAMNet unsupported instrument identity is invalid")
        seen_ids.add(instrument_id)
        unsupported.append(UnsupportedInstrument(instrument_id, reason))

    if seen_ids != set(vocabulary_ids):
        raise ComparatorContractError("YAMNet mapping does not partition the vocabulary")
    mapped_ids = {item.instrument_id for item in instruments}
    if [item.instrument_id for item in instruments] != [
        item for item in vocabulary_ids if item in mapped_ids
    ]:
        raise ComparatorContractError("YAMNet mapped instruments are not in vocabulary order")
    if [item.instrument_id for item in unsupported] != [
        item for item in vocabulary_ids if item not in mapped_ids
    ]:
        raise ComparatorContractError("YAMNet unsupported instruments are not in vocabulary order")
    return ComparatorMapping(tuple(instruments), tuple(unsupported))


def parse_window_counts(raw: str, content_bytes: int) -> tuple[int, ...]:
    if not re.fullmatch(r"[1-9]\d*(?:,[1-9]\d*){0,2}", raw):
        raise ComparatorContractError("PCM window counts are invalid")
    counts = tuple(int(value) for value in raw.split(","))
    if (
        len(counts) < 1
        or len(counts) > MAX_WINDOWS
        or any(value < 1 or value > MAX_WINDOW_SAMPLES for value in counts)
        or content_bytes < 1
        or content_bytes > MAX_PCM_BYTES
        or sum(counts) * 4 != content_bytes
    ):
        raise ComparatorContractError("PCM window counts do not match the body")
    return counts


def decode_pcm_windows(payload: bytes, counts: Sequence[int]) -> tuple[memoryview, ...]:
    if sys.byteorder != "little":
        raise ComparatorContractError("YAMNet comparator requires little-endian PCM")
    if len(payload) != sum(counts) * 4:
        raise ComparatorContractError("PCM byte length does not match its windows")
    values = array("f")
    values.frombytes(payload)
    if any(not math.isfinite(value) for value in values):
        raise ComparatorContractError("PCM contains a non-finite sample")
    view = memoryview(values)
    windows: list[memoryview] = []
    offset = 0
    for count in counts:
        windows.append(view[offset : offset + count])
        offset += count
    return tuple(windows)


def summarize_patch_values(values: Sequence[float]) -> dict[str, Union[float, int]]:
    converted = [float(value) for value in values]
    if not converted or any(
        not math.isfinite(value) or value < 0 or value > 1 for value in converted
    ):
        raise ComparatorContractError("YAMNet patch score is invalid")
    selected = sorted(converted, reverse=True)[:TOP_PATCH_COUNT]
    return {
        "top3Mean": sum(selected) / len(selected),
        "maximum": max(converted),
        "mean": sum(converted) / len(converted),
        "patchesAtLeastHalf": sum(value >= 0.5 for value in converted),
    }
