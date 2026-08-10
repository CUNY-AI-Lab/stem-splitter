# Query-isolation provider review — 2026-08-10

This is a source-and-contract review, not a quality result or deployment
approval. No prediction was started, no Railway variable was changed, and the
application has no query-isolation provider-start route. It now has an additive
resource, teacher-only historical readback, and a false-default shadow-create
route. That route can populate demand/cache metadata but cannot claim a row,
construct the provider adapter, or reach Replicate.
`QUERY_ISOLATION_ENABLED` remains false.

## Decision

| Candidate | Verified capability and provenance | Current disposition |
|---|---|---|
| AudioSep | The official Audio-AGI repository describes 32 kHz, natural-language target separation and its source repository carries an MIT license. The reviewed repository head was `944583f18b84589dc965de3ad77525c945334252`. Replicate exposes community model `cjwbw/audiosep`, not an Audio-AGI-operated model, with immutable version `f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8`; its contract is `audio_file` plus `text` to one URI. Replicate attributes that build to fork commit `e3bd8d4631206a1c1870ece762a8fa21da8794f7`, but that tree contains no Cog wrapper, predictor, or checkpoint. The wrapper first appears later at `5fa5394910971d256beb8875f29e6f3aabcf1a8d` and references untracked `checkpoint/audiosep_base_4M_steps.ckpt`, whose bytes are absent from Git. A separate mirror labels a checkpoint Apache-2.0, but cannot bind those bytes to the hosted image. | Contract-only dormant adapter. The persistent resource and teacher readback are implemented without a provider-start path. Hosted checkpoint provenance, hashing, budgets, and quality gates still block execution. |
| SAM-Audio | Meta's official repository at reviewed head `bb4c6999d2677c7402360e426afc01ddfad6dce0` supports text, visual, and span prompts and produces target plus residual. Checkpoints require approved Hugging Face access. Code and weights use the custom SAM License dated 2025-11-19 rather than a standard permissive license. The Replicate option found (`geopti/sam-audio-large`) is community-hosted. | Evaluation-only research. Do not add an app adapter, credential, or student choice before institutional license/checkpoint and hosting review. |
| Banquet / Query-Bandit | The reviewed repository head was `79ed5bb75e5c3a40cd319d9d990cee913fc65c26`. Its code is MIT licensed and the README reports beyond-four-stem separation, including reeds and organs, but the documented bring-your-own-query path takes query audio rather than the normalized text target used by AudioSep/SAM-Audio. | Phase 5 only. It needs a different query/provenance design and a coherent multi-stem decision before any private GPU packaging. |

## Implemented boundary

The AudioSep adapter has one provider-owned contract id and an environment pin,
`REPLICATE_AUDIOSEP_VERSION`. Construction rejects missing, uppercase,
whitespace-padded, shortened, floating, or merely different 64-hex values; the
configured value must match the reviewed provider-version pin.
`npm run check:isolation` fetches that exact version's OpenAPI schema and fails if either input
disappears, the input types drift, or the one-URI output changes shape.

The request contract:

- canonicalizes and bounds the short target text before a provider call;
- binds cache identity to source SHA-256, normalized target, analysis
  vocabulary, provider, model, exact version, and adapter-contract version;
- sends only the short-lived HTTPS source URL, normalized target, and HTTPS
  webhook required for the provider job;
- accepts successful output only from HTTPS `replicate.delivery` hosts;
- returns one optional target isolation and never a core stem or a claimed
  reconstruction residual;
- converts provider failures to app-owned codes without persisting raw errors.

The additive `instrument_isolations` resource now records source/prompt/model
cache identity, app-owned state, requesting teacher, attempts, deadlines, and
separate target/residual storage keys. Its repository accepts only completed
core jobs, atomically caps each track at two requests and one processing
attempt, permits at most two tries, and leaves the core job untouched on
failure. A teacher session can read bounded summaries; the class code and
student job response cannot. Historical readback remains available after a
flag rollback.

The private analyzer now exposes an authenticated `/v1/fingerprint` contract
that streams the exact stored source through the same origin, redirect, byte,
timeout, concurrency, and temporary-file controls as analysis. It returns a
lowercase SHA-256 and byte count without decoding. The app persists the digest
privately on `jobs`; neither teacher summaries nor student jobs expose it. A
shadow request with no stored digest must obtain and compare-and-set this
identity before it can create a resource row.

The provider-start adapter itself remains unimported by `src/index.ts`. No
provider-start, webhook, or output-download route exists, and shadow rows are
excluded from the claim transition, so a flipped flag still cannot spend
money. The next executable phase must add a semester budget, resolve the
checkpoint provenance blocker, test signed-source lifetime and output
hydration/retention, and pass the fixed evaluation manifest before any route
may construct the adapter.

## Primary sources

- [AudioSep official repository and inference contract](https://github.com/Audio-AGI/AudioSep)
- [AudioSep MIT license](https://github.com/Audio-AGI/AudioSep/blob/main/LICENSE)
- [Separate AudioSep checkpoint mirror and Apache-2.0 metadata](https://huggingface.co/nielsr/audiosep-demo)
- [Pinned community AudioSep Replicate version](https://replicate.com/cjwbw/audiosep/versions/f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8/api)
- [Replicate AudioSep version history and source attribution](https://replicate.com/cjwbw/audiosep/versions)
- [SAM-Audio official repository and prompt/output contract](https://github.com/facebookresearch/sam-audio)
- [SAM-Audio license](https://github.com/facebookresearch/sam-audio/blob/main/LICENSE)
- [Community SAM-Audio Replicate schema](https://replicate.com/geopti/sam-audio-large/api/schema)
- [Banquet / Query-Bandit official repository](https://github.com/kwatcharasupat/query-bandit)
