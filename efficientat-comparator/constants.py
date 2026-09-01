"""Frozen artifact and execution pins for the offline EfficientAT comparator."""

from __future__ import annotations

OUTPUT_SCHEMA = "stem-splitter.efficientat-comparator-output.v1"
MAPPING_SCHEMA = "stem-splitter.efficientat-class-mapping.v1"
SCORING_POLICY_VERSION = "single-clip-sigmoid-second-window-v1"
CLASSIFIER_VERSION = (
    "efficientat-mn10-audioset-527-pcm22050-sinc32k-upstream-mel-"
    f"{SCORING_POLICY_VERSION}@github-release-v0.0.1"
)

UPSTREAM_REPOSITORY = "fschmid56/EfficientAT"
UPSTREAM_REVISION = "7e30f2bbe85439c15feedd9ba5ad8bff0a600fee"
UPSTREAM_RELEASE_ID = 83_399_939
UPSTREAM_RELEASE_TAG = "v0.0.1"
UPSTREAM_RELEASE_PUBLISHED_AT = "2022-11-17T14:37:35Z"
UPSTREAM_LICENSE = "MIT"
UPSTREAM_LICENSE_NAME = "LICENSE.EfficientAT"
UPSTREAM_LICENSE_URL = (
    "https://raw.githubusercontent.com/fschmid56/EfficientAT/"
    f"{UPSTREAM_REVISION}/LICENSE"
)
UPSTREAM_LICENSE_BYTES = 1_071
UPSTREAM_LICENSE_SHA256 = (
    "7a45b1641304427db80df436cab61c04ddb634d97e9a8b7a93de41db940fa8b5"
)
UPSTREAM_SOURCE_SHA256 = {
    "LICENSE": UPSTREAM_LICENSE_SHA256,
    "README.md": "73b34b092e4c82275fde0c561e343f8a72655bda99af7bf64a5931c85f90aacf",
    "helpers/utils.py": "d72ce3b33db9e1fa13a76cd206ee713e57086cdd9f1a87b9b5afdf8695e3a326",
    "metadata/class_labels_indices.csv": "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429",
    "models/MobileNetV3.py": "cdbb7e7c775da01e32968651c34d486a560fd8c23d825dd259f3e3e36e85241a",
    "models/attention_pooling.py": "4bf8a515ad0c24480b54a4d7bd04ea2bbf2a0ae29cf81b944e022f7f01651fc1",
    "models/block_types.py": "73f4e23e29ef86acb60ec6c5487210f8f3f217c1c68e603d464674ab9b973598",
    "models/preprocess.py": "ae79a4ad13827f695b1565545c1e514653c49d50534ef03801877169fccafb64",
    "models/utils.py": "deb551bd854f90ca1473d731de1d7586af9449fc95fd2432f4cc9d0ccd38c11b",
}

RELEASE_METADATA_URL = (
    "https://api.github.com/repos/fschmid56/EfficientAT/releases/tags/v0.0.1"
)
MODEL_ASSET_ID = 84_972_323
MODEL_ASSET_NAME = "mn10_as_mAP_471.pt"
MODEL_URL = (
    "https://github.com/fschmid56/EfficientAT/releases/download/"
    f"{UPSTREAM_RELEASE_TAG}/{MODEL_ASSET_NAME}"
)
MODEL_REDIRECT_HOST = "release-assets.githubusercontent.com"
MODEL_REDIRECT_PATH = (
    "/github-production-release-asset/550692666/"
    "f2dead49-7c9d-469b-80c4-77f4c78a0134"
)
MODEL_BYTES = 19_708_753
MODEL_SHA256 = (
    "0bd7dc2443af498c289a2e739f02ebb515d6aa3fd3ab9db539c86123ae368a4e"
)
MODEL_TENSOR_COUNT = 312
MODEL_TENSOR_ELEMENTS = 4_901_277
SAFE_WEIGHTS_NAME = "mn10_as_mAP_471.safetensors"
SAFE_WEIGHTS_BYTES = 19_636_060
SAFE_WEIGHTS_SHA256 = (
    "6082249d637adb6880ff8ecbe7bc917e515ee0fabe1268581f614dc56e5c71a9"
)

CLASS_MAP_NAME = "class_labels_indices.csv"
CLASS_MAP_URL = (
    "https://raw.githubusercontent.com/fschmid56/EfficientAT/"
    f"{UPSTREAM_REVISION}/metadata/{CLASS_MAP_NAME}"
)
CLASS_MAP_BYTES = 14_675
CLASS_MAP_SHA256 = (
    "cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429"
)
CLASS_COUNT = 527

VOCABULARY_VERSION = "classroom-instruments-v1"
VOCABULARY_SHA256 = (
    "72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140"
)
MAPPING_SHA256 = (
    "b8aa419a47b612144655b2f3409fbb6eb27aabed79b49717a20f96a0f15ad50d"
)

INPUT_SAMPLE_RATE = 22_050
MODEL_SAMPLE_RATE = 32_000
MAX_WINDOWS = 3
MAX_WINDOW_SECONDS = 15
MAX_WINDOW_SAMPLES = INPUT_SAMPLE_RATE * MAX_WINDOW_SECONDS
MAX_PCM_BYTES = INPUT_SAMPLE_RATE * 45 * 4
MAX_OUTPUT_BYTES = 64 * 1024
TOP_CLASS_COUNT = 12
