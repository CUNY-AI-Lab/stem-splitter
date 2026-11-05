# Unified music search implementation and release

1. Recover the saved selector repair `224d191` without changing its original
   checkout. Its tree `9f4b196d8dbba494beb8bfa5672fa98567d9b9bb` is preserved by the
   release branch's equivalent commit. Build on merged `dev` (`20c84c3`), not
   Railway's divergent `main`.
2. Reuse Archive's verified streaming search and Commons' bounded import adapter.
   Add one shared discovery response with per-provider status and cancellation.
   Keep explicit provider requests and instructor sample searches compatible.
3. Add independently cached/rate-limited MusicBrainz recording metadata and
   resolve supported source links when direct search returns no audio. Present
   verified files in the existing result list and Fetch/2/4/6 flow. Remove the
   audio-source switch and separate metadata buttons; exclude mixer changes.
4. Verify exact source IDs, rights gates, source provenance, partial
   failures, cancellation/deadlines, repeated searches, cache reuse and shared throttling.
   Run full backend, shared, type, bundle and browser checks, including existing
   upload recovery, playlist, 2/4/6 and resplit coverage.
5. Open a draft PR into `dev`, review final checks, then promote only the tested
   merged tree through `cloudflare/wrangler.jsonc`. Preserve existing production
   bindings and secrets, disabled experimental capabilities and the prior Worker
   version for rollback. Never deploy root `wrangler.jsonc`.
6. Verify served revision/assets and live behavior. Paid live splits require a
   separately authorized test budget; local fixtures do not establish live
   provider acceptance. A successful deployment alone is not a full acceptance
   result.

The separate Library patch is inaccessible under this turn's selected-folder
permissions. It has not been downloaded or reconstructed from a hidden copy.
This change does not implement that patch's relocation of classroom tools from
the Workspace page onto the landing page.
