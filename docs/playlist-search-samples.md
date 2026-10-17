# Instructor-controlled search examples

The supplied source is all 83 tracks in the six [Cooper Hewitt Sound Station playlists](https://www.cooperhewitt.org/art-of-noise-resources/sound-station-playlists/), transcribed in `sound-station-source-playlists.json`. The verified catalog in `public/search-samples.json` now includes 25 matched Archive recordings. Canonical file credits identify Bill Evans' trio recording of “My Foolish Heart” as Bill Evans. Only full recordings of five minutes or less are eligible for public search examples.

## Instructor resource

The existing instructor console adds a streamed Internet Archive search-and-select picker, selected cards with mouse/touch drag handles, move buttons and keyboard arrows, musical styles, enable/pause, minimum full-name hold and seconds-per-song cadence. It has no URL-entry field. Ready search results appear before slower Archive checks finish. New selections require server-side exact artist/title/file and audio-delivery verification before saving. Reordering verified selections works during an Archive outage.

Migration `0026` seeds a durable six-song configuration: jazz (Bill Evans, “My Foolish Heart”), electronic (Yellow Magic Orchestra, “Behind the Mask”), country (Willie Nelson, “Stardust”), funk (Jorge Ben, “Ponta de Lança Africano”), rock (David Bowie, “Sound and Vision”), and folk (Simon & Garfunkel, “The Sound of Silence”). Every seed passed a complete public-policy import and MP3 validation; that is not a claim that a paid separation completed. The console separately displays actual successful split counts from completed jobs matching exact Archive attribution, without exposing student/job identities.

`GET/PUT /api/teacher/song-samples` use existing instructor/admin authorization and write-origin checks. D1 stores the ordered configuration, optimistic revision and immutable revision history. A stale editor receives 409. Public `GET /api/song-samples` exposes only enabled song metadata and display settings, with a content-derived version/ETag. `/search-samples.json` preserves the array response for older clients while reading the same saved selection. Public source verification accepts only currently enabled exact selections; ordinary search remains protected.

## Frontend rotation

Default cadence is six seconds per song, with at least 3.5 seconds fully displayed. Typing spans a fixed 0.6 seconds so title length does not change the cadence. Instructors may set the full-name minimum to three seconds or longer and cadence to at least 0.6 seconds beyond that minimum. Reduced-motion users keep a static verified suggestion.

Verification starts independently of account setup. Three workers let the first ready song appear quickly; remaining selected recordings load lazily with seven-second pauses per worker. There is no four-song cutoff. Selected order establishes priority during the first pass among ready verified songs. No song repeats until the ready pool has been traversed and pending checks settle. Optional reshuffling changes each later pass and avoids a repeated song at the boundary. Public rotation progress persists across reloads; hidden pages pause and resume verification. Typing takes precedence.

Open, empty search fields refresh instructor settings every thirty seconds and on returning to the page. Positive server availability checks cache for sixty seconds. Browser results remain reusable for ten minutes so a larger configured pool can complete its rotation; expired results and failed checks are retried. Tab/touch acceptance reuses ready results immediately. Every actual import independently validates current identity, duration, complete bytes and source policy. Background suggestions never start playback or separation.

The standalone Sound Stations page and link remain removed; retired page/assets return HTTP 410.
