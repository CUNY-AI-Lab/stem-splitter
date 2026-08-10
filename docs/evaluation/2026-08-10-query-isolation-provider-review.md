# Query-isolation provider review — 2026-08-10

This is a source-and-contract review, not a quality result or deployment
approval. No prediction was started, no Railway variable was changed, and the
application has no query-isolation route or persistent isolation resource.
`QUERY_ISOLATION_ENABLED` remains false.

## Decision

| Candidate | Verified capability and provenance | Current disposition |
|---|---|---|
| AudioSep | The official Audio-AGI repository describes 32 kHz, natural-language target separation and its source repository carries an MIT license. The reviewed repository head was `944583f18b84589dc965de3ad77525c945334252`. Replicate exposes community model `cjwbw/audiosep`, not an Audio-AGI-operated model, with immutable version `f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8`; its contract is `audio_file` plus `text` to one URI. Replicate attributes that build to the `chenxwh/AudioSep` fork at commit `e3bd8d4631206a1c1870ece762a8fa21da8794f7`. The Replicate page does not bind an independently verifiable checkpoint hash/license chain; a separate `nielsr/audiosep-demo` mirror labels its checkpoint Apache-2.0, but this review cannot establish that the hosted build uses those exact bytes. | First evaluation adapter. Exact-pin and schema guards are implemented, but the adapter is dormant until checkpoint provenance, the separate resource, teacher authorization, budgets, and quality gate exist. |
| SAM-Audio | Meta's official repository at reviewed head `bb4c6999d2677c7402360e426afc01ddfad6dce0` supports text, visual, and span prompts and produces target plus residual. Checkpoints require approved Hugging Face access. Code and weights use the custom SAM License dated 2025-11-19 rather than a standard permissive license. The Replicate option found (`geopti/sam-audio-large`) is community-hosted. | Evaluation-only research. Do not add an app adapter, credential, or student choice before institutional license/checkpoint and hosting review. |
| Banquet / Query-Bandit | The reviewed repository head was `79ed5bb75e5c3a40cd319d9d990cee913fc65c26`. Its code is MIT licensed and the README reports beyond-four-stem separation, including reeds and organs, but the documented bring-your-own-query path takes query audio rather than the normalized text target used by AudioSep/SAM-Audio. | Phase 5 only. It needs a different query/provenance design and a coherent multi-stem decision before any private GPU packaging. |

## Implemented boundary

The AudioSep adapter has one provider-owned contract id and an environment pin,
`REPLICATE_AUDIOSEP_VERSION`. Construction rejects missing, uppercase,
whitespace-padded, shortened, floating, or merely different 64-hex values; the
configured value must match the source-reviewed pin. `npm run check:isolation`
fetches that exact version's OpenAPI schema and fails if either input
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

The adapter is deliberately not imported by `src/index.ts`. A flipped flag
therefore cannot spend money or mutate a completed split. The next executable
phase must add the additive `instrument_isolations` resource, teacher-only API,
per-track concurrency/budget/timeout limits, signed-source lifetime tests,
output hydration/retention, and a fixed evaluation manifest before it wires
this adapter into a request path.

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
