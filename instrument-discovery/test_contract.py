from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from clap_backend import (
    build_prompt_pairs,
    pairwise_presence_scores,
    validate_audio_preprocessing,
    verify_model_directory,
)
from constants import (
    CLAP_MAX_INPUT_SECONDS,
    CLAP_SAMPLE_RATE,
    CLAP_TRUNCATION_MODE,
    CLASSIFIER_VERSION,
    MODEL_ARTIFACT_SHA256,
    MODEL_PROVENANCE_FILE,
    MODEL_REVISION,
    MODEL_WEIGHTS_SHA256,
    VOCABULARY_SHA256,
)
from contract import DiscoveryContractError, aggregate_window_scores, load_vocabulary

ROOT = Path(__file__).resolve().parents[1]
VOCABULARY_PATH = Path(__file__).with_name("vocabulary.json")


class ContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vocabulary = load_vocabulary(VOCABULARY_PATH)

    def scores(self, **overrides: float) -> dict[str, float]:
        values = {instrument_id: 0.0 for instrument_id in self.vocabulary.ids}
        values.update(overrides)
        return values

    def test_cross_language_pins_are_exact(self) -> None:
        typescript = (ROOT / "src/analysis/types.ts").read_text("utf-8")
        for pin in (
            CLASSIFIER_VERSION,
            MODEL_REVISION,
            MODEL_WEIGHTS_SHA256,
            VOCABULARY_SHA256,
        ):
            self.assertIn(pin, typescript)

    def test_every_model_artifact_has_an_exact_content_pin(self) -> None:
        self.assertEqual(
            tuple(filename for filename, _digest in MODEL_ARTIFACT_SHA256),
            (
                "config.json",
                "merges.txt",
                "preprocessor_config.json",
                "pytorch_model.bin",
                "special_tokens_map.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "vocab.json",
            ),
        )
        self.assertTrue(
            all(len(digest) == 64 and set(digest) <= set("0123456789abcdef")
                for _filename, digest in MODEL_ARTIFACT_SHA256)
        )
        self.assertEqual(dict(MODEL_ARTIFACT_SHA256)["pytorch_model.bin"], MODEL_WEIGHTS_SHA256)

    def test_model_directory_rejects_any_unpinned_surface(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "unexpected-model-code.py").write_text("raise SystemExit\n", "utf-8")
            with self.assertRaisesRegex(DiscoveryContractError, "surface"):
                verify_model_directory(root)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for filename, _digest in MODEL_ARTIFACT_SHA256:
                (root / filename).touch()
            (root / MODEL_PROVENANCE_FILE).touch()
            (root / "config.json").unlink()
            (root / "config.json").symlink_to("merges.txt")
            with self.assertRaisesRegex(DiscoveryContractError, "surface"):
                verify_model_directory(root)

    def test_container_recipe_is_pinned_offline_non_root_and_lock_frozen(self) -> None:
        dockerfile = (ROOT / "instrument-discovery/Dockerfile").read_text("utf-8")
        dockerignore = (ROOT / "instrument-discovery/Dockerfile.dockerignore").read_text(
            "utf-8"
        )
        project = (ROOT / "instrument-discovery/pyproject.toml").read_text("utf-8")
        lock = (ROOT / "instrument-discovery/uv.lock").read_text("utf-8")
        self.assertIn("python:3.12.13-slim-bookworm@sha256:", dockerfile)
        self.assertIn("ghcr.io/astral-sh/uv:0.11.32@sha256:", dockerfile)
        self.assertIn("uv sync --frozen", dockerfile)
        self.assertIn("HF_HUB_OFFLINE=1", dockerfile)
        self.assertIn("TRANSFORMERS_OFFLINE=1", dockerfile)
        self.assertIn("USER 65532:65532", dockerfile)
        self.assertIn("INSTRUMENT_DISCOVERY_INFERENCE_TIMEOUT_SECONDS=30", dockerfile)
        self.assertNotIn(":latest", dockerfile)
        backend = (ROOT / "instrument-discovery/clap_backend.py").read_text("utf-8")
        self.assertIn("weights_only=True", backend)
        self.assertGreaterEqual(backend.count("trust_remote_code=False"), 2)
        self.assertGreaterEqual(backend.count("local_files_only=True"), 2)
        self.assertEqual(
            dockerignore.strip().splitlines(),
            [
                "**",
                "!instrument-discovery/",
                "!instrument-discovery/*.py",
                "!instrument-discovery/pyproject.toml",
                "!instrument-discovery/uv.lock",
                "!instrument-discovery/vocabulary.json",
            ],
        )
        for dependency in (
            'huggingface-hub==0.36.2',
            'numpy==2.5.2',
            'scipy==1.18.0',
            'torch==2.13.0',
            'transformers==4.57.6',
        ):
            self.assertIn(dependency, project)
        self.assertIn('name = "torch"', lock)
        self.assertIn('version = "2.13.0+cpu"', lock)
        self.assertIn('name = "transformers"', lock)
        self.assertIn('version = "4.57.6"', lock)

    def test_one_transient_window_does_not_become_a_detection(self) -> None:
        detections = aggregate_window_scores(
            self.vocabulary,
            [
                self.scores(saxophone=0.99),
                self.scores(saxophone=0.10),
                self.scores(saxophone=0.10),
            ],
        )
        self.assertEqual(detections, [])

    def test_two_supported_windows_can_abstain_or_report_uncertain(self) -> None:
        detections = aggregate_window_scores(
            self.vocabulary,
            [
                self.scores(saxophone=0.82, trumpet=0.57),
                self.scores(saxophone=0.82, trumpet=0.99),
                self.scores(saxophone=0.20, trumpet=0.10),
            ],
        )
        self.assertEqual(
            detections,
            [
                {
                    "id": "saxophone",
                    "label": "Saxophone",
                    "confidence": 0.613333,
                    "state": "uncertain",
                    "windowSupport": 2,
                    "windowsAnalyzed": 3,
                }
            ],
        )

    def test_single_window_still_requires_the_family_floor(self) -> None:
        self.assertEqual(
            aggregate_window_scores(self.vocabulary, [self.scores(accordion=0.69)])[0]["state"],
            "uncertain",
        )
        self.assertEqual(
            aggregate_window_scores(self.vocabulary, [self.scores(accordion=0.57)]), []
        )

    def test_classifier_scores_must_cover_exactly_the_pinned_vocabulary(self) -> None:
        incomplete = self.scores()
        incomplete.pop("saxophone")
        with self.assertRaisesRegex(DiscoveryContractError, "ids"):
            aggregate_window_scores(self.vocabulary, [incomplete])
        with self.assertRaisesRegex(DiscoveryContractError, "outside"):
            aggregate_window_scores(self.vocabulary, [self.scores(saxophone=math.nan)])

    def test_prompt_policy_is_independent_per_instrument(self) -> None:
        prompts, indexes = build_prompt_pairs(self.vocabulary)
        self.assertEqual(len(prompts) % 2, 0)
        self.assertTrue(all("music recording" in prompt for prompt in prompts))
        logits = [0.0] * len(prompts)
        sax_index = self.vocabulary.ids.index("saxophone")
        sax_pair = indexes[sax_index][0]
        logits[sax_pair * 2] = 2.0
        logits[sax_pair * 2 + 1] = -2.0
        scores = pairwise_presence_scores(logits, indexes)
        self.assertGreater(scores[sax_index], 0.98)
        self.assertAlmostEqual(scores[self.vocabulary.ids.index("trumpet")], 0.5)

    def test_prompt_policy_rejects_non_finite_or_wrong_length_logits(self) -> None:
        _prompts, indexes = build_prompt_pairs(self.vocabulary)
        with self.assertRaisesRegex(DiscoveryContractError, "count"):
            pairwise_presence_scores([0.0], indexes)
        logits = [0.0] * (sum(len(group) for group in indexes) * 2)
        logits[0] = math.inf
        with self.assertRaisesRegex(DiscoveryContractError, "non-finite"):
            pairwise_presence_scores(logits, indexes)

    def test_checkpoint_preprocessing_requires_non_fusion_rand_trunc(self) -> None:
        model = SimpleNamespace(
            config=SimpleNamespace(audio_config=SimpleNamespace(enable_fusion=False))
        )
        extractor = SimpleNamespace(
            truncation=CLAP_TRUNCATION_MODE,
            sampling_rate=CLAP_SAMPLE_RATE,
            nb_max_samples=CLAP_SAMPLE_RATE * CLAP_MAX_INPUT_SECONDS,
        )
        self.assertEqual(validate_audio_preprocessing(model, extractor), "rand_trunc")

        for field, value in (
            ("truncation", "fusion"),
            ("sampling_rate", 44_100),
            ("nb_max_samples", CLAP_SAMPLE_RATE * 15),
        ):
            invalid = SimpleNamespace(**extractor.__dict__)
            setattr(invalid, field, value)
            with self.assertRaisesRegex(DiscoveryContractError, "does not match"):
                validate_audio_preprocessing(model, invalid)

        fused = SimpleNamespace(
            config=SimpleNamespace(audio_config=SimpleNamespace(enable_fusion=True))
        )
        with self.assertRaisesRegex(DiscoveryContractError, "fusion mode"):
            validate_audio_preprocessing(fused, extractor)


if __name__ == "__main__":
    unittest.main()
