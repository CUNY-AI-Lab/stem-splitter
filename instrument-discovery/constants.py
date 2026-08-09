"""Frozen cross-service pins for the v3.2 instrument-discovery candidate."""

from __future__ import annotations

DISCOVERY_SCHEMA_VERSION = "1"
SCORING_POLICY_VERSION = "pairwise-presence-rand-trunc-v1"
MODEL_PROVENANCE_FILE = "stem-splitter-model.json"
MODEL_REPOSITORY = "laion/larger_clap_music"
MODEL_REVISION = "a0b4534a14f58e20944452dff00a22a06ce629d1"
CLASSIFIER_VERSION = (
    f"laion-larger-clap-music-{SCORING_POLICY_VERSION}@{MODEL_REVISION}"
)
MODEL_WEIGHTS_SHA256 = (
    "5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1"
)
MODEL_ARTIFACT_SHA256 = (
    ("config.json", "2d7722d338bb83ea8824272b1431f088954d3425d79eb3c2d39489478516dc03"),
    ("merges.txt", "1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5"),
    (
        "preprocessor_config.json",
        "9739f58296aa6f9ac18008fd0150fb2649bc554985fbde86d0a4041c882ac753",
    ),
    (
        "pytorch_model.bin",
        "5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1",
    ),
    (
        "special_tokens_map.json",
        "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
    ),
    (
        "tokenizer.json",
        "dc239041d98de27ffc3975473a1a23e3db4c937b23c138c38bbc66588bd247e5",
    ),
    (
        "tokenizer_config.json",
        "e2eb445cfdbf4711de620cbdf10478b0423950799e85652d9f28da47066ab86d",
    ),
    ("vocab.json", "ed19656ea1707df69134c4af35c8ceda2cc9860bf2c3495026153a133670ab5e"),
)
VOCABULARY_VERSION = "classroom-instruments-v1"
VOCABULARY_SHA256 = (
    "72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140"
)

INPUT_SAMPLE_RATE = 22_050
CLAP_SAMPLE_RATE = 48_000
CLAP_TRUNCATION_MODE = "rand_trunc"
CLAP_MAX_INPUT_SECONDS = 10
MAX_WINDOWS = 3
MAX_WINDOW_SECONDS = 15
MAX_WINDOW_SAMPLES = INPUT_SAMPLE_RATE * MAX_WINDOW_SECONDS
MAX_PCM_BYTES = INPUT_SAMPLE_RATE * 45 * 4
MAX_RETURNED_DETECTIONS = 12
MAX_RESPONSE_BYTES = 64 * 1024

POSITIVE_PROMPT_TEMPLATE = "a music recording featuring {term}"
NEGATIVE_PROMPT_TEMPLATE = "a music recording without {term}"
