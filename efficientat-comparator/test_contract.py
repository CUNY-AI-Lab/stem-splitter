from __future__ import annotations

import hashlib
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import constants
import download_model
from contract import (
    ComparatorContractError,
    decode_pcm_windows,
    load_mapping,
    parse_window_counts,
    summarize_clip_values,
)

ROOT = Path(__file__).resolve().parent.parent
MAPPING = ROOT / "efficientat-comparator" / "mapping.json"
VOCABULARY = ROOT / "instrument-discovery" / "vocabulary.json"
LICENSE = ROOT / "efficientat-comparator" / "LICENSE.EfficientAT"


def release_document(*, asset_name: str = constants.MODEL_ASSET_NAME) -> bytes:
    return json.dumps(
        {
            "id": constants.UPSTREAM_RELEASE_ID,
            "tag_name": constants.UPSTREAM_RELEASE_TAG,
            "published_at": constants.UPSTREAM_RELEASE_PUBLISHED_AT,
            "html_url": (
                f"https://github.com/{constants.UPSTREAM_REPOSITORY}/releases/tag/"
                f"{constants.UPSTREAM_RELEASE_TAG}"
            ),
            "assets": [
                {
                    "id": constants.MODEL_ASSET_ID,
                    "name": asset_name,
                    "size": constants.MODEL_BYTES,
                    "state": "uploaded",
                    "content_type": "application/octet-stream",
                    "browser_download_url": constants.MODEL_URL,
                }
            ],
        },
        separators=(",", ":"),
    ).encode("utf-8")


class EfficientatMappingTests(unittest.TestCase):
    def test_mapping_partitions_the_vocabulary_without_inventing_gaps(self) -> None:
        mapping = load_mapping(MAPPING, VOCABULARY)
        self.assertEqual(len(mapping.instruments), 37)
        self.assertEqual(len(mapping.unsupported), 14)
        self.assertEqual(len(set(mapping.supported_ids)), 37)
        self.assertIn("ukulele", mapping.supported_ids)
        self.assertEqual(
            tuple(item.instrument_id for item in mapping.unsupported),
            (
                "viola",
                "classical-guitar",
                "tuba",
                "oboe",
                "bassoon",
                "pipe-organ",
                "pad",
                "marimba",
                "bongos",
                "oud",
                "erhu",
                "koto",
                "shamisen",
                "gamelan",
            ),
        )
        indexes = [
            audio_class.index
            for instrument in mapping.instruments
            for audio_class in instrument.classes
        ]
        self.assertEqual(len(indexes), len(set(indexes)))

    def test_mapping_bytes_are_content_pinned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / "mapping.json"
            changed.write_bytes(MAPPING.read_bytes() + b"\n")
            with self.assertRaisesRegex(ComparatorContractError, "checksum"):
                load_mapping(changed, VOCABULARY)

    def test_clip_summary_keeps_raw_scores_without_selecting_a_threshold(self) -> None:
        result = summarize_clip_values([0.625])
        self.assertEqual(result["top3Mean"], 0.625)
        self.assertEqual(result["maximum"], 0.625)
        self.assertEqual(result["mean"], 0.625)
        self.assertEqual(result["patchesAtLeastHalf"], 1)
        with self.assertRaises(ComparatorContractError):
            summarize_clip_values([0.2, 0.3])
        with self.assertRaises(ComparatorContractError):
            summarize_clip_values([math.nan])


class EfficientatInputTests(unittest.TestCase):
    def test_pcm_windows_require_exact_bounded_little_endian_floats(self) -> None:
        payload = struct.pack("<5f", 0.0, 0.25, -0.25, 1.0, -1.0)
        counts = parse_window_counts("2,3", len(payload))
        windows = decode_pcm_windows(payload, counts)
        self.assertEqual(counts, (2, 3))
        self.assertEqual([len(window) for window in windows], [2, 3])
        self.assertEqual(list(windows[0]), [0.0, 0.25])

    def test_pcm_contract_rejects_mismatches_and_nonfinite_values(self) -> None:
        with self.assertRaises(ComparatorContractError):
            parse_window_counts("0", 4)
        with self.assertRaises(ComparatorContractError):
            parse_window_counts("1,", 4)
        with self.assertRaises(ComparatorContractError):
            parse_window_counts("2", 4)
        with self.assertRaisesRegex(ComparatorContractError, "non-finite"):
            decode_pcm_windows(struct.pack("<f", math.inf), (1,))


class EfficientatProvenanceTests(unittest.TestCase):
    def test_release_metadata_binds_the_exact_official_asset(self) -> None:
        with patch.object(
            download_model,
            "bounded_download",
            return_value=(
                release_document(),
                constants.RELEASE_METADATA_URL,
                "application/json",
            ),
        ):
            download_model.verify_release_metadata()
        with patch.object(
            download_model,
            "bounded_download",
            return_value=(
                release_document(asset_name="different.pt"),
                constants.RELEASE_METADATA_URL,
                "application/json",
            ),
        ):
            with self.assertRaisesRegex(download_model.DownloadError, "asset metadata"):
                download_model.verify_release_metadata()

    def test_artifacts_and_runtime_are_exactly_pinned(self) -> None:
        self.assertRegex(constants.UPSTREAM_REVISION, r"^[a-f0-9]{40}$")
        for digest in (
            constants.MODEL_SHA256,
            constants.SAFE_WEIGHTS_SHA256,
            constants.CLASS_MAP_SHA256,
            constants.UPSTREAM_LICENSE_SHA256,
            constants.MAPPING_SHA256,
            constants.VOCABULARY_SHA256,
        ):
            self.assertRegex(digest, r"^[a-f0-9]{64}$")
        self.assertEqual(constants.CLASS_COUNT, 527)
        self.assertEqual(constants.MODEL_SAMPLE_RATE, 32_000)
        self.assertEqual(constants.SCORING_POLICY_VERSION, "single-clip-sigmoid-second-window-v1")
        self.assertEqual(
            hashlib.sha256(LICENSE.read_bytes()).hexdigest(),
            constants.UPSTREAM_LICENSE_SHA256,
        )

    def test_image_is_a_nonroot_offline_cli_not_an_http_service(self) -> None:
        dockerfile = (ROOT / "efficientat-comparator" / "Dockerfile").read_text("utf-8")
        cli = (ROOT / "efficientat-comparator" / "cli.py").read_text("utf-8")
        self.assertIn("USER 65532:65532", dockerfile)
        self.assertIn('ENTRYPOINT ["python", "cli.py"]', dockerfile)
        self.assertNotIn("EXPOSE", dockerfile)
        self.assertNotIn("HEALTHCHECK", dockerfile)
        self.assertIn("/models/efficientat", dockerfile)
        self.assertNotIn("http.server", cli)
        self.assertNotIn("sourceUrl", cli)


if __name__ == "__main__":
    unittest.main()
