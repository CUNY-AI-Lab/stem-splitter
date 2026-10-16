# Sound Stations

The listening page at `/sound-stations.html` contains only selections from the user-supplied Art of Noise exhibition playlists that matched Internet Archive artist, song title, and album metadata on 2026-10-16. General song search remains available independently. No cover, tribute, remix, or different concert performance is substituted into the curated list.

Discovery checked 83 requested tracks and inspected 507 Archive items. Eleven selections passed the initial strict match review and public MP3 delivery probes. This is a verified subset, not an exhaustive claim that other recordings are unavailable. The source manifest is `public/sound-stations.json`; every entry retains the exact Archive item and filename. Metadata matching establishes the source's recorded credits; it is not independent authentication of the recording.

The page streams complete files directly from Archive, starts only after a user selects a song, uses a single audio player, and advances within the selected playlist. Sources remain linked individually. Media permission for Archive and its delivery subdomains is limited to this page, including its extensionless asset URL. Other pages retain their existing content security policy. This listening page does not start a split or consume split allowance.

## Verified selections

- teenage engineering: Yellow Magic Orchestra — Behind the Mask; Goblin — Suspiria.
- Rocky Bucano, Hip Hop Origins: Babe Ruth — The Mexican.
- Deborah Gordon, Village Vanguard Jazz Sessions: Sonny Rollins — Woody 'N You; Sonny Rollins — Sonnymoon for Two; John Coltrane — Softly as in a Morning Sunrise.
- David Byrne, How Music Works: D'Angelo — Send It On; Willie Nelson — Stardust; Jorge Ben — Ponta de Lança Africano; Al Green — Love and Happiness; KC and the Sunshine Band — Get Down Tonight.

No selections from the Early Disco or Izzy Sanabria Salsa lists passed this initial artist/title/album match review. They have not been filled with approximate results.

## Local verification

All eleven selected recordings decoded and advanced playback in Chrome against the local Worker fixture while streaming directly from Internet Archive. Desktop (1280px) and mobile (390px) layouts had no horizontal overflow. This checks actual playback starts; it does not claim an uninterrupted end-to-end listen to every recording.

The related account disclosure spacing was checked at the same widths. Signed local student identities show Student access, hide teacher and admin controls, receive a 900-second import limit, and are denied teacher routes. YouTube metadata boundary tests accept 900 seconds and reject 900.01 seconds; Archive metadata and complete MPEG-frame checks enforce 300/900 seconds, including cache separation. A ten-minute Archive fixture imports and reloads from cache for a student, while a forged instructor field cannot grant a visitor access. Audio byte-size limits still apply independently.

Final local checks: 236 Cloudflare tests; 383 shared tests; root, Cloudflare, and server TypeScript checks. A real student SSO account was not used: the user selected local student tests for this verification. No deployment is implied by these results.
