from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

from contract import FamilyThresholds, Instrument, Vocabulary
from score_audit import (
    ScoreAuditError,
    attach_prompt_diagnostics,
    build_label_record,
    summarize_finite_values,
    summarize_values,
    validate_execution_provenance,
)


def vocabulary() -> Vocabulary:
    return Vocabulary(
        version="test-v1",
        review_status="uncalibrated-candidate",
        maximum_windows=3,
        maximum_window_seconds=15,
        minimum_window_support=2,
        maximum_returned_detections=12,
        families={"test-family": FamilyThresholds(possible=0.7, uncertain=0.58)},
        instruments=(
            Instrument(
                id="test-instrument",
                label="Test instrument",
                family="test-family",
                prompt_terms=("one", "two"),
                confusable_with=(),
            ),
        ),
    )


class ScoreAuditTests(unittest.TestCase):
    def test_execution_provenance_requires_exact_amd64_image_and_baked_lock(self) -> None:
        image_id = f"sha256:{'a' * 64}"
        lock_sha = "b" * 64
        with tempfile.TemporaryDirectory() as directory:
            baked = Path(directory) / "uv-lock.sha256"
            baked.write_text(f"{lock_sha}\n", "ascii")
            self.assertEqual(
                validate_execution_provenance(
                    image_id,
                    "linux/amd64",
                    lock_sha,
                    baked_lock_sha_path=baked,
                ),
                {
                    "image": {"id": image_id, "platform": "linux/amd64"},
                    "dependencyLock": {
                        "path": "instrument-discovery/uv.lock",
                        "sha256": lock_sha,
                    },
                },
            )
            with self.assertRaisesRegex(ScoreAuditError, "promotion platform"):
                validate_execution_provenance(
                    image_id,
                    "linux/arm64",
                    lock_sha,
                    baked_lock_sha_path=baked,
                )
            with self.assertRaisesRegex(ScoreAuditError, "does not match"):
                validate_execution_provenance(
                    image_id,
                    "linux/amd64",
                    "c" * 64,
                    baked_lock_sha_path=baked,
                )

    def test_label_record_preserves_raw_windows_and_current_threshold_state(self) -> None:
        candidate = vocabulary()
        record = build_label_record(
            candidate.instruments[0],
            [0.72, 0.68, 0.74],
            candidate,
            "expected",
        )

        self.assertEqual(record["state"], "possible")
        self.assertEqual(record["promptTermCount"], 2)
        self.assertEqual(record["perWindowScores"], [0.72, 0.68, 0.74])
        self.assertEqual(record["windowSupportAtUncertainFloor"], 3)
        self.assertEqual(record["meanScore"], 0.713333)
        self.assertEqual(record["marginToUncertainFloor"], 0.133333)

    def test_label_record_refuses_one_window_transients(self) -> None:
        candidate = vocabulary()
        record = build_label_record(
            candidate.instruments[0],
            [0.95, 0.2, 0.2],
            candidate,
            "hard-negative",
        )

        self.assertEqual(record["state"], "below-threshold")
        self.assertEqual(record["windowSupportAtUncertainFloor"], 1)

    def test_score_distribution_is_bounded_and_explicit_when_empty(self) -> None:
        self.assertEqual(
            summarize_values([]),
            {"count": 0, "minimum": None, "mean": None, "median": None, "maximum": None},
        )
        self.assertEqual(
            summarize_values([0.1, 0.4, 0.9]),
            {"count": 3, "minimum": 0.1, "mean": 0.466667, "median": 0.4, "maximum": 0.9},
        )
        with self.assertRaises(ScoreAuditError):
            summarize_values([math.nan])

    def test_prompt_diagnostics_add_positive_only_controls(self) -> None:
        candidate = vocabulary()
        record = build_label_record(
            candidate.instruments[0], [0.72, 0.68], candidate, "expected"
        )
        attach_prompt_diagnostics(
            record,
            candidate.instruments[0],
            [
                [
                    {
                        "positiveLogit": 1.0,
                        "negativeLogit": 0.1,
                        "positiveMinusNegative": 0.9,
                        "presenceScore": 0.72,
                    },
                    {
                        "positiveLogit": 0.8,
                        "negativeLogit": 0.2,
                        "positiveMinusNegative": 0.6,
                        "presenceScore": 0.65,
                    },
                ],
                [
                    {
                        "positiveLogit": 0.6,
                        "negativeLogit": -0.1,
                        "positiveMinusNegative": 0.7,
                        "presenceScore": 0.68,
                    },
                    {
                        "positiveLogit": 0.7,
                        "negativeLogit": 0.1,
                        "positiveMinusNegative": 0.6,
                        "presenceScore": 0.64,
                    },
                ],
            ],
        )
        self.assertEqual(record["positiveOnlyPerWindowLogits"], [1.0, 0.7])
        self.assertEqual(record["positiveOnlyMeanLogit"], 0.85)
        self.assertEqual(record["meanPositiveMinusNegative"], 0.8)
        self.assertEqual(
            summarize_finite_values([-2.0, 4.0]),
            {"count": 2, "minimum": -2.0, "mean": 1.0, "median": 1.0, "maximum": 4.0},
        )


if __name__ == "__main__":
    unittest.main()
