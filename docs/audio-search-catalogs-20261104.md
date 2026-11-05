# Audio search sources

The source control is labeled **Search**. It presents one list and uses the existing Fetch and 2/4/6-stem workflow. Source and license attribution remain attached to each result and saved run. MusicBrainz does not participate in audio search; its metadata client remains available for a separate future Listening Guy integration. No Listening Guy audio-grounding capability is added here.

Search now federates Internet Archive, Wikimedia Commons, Freesound via Openverse, and the Library of Congress National Jukebox data package. Each source has four result slots so a fast source cannot crowd out a slower one. Results stream independently; failures in one source preserve the other results. Searches are cached for ten minutes, cancelled searches stop their pending provider requests, and the UI retains its existing stale-query guard.

## Additional sources

**Freesound via Openverse:** use the public Openverse audio API, restricted to Freesound MP3 files with supported CC BY, CC0 or Public Domain Mark licenses. No API account or key is created. Openverse requests share a D1 lease, with at least 3.1 seconds between completions and subsequent starts; upstream quota responses persist their Retry-After cooldown. The anonymous quota can make this source temporarily unavailable while the others continue.

At import, the app re-fetches the exact Openverse record and verifies its native Freesound ID, source page, artist, title, license and publicly shared MP3 URL against the original Freesound page. It imports the high-quality MP3 rendition, explicitly labeled **MP3 preview**, rather than claiming to obtain the original upload. The authenticated original-download endpoint is not used. Downloaded bytes must match the advertised length, audio signature and duration. Both the original source page and index ID are retained in provenance.

**Library of Congress:** search the National Jukebox, but only accept exact item/file IDs listed in the LC Labs published audio manifest. This is the specific 1900–1922 dataset described as public domain by its publisher, not the entire Jukebox collection. Import rechecks manifest membership and current item identity, recording date, repository, country, rights statement and downloadable audio metadata. Only the manifest's pinned `data.labs.loc.gov/jukebox/audio/jukebox-ID_1.mp3` file can be fetched. Its length and actual MP3 duration are verified. Attribution says **Public domain (United States)** and retains the dataset's rights statement, recording date and manifest checksum as evidence.

The dataset serves MP3s and its JSON manifest with `binary/octet-stream`. This MIME exception is limited to those pinned dataset paths; the MP3 parser still verifies the actual audio. General National Jukebox streaming URLs are not substituted. The generic item's streaming-rights flag is not used as the license for the separately published dataset file.

## Boundaries

- Selections contain provider, item ID and file ID only. Client-supplied download URLs are rejected.
- All source hosts and file paths are pinned; redirects cannot switch recordings or hosts. HTTP 403 is terminal.
- The existing 12 MiB source limit, guest/member duration limits, consent, ownership, queue fences and allowance checks remain in force.
- Licenses with NC, ND or SA conditions are not newly enabled. Jamendo is excluded because Openverse does not establish its separate download-permission flag. ccMixter remains disabled under its existing access gate.
- No YouTube parsing or retrieval, mixer feature, OAuth registration, paid provider call or production identity change is part of this update.

## Verification

`cloudflare/audio-catalogs.test.ts` covers strict identity parsing, source-license changes, manifest membership, pinned files, native byte storage, provenance, quota handling and cancellation. `cloudflare/music-audio-flow.spec.mjs` exercises all four providers with 2/4/6 choices through local Workerd/D1/R2 and the browser. Catalog/audio responses and model outputs in that suite are fixtures; it does not establish real model quality.

The explicit opt-in `cloudflare/audio-catalogs.live.ts` uses real catalog responses through the actual application search route and stores real source bytes through the owned import path. It never drains the split queue and refuses outbound calls outside the public source hosts. `cloudflare/audio-search-live.spec.mjs` verifies real provider results through local Workerd and the browser, with fixture identity only and zero job submissions. These checks are separate from paid production acceptance.

## Provider references

- [Openverse authentication and throttling](https://docs.openverse.org/api/reference/authentication_and_throttling.html)
- [Freesound sound and preview fields](https://freesound.org/docs/api/resources_apiv2.html)
- [National Jukebox data package and download manifest](https://data.labs.loc.gov/jukebox/)
- [Dataset rights statement](https://data.labs.loc.gov/jukebox/README.html#rights-statement)
- [Openverse's Jamendo download-permission issue](https://github.com/WordPress/openverse/issues/3499)
