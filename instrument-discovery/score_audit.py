#!/usr/bin/env python3
"""Offline-only raw-score audit for the pinned discovery candidate.

This file is deliberately not copied into the service image. The local runner
bind-mounts it into the already-pinned image, supplies bounded decoded PCM on a
networkless container, and captures JSON on stdout. Raw score arrays never
enter the production HTTP contract.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
from array import array
from pathlib import Path
from statistics import median
from typing import Mapping, Sequence

import clap_backend as clap_backend_module
from clap_backend import ClapBackend
from constants import (
    CLASSIFIER_VERSION,
    INPUT_SAMPLE_RATE,
    MAX_PCM_BYTES,
    MODEL_WEIGHTS_SHA256,
    VOCABULARY_SHA256,
    VOCABULARY_VERSION,
)
from contract import Instrument, Vocabulary, aggregate_window_scores, load_vocabulary

INPUT_SCHEMA = "stem-splitter.instrument-discovery-score-audit-input.v1"
OUTPUT_SCHEMA = "stem-splitter.instrument-discovery-score-audit.v2"
MAX_MANIFEST_BYTES = 1024 * 1024
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SHA1_PATTERN = re.compile(r"^[a-f0-9]{40}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class ScoreAuditError(ValueError):
    """The offline audit input or output violates its diagnostic contract."""


def _exact_keys(value: Mapping[str, object], keys: set[str], context: str) -> None:
    if set(value) != keys:
        raise ScoreAuditError(f"{context} keys do not match the audit schema")


def _id_list(value: object, context: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not value and not allow_empty):
        raise ScoreAuditError(f"{context} is invalid")
    if any(not isinstance(item, str) or not ID_PATTERN.fullmatch(item) for item in value):
        raise ScoreAuditError(f"{context} is invalid")
    if len(set(value)) != len(value):
        raise ScoreAuditError(f"{context} contains duplicates")
    return list(value)


def _rounded(value: float) -> float:
    return round(float(value), 6)


def summarize_values(values: Sequence[float]) -> dict[str, object]:
    if not values:
        return {"count": 0, "minimum": None, "mean": None, "median": None, "maximum": None}
    normalized = [float(value) for value in values]
    if any(not math.isfinite(value) or value < 0 or value > 1 for value in normalized):
        raise ScoreAuditError("score distribution contains an invalid value")
    return {
        "count": len(normalized),
        "minimum": _rounded(min(normalized)),
        "mean": _rounded(sum(normalized) / len(normalized)),
        "median": _rounded(median(normalized)),
        "maximum": _rounded(max(normalized)),
    }


def summarize_finite_values(values: Sequence[float]) -> dict[str, object]:
    if not values:
        return {"count": 0, "minimum": None, "mean": None, "median": None, "maximum": None}
    normalized = [float(value) for value in values]
    if any(not math.isfinite(value) for value in normalized):
        raise ScoreAuditError("diagnostic distribution contains a non-finite value")
    return {
        "count": len(normalized),
        "minimum": _rounded(min(normalized)),
        "mean": _rounded(sum(normalized) / len(normalized)),
        "median": _rounded(median(normalized)),
        "maximum": _rounded(max(normalized)),
    }


def build_label_record(
    instrument: Instrument,
    scores: Sequence[float],
    vocabulary: Vocabulary,
    category: str,
) -> dict[str, object]:
    if len(scores) < 1 or len(scores) > vocabulary.maximum_windows:
        raise ScoreAuditError("label score window count is invalid")
    normalized = [float(score) for score in scores]
    if any(not math.isfinite(score) or score < 0 or score > 1 for score in normalized):
        raise ScoreAuditError("label score is outside [0, 1]")
    thresholds = vocabulary.families[instrument.family]
    mean_score = sum(normalized) / len(normalized)
    support = sum(score >= thresholds.uncertain for score in normalized)
    minimum_support = min(vocabulary.minimum_window_support, len(normalized))
    if support < minimum_support or mean_score < thresholds.uncertain:
        state = "below-threshold"
    elif mean_score >= thresholds.possible:
        state = "possible"
    else:
        state = "uncertain"
    return {
        "id": instrument.id,
        "label": instrument.label,
        "family": instrument.family,
        "category": category,
        "promptTermCount": len(instrument.prompt_terms),
        "perWindowScores": [_rounded(score) for score in normalized],
        "meanScore": _rounded(mean_score),
        "maximumScore": _rounded(max(normalized)),
        "uncertainFloor": thresholds.uncertain,
        "possibleThreshold": thresholds.possible,
        "windowSupportAtUncertainFloor": support,
        "minimumWindowSupport": minimum_support,
        "marginToUncertainFloor": _rounded(mean_score - thresholds.uncertain),
        "state": state,
    }


def attach_prompt_diagnostics(
    record: dict[str, object],
    instrument: Instrument,
    windows: Sequence[Sequence[Mapping[str, float]]],
) -> None:
    if not windows:
        raise ScoreAuditError("prompt diagnostic windows are empty")
    positive_only: list[float] = []
    negative_control: list[float] = []
    positive_minus_negative: list[float] = []
    rendered_windows: list[list[dict[str, object]]] = []
    for window_index, terms in enumerate(windows):
        if len(terms) != len(instrument.prompt_terms):
            raise ScoreAuditError("prompt diagnostic term count does not match the vocabulary")
        rendered_terms: list[dict[str, object]] = []
        for term, diagnostic in zip(instrument.prompt_terms, terms):
            if set(diagnostic) != {
                "positiveLogit",
                "negativeLogit",
                "positiveMinusNegative",
                "presenceScore",
            }:
                raise ScoreAuditError("prompt diagnostic fields do not match the audit schema")
            values = {key: float(value) for key, value in diagnostic.items()}
            if any(not math.isfinite(value) for value in values.values()):
                raise ScoreAuditError("prompt diagnostic contains a non-finite value")
            if values["presenceScore"] < 0 or values["presenceScore"] > 1:
                raise ScoreAuditError("prompt diagnostic presence score is invalid")
            rendered_terms.append(
                {
                    "term": term,
                    **{key: _rounded(value) for key, value in values.items()},
                }
            )
        positive_only.append(max(float(term["positiveLogit"]) for term in terms))
        negative_control.append(max(float(term["negativeLogit"]) for term in terms))
        positive_minus_negative.append(
            max(float(term["positiveMinusNegative"]) for term in terms)
        )
        expected_presence = max(float(term["presenceScore"]) for term in terms)
        recorded_presence = float(record["perWindowScores"][window_index])
        if abs(expected_presence - recorded_presence) > 0.0000015:
            raise ScoreAuditError("prompt diagnostic does not reproduce the current presence score")
        rendered_windows.append(rendered_terms)
    record.update(
        {
            "positiveOnlyPerWindowLogits": [_rounded(value) for value in positive_only],
            "negativeControlPerWindowLogits": [
                _rounded(value) for value in negative_control
            ],
            "positiveMinusNegativePerWindow": [
                _rounded(value) for value in positive_minus_negative
            ],
            "positiveOnlyMeanLogit": _rounded(sum(positive_only) / len(positive_only)),
            "negativeControlMeanLogit": _rounded(
                sum(negative_control) / len(negative_control)
            ),
            "meanPositiveMinusNegative": _rounded(
                sum(positive_minus_negative) / len(positive_minus_negative)
            ),
            "termDiagnosticsByWindow": rendered_windows,
        }
    )


def _read_manifest(path: Path) -> tuple[dict[str, object], bytes]:
    try:
        status = path.lstat()
        if path.is_symlink() or not path.is_file() or status.st_size < 2 or status.st_size > MAX_MANIFEST_BYTES:
            raise ScoreAuditError("score-audit manifest is not a bounded regular file")
        raw = path.read_bytes()
        document = json.loads(raw.decode("utf-8"))
    except ScoreAuditError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ScoreAuditError("score-audit manifest is unavailable") from error
    if not isinstance(document, dict):
        raise ScoreAuditError("score-audit manifest root is invalid")
    return document, raw


def _validate_expected_groups(
    value: object, vocabulary_ids: set[str], context: str
) -> list[dict[str, list[str]]]:
    if not isinstance(value, list) or not value:
        raise ScoreAuditError(f"{context} expected groups are invalid")
    groups: list[dict[str, list[str]]] = []
    used_ids: set[str] = set()
    for raw_group in value:
        if not isinstance(raw_group, dict):
            raise ScoreAuditError(f"{context} expected group is invalid")
        _exact_keys(raw_group, {"corpusTerms", "acceptedIds"}, f"{context} expected group")
        corpus_terms = _id_list(raw_group["corpusTerms"], f"{context} corpus terms")
        accepted_ids = _id_list(raw_group["acceptedIds"], f"{context} accepted ids")
        if any(candidate not in vocabulary_ids or candidate in used_ids for candidate in accepted_ids):
            raise ScoreAuditError(f"{context} accepted ids are unknown or reused")
        used_ids.update(accepted_ids)
        groups.append({"corpusTerms": corpus_terms, "acceptedIds": accepted_ids})
    return groups


def _decode_pcm(path: Path, declared_bytes: int, counts: Sequence[int]) -> list[memoryview]:
    if sys.byteorder != "little":
        raise ScoreAuditError("score audit requires a little-endian runtime")
    if (
        declared_bytes < 4
        or declared_bytes > MAX_PCM_BYTES
        or sum(counts) * 4 != declared_bytes
    ):
        raise ScoreAuditError("score-audit PCM declaration is invalid")
    try:
        status = path.lstat()
        if path.is_symlink() or not path.is_file() or status.st_size != declared_bytes:
            raise ScoreAuditError("score-audit PCM is not a bounded regular file")
        payload = path.read_bytes()
    except ScoreAuditError:
        raise
    except OSError as error:
        raise ScoreAuditError("score-audit PCM is unavailable") from error
    samples = array("f")
    samples.frombytes(payload)
    if any(not math.isfinite(sample) for sample in samples):
        raise ScoreAuditError("score-audit PCM contains a non-finite sample")
    view = memoryview(samples)
    windows: list[memoryview] = []
    offset = 0
    for count in counts:
        windows.append(view[offset : offset + count])
        offset += count
    return windows


def _validate_sources(
    value: object, root: Path, vocabulary: Vocabulary
) -> list[dict[str, object]]:
    if not isinstance(value, list) or not value:
        raise ScoreAuditError("score-audit sources are invalid")
    seen_slugs: set[str] = set()
    sources: list[dict[str, object]] = []
    vocabulary_ids = set(vocabulary.ids)
    for raw_source in value:
        if not isinstance(raw_source, dict):
            raise ScoreAuditError("score-audit source is invalid")
        _exact_keys(
            raw_source,
            {
                "slug",
                "pcmFile",
                "pcmBytes",
                "windowSampleCounts",
                "sourceSha1",
                "coverage",
                "expectedGroups",
                "hardNegativeIds",
            },
            "score-audit source",
        )
        slug = raw_source["slug"]
        pcm_file = raw_source["pcmFile"]
        if (
            not isinstance(slug, str)
            or not ID_PATTERN.fullmatch(slug)
            or slug in seen_slugs
            or pcm_file != f"{slug}.f32le"
        ):
            raise ScoreAuditError("score-audit source identity is invalid")
        seen_slugs.add(slug)
        pcm_path = (root / str(pcm_file)).resolve()
        if pcm_path.parent != root or pcm_path.name != pcm_file:
            raise ScoreAuditError(f"{slug}: score-audit PCM path escapes its input root")
        declared_bytes = raw_source["pcmBytes"]
        if isinstance(declared_bytes, bool) or not isinstance(declared_bytes, int):
            raise ScoreAuditError(f"{slug}: score-audit PCM byte count is invalid")
        counts_value = raw_source["windowSampleCounts"]
        if (
            not isinstance(counts_value, list)
            or not (1 <= len(counts_value) <= vocabulary.maximum_windows)
            or any(
                isinstance(count, bool) or not isinstance(count, int) or count < 1
                for count in counts_value
            )
        ):
            raise ScoreAuditError(f"{slug}: score-audit window counts are invalid")
        source_sha1 = raw_source["sourceSha1"]
        if not isinstance(source_sha1, str) or not SHA1_PATTERN.fullmatch(source_sha1):
            raise ScoreAuditError(f"{slug}: source digest is invalid")
        coverage = _id_list(raw_source["coverage"], f"{slug}: coverage")
        expected_groups = _validate_expected_groups(
            raw_source["expectedGroups"], vocabulary_ids, slug
        )
        expected_ids = {
            candidate for group in expected_groups for candidate in group["acceptedIds"]
        }
        hard_negative_ids = _id_list(
            raw_source["hardNegativeIds"], f"{slug}: hard-negative ids", allow_empty=True
        )
        if any(
            candidate not in vocabulary_ids or candidate in expected_ids
            for candidate in hard_negative_ids
        ):
            raise ScoreAuditError(f"{slug}: hard-negative ids are unknown or expected")
        sources.append(
            {
                "slug": slug,
                "sourceSha1": source_sha1,
                "coverage": coverage,
                "expectedGroups": expected_groups,
                "hardNegativeIds": hard_negative_ids,
                "windows": _decode_pcm(pcm_path, declared_bytes, counts_value),
            }
        )
    return sources


def _distribution_by_category_and_prompt_count(
    records: Sequence[Mapping[str, object]],
) -> dict[str, dict[str, dict[str, object]]]:
    output: dict[str, dict[str, dict[str, object]]] = {}
    for category in ("expected", "hard-negative", "unreviewed"):
        output[category] = {}
        prompt_counts = sorted(
            {
                int(record["promptTermCount"])
                for record in records
                if record["category"] == category
            }
        )
        for prompt_count in prompt_counts:
            output[category][str(prompt_count)] = summarize_values(
                [
                    float(record["meanScore"])
                    for record in records
                    if record["category"] == category
                    and record["promptTermCount"] == prompt_count
                ]
            )
    return output


def _finite_distribution_by_category_and_prompt_count(
    records: Sequence[Mapping[str, object]], field: str
) -> dict[str, dict[str, dict[str, object]]]:
    output: dict[str, dict[str, dict[str, object]]] = {}
    for category in ("expected", "hard-negative", "unreviewed"):
        output[category] = {}
        prompt_counts = sorted(
            {
                int(record["promptTermCount"])
                for record in records
                if record["category"] == category
            }
        )
        for prompt_count in prompt_counts:
            output[category][str(prompt_count)] = summarize_finite_values(
                [
                    float(record[field])
                    for record in records
                    if record["category"] == category
                    and record["promptTermCount"] == prompt_count
                ]
            )
    return output


def run_audit(manifest_path: Path) -> dict[str, object]:
    document, manifest_bytes = _read_manifest(manifest_path)
    _exact_keys(
        document,
        {
            "$schema",
            "generatedAt",
            "classifierVersion",
            "weightsSha256",
            "vocabularyVersion",
            "vocabularySha256",
            "sampleRate",
            "sources",
        },
        "score-audit manifest",
    )
    if (
        document["$schema"] != INPUT_SCHEMA
        or document["classifierVersion"] != CLASSIFIER_VERSION
        or document["weightsSha256"] != MODEL_WEIGHTS_SHA256
        or document["vocabularyVersion"] != VOCABULARY_VERSION
        or document["vocabularySha256"] != VOCABULARY_SHA256
        or document["sampleRate"] != INPUT_SAMPLE_RATE
        or not isinstance(document["generatedAt"], str)
        or not TIMESTAMP_PATTERN.fullmatch(document["generatedAt"])
    ):
        raise ScoreAuditError("score-audit manifest does not match the pinned candidate")

    vocabulary_path = Path(os.environ.get("INSTRUMENT_DISCOVERY_VOCABULARY", "/app/vocabulary.json"))
    model_dir = Path(os.environ.get("INSTRUMENT_DISCOVERY_MODEL_DIR", "/models/larger_clap_music"))
    vocabulary = load_vocabulary(vocabulary_path)
    sources = _validate_sources(document["sources"], manifest_path.parent.resolve(), vocabulary)
    backend = ClapBackend(model_dir, vocabulary, torch_threads=1)
    backend.warm()

    instrument_by_id = {instrument.id: instrument for instrument in vocabulary.instruments}
    source_results: list[dict[str, object]] = []
    all_label_records: list[dict[str, object]] = []
    expected_group_scores: list[float] = []
    expected_group_positive_ranks: list[float] = []
    current_detection_count = 0
    current_abstentions = 0
    for source in sources:
        prompt_diagnostics = backend.score_prompt_diagnostics(
            source["windows"], INPUT_SAMPLE_RATE
        )
        window_scores = [
            {
                instrument.id: max(
                    float(term["presenceScore"])
                    for term in window[instrument.id]
                )
                for instrument in vocabulary.instruments
            }
            for window in prompt_diagnostics
        ]
        current_detections = aggregate_window_scores(vocabulary, window_scores)
        current_detection_ids = {str(detection["id"]) for detection in current_detections}
        current_detection_count += len(current_detections)
        if not current_detections:
            current_abstentions += 1
        expected_ids = {
            candidate
            for group in source["expectedGroups"]
            for candidate in group["acceptedIds"]
        }
        hard_negative_ids = set(source["hardNegativeIds"])
        label_records: list[dict[str, object]] = []
        for instrument in vocabulary.instruments:
            if instrument.id in expected_ids:
                category = "expected"
            elif instrument.id in hard_negative_ids:
                category = "hard-negative"
            else:
                category = "unreviewed"
            record = build_label_record(
                instrument,
                [float(window[instrument.id]) for window in window_scores],
                vocabulary,
                category,
            )
            attach_prompt_diagnostics(
                record,
                instrument,
                [window[instrument.id] for window in prompt_diagnostics],
            )
            label_records.append(record)
            all_label_records.append(record)
        label_by_id = {str(record["id"]): record for record in label_records}
        positive_only_order = sorted(
            label_records,
            key=lambda record: (-float(record["positiveOnlyMeanLogit"]), str(record["id"])),
        )
        for rank, record in enumerate(positive_only_order, start=1):
            record["positiveOnlyRank"] = rank
        group_results: list[dict[str, object]] = []
        for group in source["expectedGroups"]:
            candidates = [label_by_id[candidate] for candidate in group["acceptedIds"]]
            best = max(candidates, key=lambda candidate: float(candidate["meanScore"]))
            best_positive = max(
                candidates,
                key=lambda candidate: float(candidate["positiveOnlyMeanLogit"]),
            )
            expected_group_scores.append(float(best["meanScore"]))
            expected_group_positive_ranks.append(float(best_positive["positiveOnlyRank"]))
            group_results.append(
                {
                    "corpusTerms": group["corpusTerms"],
                    "acceptedIds": group["acceptedIds"],
                    "bestCandidateId": best["id"],
                    "bestMeanScore": best["meanScore"],
                    "bestMarginToUncertainFloor": best["marginToUncertainFloor"],
                    "bestPositiveOnlyCandidateId": best_positive["id"],
                    "bestPositiveOnlyMeanLogit": best_positive["positiveOnlyMeanLogit"],
                    "bestPositiveOnlyRank": best_positive["positiveOnlyRank"],
                    "matchedDetectionIds": [
                        candidate
                        for candidate in group["acceptedIds"]
                        if candidate in current_detection_ids
                    ],
                }
            )
        label_records.sort(key=lambda record: (-float(record["meanScore"]), str(record["id"])))
        source_results.append(
            {
                "slug": source["slug"],
                "sourceSha1": source["sourceSha1"],
                "coverage": source["coverage"],
                "windowsAnalyzed": len(window_scores),
                "currentDetections": current_detections,
                "expectedGroups": group_results,
                "topLabelIds": [record["id"] for record in label_records[:12]],
                "topPositiveOnlyLabelIds": [
                    record["id"] for record in positive_only_order[:12]
                ],
                "labels": label_records,
            }
        )

    return {
        "$schema": OUTPUT_SCHEMA,
        "generatedAt": document["generatedAt"],
        "diagnosticOnly": True,
        "networkRequired": False,
        "routingEffect": "none",
        "thresholdMutation": "none",
        "diagnosticSourceSha256": {
            "scoreAudit": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "clapBackend": hashlib.sha256(
                Path(str(clap_backend_module.__file__)).read_bytes()
            ).hexdigest(),
        },
        "inputManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "classifier": {
            "version": CLASSIFIER_VERSION,
            "weightsSha256": MODEL_WEIGHTS_SHA256,
        },
        "vocabulary": {
            "version": VOCABULARY_VERSION,
            "sha256": VOCABULARY_SHA256,
            "reviewStatus": vocabulary.review_status,
        },
        "sampleRate": INPUT_SAMPLE_RATE,
        "sources": source_results,
        "summary": {
            "sources": len(source_results),
            "windows": sum(int(source["windowsAnalyzed"]) for source in source_results),
            "currentDetections": current_detection_count,
            "currentAbstentions": current_abstentions,
            "expectedGroups": len(expected_group_scores),
            "bestExpectedGroupScores": summarize_values(expected_group_scores),
            "bestExpectedGroupPositiveOnlyRanks": summarize_finite_values(
                expected_group_positive_ranks
            ),
            "expectedGroupsWithPositiveOnlyCandidateInTop12": sum(
                rank <= 12 for rank in expected_group_positive_ranks
            ),
            "scoreDistributionByCategoryAndPromptTermCount": (
                _distribution_by_category_and_prompt_count(all_label_records)
            ),
            "positiveOnlyLogitDistributionByCategoryAndPromptTermCount": (
                _finite_distribution_by_category_and_prompt_count(
                    all_label_records, "positiveOnlyMeanLogit"
                )
            ),
            "positiveMinusNegativeDistributionByCategoryAndPromptTermCount": (
                _finite_distribution_by_category_and_prompt_count(
                    all_label_records, "meanPositiveMinusNegative"
                )
            ),
        },
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise ScoreAuditError("usage: score_audit.py /input/manifest.json")
    report = run_audit(Path(sys.argv[1]).resolve())
    sys.stdout.write(json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except ScoreAuditError as error:
        sys.stderr.write(f"instrument score audit rejected its input: {error}\n")
        raise SystemExit(1)
    except Exception:
        sys.stderr.write("instrument score audit failed\n")
        raise SystemExit(1)
