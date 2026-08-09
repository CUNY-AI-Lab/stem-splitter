# Instrument discovery service

Private Railway CPU service for optional, advisory instrument detection. It
accepts at most three mono `f32le` PCM windows from `audio-analysis`; it never
receives a source URL or chooses a separation model. A missing, slow, or broken
service leaves the existing Auto routing decision unchanged.

The candidate uses `laion/larger_clap_music` at the exact revision and weight
hash recorded in `constants.py`. The model is downloaded and verified while
the image is built, then Transformers and Hugging Face are forced offline at
runtime. Every model/processor artifact is content-pinned; remote code is
disabled and the checkpoint is loaded in weights-only mode. Startup rejects
extra files, directories, and symlinks outside the eight-artifact manifest and
its generated provenance record.
`pairwise-presence-rand-trunc-v1` scores each reviewed term against its
explicit absence prompt, using the checkpoint's pinned non-fusion ten-second
`rand_trunc` preprocessing path. Scores are independent across labels and remain
uncalibrated candidate signals and are not suitable for a student rollout.

Status: the contract, private HTTP service, scorer, aggregation policy,
checkpoint downloader, and image recipe are implemented locally. A local
arm64 image has built, started with networking disabled, and completed real
model inference; the Railway-targeted amd64 image also builds, but native amd64
startup/inference, Railway resource limits, and useful calibrated detections
remain open gates.

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

The locked smoke starts the image with networking disabled, a read-only root,
bounded CPU/RAM/PIDs, a non-root user, and an ephemeral no-exec `/tmp`; it then
checks the exact readiness pins and runs one real synthetic-control inference:

```sh
npm run smoke:instrument-discovery:image -- \
  stem-splitter-instrument-discovery:v3.2-candidate
```

Repeated matching native arm64 runs scored the three-second control in
258–394 ms; post-warm container-memory observations ranged roughly 405–745 MiB.
The current `linux/amd64` target is 2.11 GB and builds locally, but its emulated
warmup crossed the configured health window. Only a native amd64 runner and
Railway can provide promotion-grade cold-start, memory, and inference
measurements.

## Runtime variables

- `INSTRUMENT_DISCOVERY_TOKEN`: shared bearer token, at least 32 non-whitespace
  characters.
- `INSTRUMENT_DISCOVERY_MODEL_DIR`: baked offline model directory.
- `INSTRUMENT_DISCOVERY_VOCABULARY`: pinned vocabulary JSON path.
- `INSTRUMENT_DISCOVERY_MAX_CONCURRENCY`: `1` by default, never above `2`.
- `INSTRUMENT_DISCOVERY_TORCH_THREADS`: `1` by default, never above `4`.
- `INSTRUMENT_DISCOVERY_INFERENCE_TIMEOUT_SECONDS`: process-fatal synchronous
  inference ceiling, `30` by default and bounded to 10–300 seconds. Keep it at
  or below the response contract in deployment.
- `PORT`: Railway-provided port.

`GET /healthz` is process liveness. `GET /readyz` stays unavailable until the
full artifact manifest, revision marker, vocabulary hash, processor, and text
embeddings are usable. `POST /v1/classify` requires the bearer token and the
exact cross-service contract headers.

The HTTP client timeout cannot cancel a synchronous PyTorch call already in
progress. Each permitted concurrent inference therefore has an independent
process-fatal watchdog: expiry clears readiness and exits with code 70 so the
runtime can replace the wedged process. Fake-backend tests cover the concurrency
race and execute the real child-process exit path. A built-container and Railway
restart/readiness recovery test with real PyTorch remains a promotion gate.
