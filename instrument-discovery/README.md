# Instrument discovery service

Private Railway CPU service for optional, advisory instrument detection. It
accepts at most three mono `f32le` PCM windows from `audio-analysis`; it never
receives a source URL or chooses a separation model. A missing, slow, or broken
service leaves the existing Auto routing decision unchanged.

The candidate uses `laion/larger_clap_music` at the exact revision and weight
hash recorded in `constants.py`. The model is downloaded and verified while
the image is built, then Transformers and Hugging Face are forced offline at
runtime. `pairwise-presence-v1` scores each reviewed term against its explicit
absence prompt, so scores are independent across labels. They remain
uncalibrated candidate signals and are not suitable for a student rollout.

Status: the contract, private HTTP service, scorer, aggregation policy,
checkpoint downloader, and image recipe are implemented locally. Contract and
fake-backend tests do not establish that the large model image builds, starts
offline, fits Railway resource limits, or produces useful detections; those
gates remain open.

## Local contract tests

The tests use a fake scorer and do not download PyTorch or model weights:

```sh
npm run test:instrument-discovery
```

Generate or refresh the dependency lock without installing the model:

```sh
uv lock --project instrument-discovery --python 3.12
```

Build the image from the repository root. This downloads roughly 776 MB of
model weights at the pinned Hugging Face revision:

```sh
docker build -f instrument-discovery/Dockerfile .
```

## Runtime variables

- `INSTRUMENT_DISCOVERY_TOKEN`: shared bearer token, at least 32 non-whitespace
  characters.
- `INSTRUMENT_DISCOVERY_MODEL_DIR`: baked offline model directory.
- `INSTRUMENT_DISCOVERY_VOCABULARY`: pinned vocabulary JSON path.
- `INSTRUMENT_DISCOVERY_MAX_CONCURRENCY`: `1` by default, never above `2`.
- `INSTRUMENT_DISCOVERY_TORCH_THREADS`: `1` by default, never above `4`.
- `PORT`: Railway-provided port.

`GET /healthz` is process liveness. `GET /readyz` stays unavailable until the
model file, revision marker, vocabulary hash, processor, and text embeddings
are usable. `POST /v1/classify` requires the bearer token and the exact
cross-service contract headers.
