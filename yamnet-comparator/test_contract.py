from __future__ import annotations

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
    summarize_patch_values,
)

ROOT = Path(__file__).resolve().parent.parent
MAPPING = ROOT / "yamnet-comparator" / "mapping.json"
VOCABULARY = ROOT / "instrument-discovery" / "vocabulary.json"


def metadata_document(license_name: str = constants.KAGGLE_LICENSE) -> bytes:
    return json.dumps(
        {
            "models": [
                {
                    "id": constants.KAGGLE_MODEL_ID,
                    "ref": "google/yamnet",
                    "instances": [
                        {
                            "id": constants.KAGGLE_INSTANCE_ID,
                            "slug": "tflite",
                            "framework": "tfLite",
                            "versionId": constants.KAGGLE_VERSION_ID,
                            "versionNumber": constants.KAGGLE_VERSION_NUMBER,
                            "licenseName": license_name,
                            "totalUncompressedBytes": constants.MODEL_BYTES,
                            "downloadUrl": "/models/google/yamnet/TfLite/tflite/1/download",
                        }
                    ],
                }
            ]
        },
        separators=(",", ":"),
    ).encode("utf-8")


class YamnetMappingTests(unittest.TestCase):
    def test_mapping_partitions_the_vocabulary_without_inventing_gaps(self) -> None:
        mapping = load_mapping(MAPPING, VOCABULARY)
        self.assertEqual(len(mapping.instruments), 36)
        self.assertEqual(len(mapping.unsupported), 15)
        self.assertEqual(len(set(mapping.supported_ids)), 36)
        self.assertEqual(
            tuple(item.instrument_id for item in mapping.unsupported),
            (
                "viola",
                "classical-guitar",
                "ukulele",
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
        self.assertNotIn("oboe", mapping.supported_ids)
        self.assertNotIn("koto", mapping.supported_ids)

    def test_mapping_bytes_are_content_pinned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / "mapping.json"
            changed.write_bytes(MAPPING.read_bytes() + b"\n")
            with self.assertRaisesRegex(ComparatorContractError, "checksum"):
                load_mapping(changed, VOCABULARY)

    def test_patch_summary_keeps_raw_diagnostics_without_selecting_a_threshold(self) -> None:
        result = summarize_patch_values([0.1, 0.8, 0.4, 0.6])
        self.assertAlmostEqual(float(result["top3Mean"]), 0.6)
        self.assertEqual(result["maximum"], 0.8)
        self.assertAlmostEqual(float(result["mean"]), 0.475)
        self.assertEqual(result["patchesAtLeastHalf"], 2)
        with self.assertRaises(ComparatorContractError):
            summarize_patch_values([math.nan])
        with self.assertRaises(ComparatorContractError):
            summarize_patch_values([1.1])


class YamnetInputTests(unittest.TestCase):
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


class YamnetProvenanceTests(unittest.TestCase):
    def test_official_metadata_must_bind_the_exact_apache_version(self) -> None:
        with patch.object(
            download_model,
            "_bounded_download",
            return_value=(metadata_document(), constants.KAGGLE_METADATA_URL),
        ):
            self.assertEqual(
                download_model._official_metadata(),
                {
                    "provider": "Google via Kaggle Models",
                    "modelId": constants.KAGGLE_MODEL_ID,
                    "instanceId": constants.KAGGLE_INSTANCE_ID,
                    "versionId": constants.KAGGLE_VERSION_ID,
                    "versionNumber": constants.KAGGLE_VERSION_NUMBER,
                    "license": constants.KAGGLE_LICENSE,
                },
            )
        with patch.object(
            download_model,
            "_bounded_download",
            return_value=(metadata_document("unknown"), constants.KAGGLE_METADATA_URL),
        ):
            with self.assertRaisesRegex(download_model.DownloadError, "license"):
                download_model._official_metadata()

    def test_artifact_and_runtime_are_exactly_pinned(self) -> None:
        self.assertRegex(constants.TENSORFLOW_MODELS_REVISION, r"^[a-f0-9]{40}$")
        for digest in (
            constants.MODEL_ARCHIVE_SHA256,
            constants.MODEL_SHA256,
            constants.CLASS_MAP_SHA256,
            constants.LICENSE_SHA256,
            constants.MAPPING_SHA256,
            constants.VOCABULARY_SHA256,
        ):
            self.assertRegex(digest, r"^[a-f0-9]{64}$")
        self.assertIn("kaggle-version-763", constants.CLASSIFIER_VERSION)
        self.assertEqual(constants.MODEL_SAMPLE_RATE, 16_000)
        self.assertEqual(constants.TOP_PATCH_COUNT, 3)

    def test_license_copy_must_match_the_pinned_tensorflow_models_revision(self) -> None:
        license_bytes = b"pinned Apache license\n"
        with patch.object(
            download_model,
            "_bounded_download",
            return_value=(license_bytes, constants.LICENSE_URL),
        ), patch.object(constants, "LICENSE_BYTES", len(license_bytes)), patch.object(
            download_model, "LICENSE_BYTES", len(license_bytes)
        ), patch.object(
            download_model, "LICENSE_SHA256", download_model._sha256(license_bytes)
        ):
            self.assertEqual(download_model._license_bytes(), license_bytes)
        with patch.object(
            download_model,
            "_bounded_download",
            return_value=(license_bytes, "https://example.invalid/LICENSE"),
        ):
            with self.assertRaisesRegex(download_model.DownloadError, "redirected"):
                download_model._license_bytes()

    def test_image_is_a_nonroot_offline_cli_not_an_http_service(self) -> None:
        dockerfile = (ROOT / "yamnet-comparator" / "Dockerfile").read_text("utf-8")
        cli = (ROOT / "yamnet-comparator" / "cli.py").read_text("utf-8")
        self.assertIn('USER 65532:65532', dockerfile)
        self.assertIn('ENTRYPOINT ["python", "cli.py"]', dockerfile)
        self.assertNotIn("EXPOSE", dockerfile)
        self.assertNotIn("HEALTHCHECK", dockerfile)
        self.assertIn("/models/yamnet", dockerfile)
        self.assertNotIn("http.server", cli)
        self.assertNotIn("sourceUrl", cli)


if __name__ == "__main__":
    unittest.main()
