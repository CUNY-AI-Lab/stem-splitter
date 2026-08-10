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

## Reproduction boundary

Run `npm run baseline:railway` through `railway run` scoped to the canonical
project, environment, and app-service IDs. Provide `SOURCE_AUDIO` from the
authorized local corpus and use `BASELINE_OUT` for the JSON result. The command
reads the class code from the Railway environment, never prints or stores it,
refuses cross-origin upload/stem URLs, disables redirects on authenticated
requests, verifies the live four-track catalogue, and stores no audio.

Automated hash/header checks do not replace listening. Manual comparison of
the four tracks remains part of the release acceptance before authority changes.
