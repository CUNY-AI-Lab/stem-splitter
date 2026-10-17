# Playlist search suggestions

The source is all 83 tracks in all six [Cooper Hewitt Sound Station playlists](https://www.cooperhewitt.org/art-of-noise-resources/sound-station-playlists/), transcribed in `sound-station-source-playlists.json`. `public/search-samples.json` contains matched Archive recordings. Unmatched, restricted or unavailable recordings never become hints. Every hint still passes exact artist/title, item, MP3 filename and bounded audio-delivery verification at runtime.

Suggestions start when the empty search field is visible, independently of account setup. Three concurrent lookups let the first verified song appear immediately. The entire shuffled candidate catalog continues loading lazily, with a seven-second pause between each worker's subsequent checks to stay below the public endpoint's rate limit. There is no four-song cutoff. Ready names rotate without repeating until the ready pool has been traversed; later arrivals join the same rotation.

Each complete name holds for **3.5 seconds after typing finishes**. Typing and pasted links take precedence. Reduced-motion users see a static verified suggestion. Tab or touch uses already loaded results without another lookup. Browser hints expire after ten minutes, allowing a full large rotation; positive server checks cache for sixty seconds. Imports always revalidate the source and the caller's duration limits.

Only exact allowlisted playlist candidate GET requests are public, with rate limiting. Ordinary search, account reads and imports retain their access checks. Suggestion verification checks public Archive availability independently of account split-duration limits. It does not expand import permissions or limits. Background suggestions never start audio playback or separation.

The standalone Sound Stations page and link remain removed; retired page and assets return HTTP 410.
