# v3.2 pre-release Railway rollback baseline

This captures the last known-good four-track behavior before the v3.2 audio
pipeline is deployed. It is rollback evidence for the existing Railway app,
not proof that the v3.2 branch or either private analysis service is live.

## Exact live baseline

- Railway deployment: `7f4bc330-4c52-4257-8762-3b85a24b2d07` (`SUCCESS`)
- Deployed commit: `9c3120cbdf5b56b872384f155c746930e064aa09`
- Image digest:
  `sha256:cf04a8a3d2b369009a9a0fe79cdda166c92937d117d5559cd00ed6b8807853ca`
- Public health: `200`, correct canonical base, prompt schema ready
- Separation contract: `htdemucs_ft` -> `vocals`, `drums`, `bass`, `other`
- Replicate Demucs version:
  `5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77`
- Authorized source: selene XIV, “Stiff Hand,” Internet Archive item
  `catboi-album`, CC BY 4.0; source SHA-256
  `a929ec6515ecc915111d2de59acb9ff81d53a6194f2a551775859b0d291cd658`
- Job: `d0c038cd-6f75-49ad-a055-2d22377dbb6a`, completed in 42.738 seconds
- Result: all four promised MP3 tracks returned in contract order with four
  distinct SHA-256 hashes. Exact sizes and hashes are in `baseline.json`.

The exact `milwrite/yt-audio` version `bcd3b512…` was validated against its
`url`/`max_duration` input and `audio`/`duration`/`title` output schema, then
staged on the Railway configuration plane with deploys suppressed. It was not
part of this upload-based job and is not claimed as active in the still-running
pre-v3.2 container.

## Candidate source validation

The complete source gate passed on 2026-08-09 against committed source
`d4c5781` (`build: exercise constrained analysis image`):

- root and analyzer TypeScript checks;
- 105 worker/contract tests;
- 21 analyzer tests;
- 5 Railway server/migration tests;
- 5 separator tests;
- 24 discovery-service tests;
- 19 local browser E2E tests; and
- 4 server-authoritative Auto E2E tests covering stored upload, YouTube, and
  Archive sources, analyzer-outage fallback, and oversized job JSON.

The executable command was `npx -y bun@1.3.14 run test:phase0`. The first full
run correctly exposed test fixtures that used descriptive fake YouTube version
names; after every fixture was changed to the same exact 64-hex contract the
entire command passed. The result is bound to `d4c5781`; subsequent
documentation-only commits do not alter that tested source identity.

## Reproduction boundary

Run `npm run baseline:railway` through `railway run` scoped to the canonical
project, environment, and app-service IDs. Provide `SOURCE_AUDIO` from the
authorized local corpus and use `BASELINE_OUT` for the JSON result. The command
reads the class code from the Railway environment, never prints or stores it,
requires HTTPS except on loopback, refuses credential-bearing or cross-origin
upload/stem URLs, disables redirects, bounds every request and response, never
reflects response bodies into errors, verifies the exact ready health/default
four-track catalogue, requires a real MPEG audio frame beyond an optional ID3
tag, and stores no audio. It validates the explicit Railway/provider evidence
metadata before uploading and refuses to overwrite an existing evidence file.

Automated hash/frame checks do not replace listening. Manual comparison of
the four tracks remains part of the release acceptance before authority changes.

## Promotion binding

Commit `ba556213a10dc3b9e8347d9c90fe0a64eedb8e74` binds `baseline.json` to the
v3.2 promotion gate by its immutable SHA-256
`e2369d661e0e0ee11072e5d6877171ce9ec894aab6398e404beb409368dd4827`.
The gate fails closed on artifact, schema, corpus, catalogue, source, timing,
stem, Railway-scope, deployment, image, or provider-pin drift. CI may validate
the authorized source from its committed corpus digest when gitignored audio
is not hydrated; a local run additionally verifies the exact source bytes.
This closes the automated pre-release rollback-baseline condition only. It does
not claim that the v3.2 analyzer exists, that a later deployment still matches
this snapshot, or that a person has accepted the stem audio.
