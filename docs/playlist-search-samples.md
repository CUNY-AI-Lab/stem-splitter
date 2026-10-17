# Playlist search suggestions

The animated song-search placeholder draws candidates at random from `public/search-samples.json`, a subset of the supplied exhibition playlists with previously matched Internet Archive item/file identities. That manifest supplies candidates, not current availability evidence.

On each visit, the app shuffles candidates and checks up to three through the authenticated live Archive song search, within a single 15-second background deadline. A candidate appears only after the search verifies the exact Archive item and MP3 filename; unrelated recordings are excluded. If nothing is verified, the ordinary placeholder stays visible. No sign-in prompt, audio playback or separation starts in the background.

Tab or tapping the hint accepts the verified artist/title query and reveals the cached matching song. Manual song search remains independent. The old Sound Stations page, link, script and playlist document are removed, and their old URLs return HTTP 410.
