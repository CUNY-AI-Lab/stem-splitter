"""Frozen artifact and execution pins for the offline YAMNet comparator."""

from __future__ import annotations

OUTPUT_SCHEMA = "stem-splitter.yamnet-comparator-output.v1"
MAPPING_SCHEMA = "stem-splitter.yamnet-class-mapping.v1"
SCORING_POLICY_VERSION = "max-class-top3-patch-mean-second-window-v1"
CLASSIFIER_VERSION = (
    "google-yamnet-tflite-v1-"
    f"{SCORING_POLICY_VERSION}@kaggle-version-763"
)

KAGGLE_METADATA_URL = (
    "https://www.kaggle.com/api/v1/models/list?owner=google&search=yamnet"
)
MODEL_ARCHIVE_URL = (
    "https://www.kaggle.com/models/google/yamnet/TfLite/tflite/1/download"
)
MODEL_ARCHIVE_ALLOWED_REDIRECT_HOST = "storage.googleapis.com"
MODEL_ARCHIVE_ALLOWED_REDIRECT_PATH = (
    "/kaggle-models-data/630/763/bundle/archive.tar.gz"
)
MODEL_ARCHIVE_BYTES = 14_220_537
MODEL_ARCHIVE_SHA256 = (
    "be65f33dc14caf40e2044c71ebb2633d04deb059b6916eaa06a408e1070b018c"
)
MODEL_MEMBER_NAME = "1.tflite"
MODEL_BYTES = 16_096_668
MODEL_SHA256 = (
    "141fba1cdaae842c816f28edc4937e8b4f0af4c8df21862ccc6b52dc567993c3"
)
KAGGLE_MODEL_ID = 52
KAGGLE_INSTANCE_ID = 630
KAGGLE_VERSION_ID = 763
KAGGLE_VERSION_NUMBER = 1
KAGGLE_LICENSE = "Apache 2.0"

TENSORFLOW_MODELS_REVISION = "4d7bdd8c170ee90850f2f9ccef0f6d19b817de35"
CLASS_MAP_URL = (
    "https://raw.githubusercontent.com/tensorflow/models/"
    f"{TENSORFLOW_MODELS_REVISION}/research/audioset/yamnet/"
    "yamnet_class_map.csv"
)
CLASS_MAP_BYTES = 14_096
CLASS_MAP_SHA256 = (
    "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2"
)
CLASS_COUNT = 521
LICENSE_NAME = "LICENSE.YAMNET"
LICENSE_URL = (
    "https://raw.githubusercontent.com/tensorflow/models/"
    f"{TENSORFLOW_MODELS_REVISION}/LICENSE"
)
LICENSE_BYTES = 11_512
LICENSE_SHA256 = (
    "5b17814bf0de8cf65069bc6d7cc38cff19fcaa864d243423ad3ef3db01b52385"
)

VOCABULARY_VERSION = "classroom-instruments-v1"
VOCABULARY_SHA256 = (
    "72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140"
)
# Filled only from reviewed mapping bytes. A mapping change requires a new
# classifier id as well as a new digest.
MAPPING_SHA256 = (
    "cda962367ff7cf0b65674b5cbd8cb8289a34789c671df83d4e27ba583e4b3318"
)

INPUT_SAMPLE_RATE = 22_050
MODEL_SAMPLE_RATE = 16_000
MODEL_MINIMUM_SAMPLES = 15_600
MAX_WINDOWS = 3
MAX_WINDOW_SECONDS = 15
MAX_WINDOW_SAMPLES = INPUT_SAMPLE_RATE * MAX_WINDOW_SECONDS
MAX_PCM_BYTES = INPUT_SAMPLE_RATE * 45 * 4
MAX_OUTPUT_BYTES = 64 * 1024
TOP_CLASS_COUNT = 12
TOP_PATCH_COUNT = 3
