# Playlist search suggestions

The search placeholder draws candidates randomly from `public/search-samples.json`, using only playlist recordings that pass exact Internet Archive artist/title, item, MP3 filename and bounded audio-delivery verification.

Suggestions start when the search field is visible, independently of account setup. Three concurrent lookups let the first verified song appear immediately; remaining candidates load lazily until four ready songs or the shared fifteen-second deadline. Ready names rotate through the placeholder. Typing and pasted links take precedence; reduced-motion users see a static verified suggestion. Tab or touch uses already loaded results without another lookup. Expired hints refresh after sixty seconds.

Only exact allowlisted playlist candidate GET requests are public, with rate limiting. Ordinary search, account reads and imports retain their access checks. The public sample path preserves the five-minute public source limit and caches only verified public metadata for sixty seconds; concurrent requests share verification work. Imports revalidate their own source and account policy. Background suggestions never start audio playback or separation.

The standalone Sound Stations page and link remain removed; retired page and assets return HTTP 410.
