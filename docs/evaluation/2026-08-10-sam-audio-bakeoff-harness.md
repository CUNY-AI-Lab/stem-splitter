# SAM-Audio evaluation-only bake-off harness — 2026-08-10

This slice adds executable evaluation infrastructure, not a provider rollout.
It does not add a SAM-Audio application adapter, environment variable, route,
credential, prediction call, student choice, Railway service, or deployment.
No provider call ran while preparing or verifying the fixtures.

## Pinned research boundary

The harness records these reviewed identities:

- Meta SAM-Audio repository: `bb4c6999d2677c7402360e426afc01ddfad6dce0`.
- SAM License bytes: SHA-256
  `4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be`.
- gated `facebook/sam-audio-large` Hugging Face repository:
  `5f2cd3a9471a08c7282c06036be6893e18de8b70`.
- community Cog wrapper: `geopti/cog-sam-audio` at
  `52920550f9db9661aa240477b8334fe2457bc399`.
- evaluation-only community Replicate version:
  `geopti/sam-audio-large:d8a8a4fcdcbf0bdc863f6d98cd2117ec0bc02224b576c7b98b2a009a8a1f83fa`.

Those pins do not prove deployability. The checkpoint repository requires
manual access and does not expose a reviewed checkpoint SHA-256 here. The SAM
License still needs institutional approval. The community wrapper uses floating
Git dependencies, and Replicate does not attest that the reviewed wrapper
commit or a particular gated checkpoint hash produced the hosted image. The
manifest therefore freezes `checkpointSha256: null`, license approval false,
and wrapper binding unverified. Any attempt to weaken those blockers fails the
offline manifest tests.

## One comparison surface

`tests/corpus/query-isolation-bakeoff.json` gives AudioSep and SAM-Audio the
same cases instead of creating a favorable corpus for either model.

The objective tranche contains all eight exact-hash ChoraleBricks controls:
flute, oboe, clarinet, trumpet, horn, trombone, saxophone, and tuba. Each target
is mixed only with synchronized tracks from the same piece. The generator makes
a 24-second, mono, 32 kHz float-WAV mixture with:

- an exact target reference present from 6–18 seconds;
- negative target spans at 0–5 and 19–24 seconds;
- an exact residual reference made from the other instruments; and
- an arithmetic target-plus-residual reconstruction of the mixture.

Every case runs in three declared modes when approvals eventually permit paid
evaluation: AudioSep text, SAM-Audio text, and SAM-Audio text plus span anchors.
AudioSep remains target-only; SAM requests target plus residual. Span anchors
are hints for the same mixture, not extraction boundaries or a different test
set.

The subjective tranche reuses six SHA-256-pinned real recordings: folk duet,
orchestral, jazz, hip-hop, bluegrass, and synthwave. Its targets are already
present in each source's reviewed audible-instrument annotations. Those cases
support blinded listening only; they must not inherit objective reference
metrics from the constructed mixtures.

## Executable artifacts

- `scripts/lib/query-isolation-bakeoff.mts` validates every source, provider,
  license/checkpoint blocker, mode, prompt, metric, and fixed pin. It builds
  provider inputs but contains no network or credential path.
- `scripts/prepare-query-isolation-bakeoff.mts` verifies the hydrated controls,
  generates ignored/private fixtures, checks positive and negative spans, pins
  generated file hashes, and proves exact reconstruction.
- `scripts/score-query-isolation-bakeoff.mts` accepts already-downloaded output
  files only when they preserve the full 24-second fixture, along with exact
  provider metadata. It computes aligned target SI-SDR,
  improvement over the mixture, target/interference projection rejection,
  residual SI-SDR, reconstruction residual, latency, and cost. Reports remain
  diagnostic until the complete matrix and blinded teacher review exist.
- `scripts/check-sam-audio-eval-pin.mjs` performs a read-only authenticated
  OpenAPI lookup for the exact community version and checks the six inputs plus
  URI-array output. It never starts a prediction and does not clear any license
  or checkpoint blocker.
- `tests/query-isolation-bakeoff.test.mts` rejects corpus, version, contract,
  license, checkpoint, wrapper, schema, mode, and app-integration drift and
  self-tests the objective metrics with known signals and a known delay.

Prepare or verify local fixtures:

```bash
node --experimental-strip-types scripts/prepare-query-isolation-bakeoff.mts
node --experimental-strip-types scripts/prepare-query-isolation-bakeoff.mts --verify
```

Check the remote schema without starting a prediction:

```bash
node --experimental-strip-types scripts/check-sam-audio-eval-pin.mjs
```

Score one already-downloaded SAM output after approval and an authorized run:

```bash
node --experimental-strip-types scripts/score-query-isolation-bakeoff.mts \
  --case an1-flute \
  --mode sam-audio-text \
  --provider-version d8a8a4fcdcbf0bdc863f6d98cd2117ec0bc02224b576c7b98b2a009a8a1f83fa \
  --target-output /approved/run/an1-flute-target.wav \
  --residual-output /approved/run/an1-flute-residual.wav \
  --latency-ms 12345 \
  --cost-usd 0.00 \
  --json /approved/run/an1-flute-score.json
```

## Verification performed

Local FFmpeg 8.1.2 generated and reverified all eight objective cases. Each
case's positive span contains signal, both negative spans are digital silence,
and target plus residual reconstructs the mixture at the evaluator's numerical
floor (`-120 dB`). The scorer's target-only and target-plus-residual self-checks
passed without network access or provider calls.

## Gates still open

1. Institutional approval of the SAM License and gated checkpoint terms.
2. An exact checkpoint hash and reproducible binding from wrapper, dependencies,
   and checkpoint bytes to any evaluated image.
3. Equivalent AudioSep checkpoint provenance and applicable weight license.
4. A reviewed run budget and cost ceiling before any paid prediction.
5. Complete AudioSep/SAM text results on all eight objective cases, SAM span
   results on those same cases, and blinded review of all six real-mix cases.
6. A documented provider decision, pinned live canary, and teacher-only beta
   rollback before any application adapter may be considered.

Railway remains the integration target while the product is unfinished.
Cloudflare Workers migration remains out of scope.

## Primary sources

- [Meta SAM-Audio repository](https://github.com/facebookresearch/sam-audio)
- [SAM License](https://github.com/facebookresearch/sam-audio/blob/main/LICENSE)
- [gated Meta checkpoint repository](https://huggingface.co/facebook/sam-audio-large)
- [SAM Audio paper](https://arxiv.org/abs/2512.18099)
- [community Cog wrapper](https://github.com/geopti/cog-sam-audio)
- [community Replicate schema](https://replicate.com/geopti/sam-audio-large/api/schema)
