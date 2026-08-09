# Decision 0001: keep core splits, detections, and isolations separate

**Status:** accepted for staged implementation

**Date:** 2026-08-09

## Decision

Stem Splitter has three different musical-processing concepts. Their names and
storage must remain distinct:

1. A **core split** is one of the existing provider-neutral, mutually structured
   2-, 4-, or 6-track contracts. Its concrete contract id is stored in
   `jobs.model`, and its output is the job's `stems` array.
2. An **instrument detection** is advisory classifier metadata with an
   independent confidence. A label such as saxophone, violin, or synthesizer
   cannot create a stem or select Demucs 6-stem, because that separator does not
   guarantee those outputs.
3. A **query isolation** is an optional extraction for a named target. It is a
   separate resource that may overlap the core split or another isolation. It
   must never be appended to `stems` or described as reconstructing the mix.

`auto` is a routing request, not a separator or model id. The original request
is stored separately from the concrete core model that actually ran. The app
validates every analysis recommendation against the currently advertised core
catalogue before it can route a paid separation.

## Versioning and rollout

- Analysis and routing payloads have explicit schema versions.
- All new processing flags default off. The existing browser Auto and explicit
  2/4/6 behavior remain the rollback path.
- Server Auto first runs in shadow mode, where it records comparison metadata
  but honors the pre-existing browser/default choice. Only the explicit
  authoritative mode may apply a server recommendation.
- Missing credentials, timeouts, service errors, invalid payloads, and
  unsupported recommendations degrade to the existing catalogue default.
- Provider versions and classifier versions are recorded; floating `latest`
  versions are forbidden in live paths.
- Schema changes are additive. A rollback disables the feature without needing
  to roll back the database.

## Evaluation authority

`tests/corpus/corpus.json` is the frozen, rights-documented real-audio manifest.
It spans folk/acoustic, orchestral, shoegaze, piano/strings, jazz/reeds,
hip-hop, bluegrass/traditional strings, and electronic/synth music. Synthetic
and real results remain separate in reports.

## Deployment boundary

The active app and any new private analysis service are integrated on Railway
until the user declares the product finished. This decision does not authorize
a Cloudflare Workers deployment or migration.
