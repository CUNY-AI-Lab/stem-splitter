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

## Licensed-corpus candidate evaluation

The versioned evaluation manifest maps every audible-instrument annotation in
the eleven-file licensed corpus to reviewed vocabulary IDs. It also records
directional hard negatives for four similar-timbre trials and names the two
remaining corpus gaps: solo strings versus a string section, and pitched
percussion versus keys. These mappings do not create separator tracks.

Run the hydrated corpus against the already-built image:

```sh
npm run eval:instruments:image
```

Pass one or more corpus slugs to narrow the run, or write a new report without
overwriting an earlier artifact:

```sh
npm run eval:instruments:image -- jazz-sax orchestral \
  --output /tmp/instrument-discovery-candidate.json
```

The runner generates an ephemeral bearer token, starts the offline-forced image
on a per-run no-masquerade Docker bridge with an automatically allocated
loopback host port, a read-only root, and bounded CPU/RAM/swap/PIDs, waits for
the pinned model to become ready, and always removes the container and network.
The report includes exact classifier/
vocabulary/decoder pins, hashes of the locally supplied audio, per-source
detections, annotated-group coverage, hard-negative hits, abstentions,
family/genre summaries, timing, parent/child overlap candidates, and the
confusion-trial gaps. It never prints the token or audio and never mutates
thresholds, vocabulary, routing, or production state.
When `--output` is used, the evaluator refuses to overwrite an existing path
and creates the report with mode `0600`.

The corpus annotations are intentionally non-exhaustive, so this report is a
candidate-review baseline—not a precision claim or release gate. Threshold
calibration still requires reviewed positive and hard-negative clips, manual
listening, prompt-policy controls, and repeatable native-amd64/Railway evidence.

`INSTRUMENT_DISCOVERY_EVAL_READY_SECONDS` may raise the bounded readiness wait
from its 240-second default to at most 900 seconds for an emulated local image.
The runner exits immediately if the container stops or becomes unhealthy.
The image's baked health policy remains authoritative and may end an emulated
run before that outer wait. Changing the runner wait does not relax the native
CI or Railway cold-start acceptance gate.

The 2026-08-09 native-arm64 baseline completed all eleven sources but surfaced
none of 42 reviewed instrument groups: all eleven sources abstained. The
service therefore remains flag-off. Do not lower the current family thresholds
until an offline diagnostic exposes pre-threshold scores and measures the
current positive/`without` prompt policy against controlled alternatives; any
prompt-policy change receives a new classifier ID and a full corpus rerun.

The offline raw-score audit is separate from the HTTP service and runs with no
container network. It bind-mounts the diagnostic code and temporary decoded PCM
read-only, captures current per-window label scores, then deletes the PCM:

```sh
umask 077
INSTRUMENT_DISCOVERY_IMAGE=stem-splitter-instrument-discovery:v3.2-native-smoke \
  npm run --silent eval:instrument-scores:image \
  > /tmp/instrument-discovery-score-audit.json
```

The first full audit found the best score for each of the 42 expected groups in
the extremely narrow `0.499894`–`0.500002` range. Expected, hard-negative, and
unreviewed labels all occupied the same range around `0.5`; one-term and
two-term prompt groups were likewise not meaningfully separated. This is
evidence that the current positive-versus-`without` comparison is not a useful
presence score on this corpus—not evidence for lowering thresholds. A
positive-only control then showed that the problem is broader than negation:
only 13/42 reviewed groups placed an accepted label in the top 12, the mean best
rank was 25.67, and unrelated koto/sitar/mallet-percussion labels repeatedly
dominated. Treat the current prompt/checkpoint pairing as rejected. Any revised
policy receives a new classifier ID and must rerun the entire corpus before
threshold calibration or teacher shadow.

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
