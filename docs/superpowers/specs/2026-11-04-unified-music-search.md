# Unified music discovery

One song field searches Internet Archive and Wikimedia Commons. Each selectable
file keeps its source identity, recording credit, duration and existing import
eligibility. Results stream independently so an unavailable provider does not
hide another provider's files. The old provider-specific API parameters remain
compatible; ccMixter stays disabled because its canonical downloads returned
403 (see `docs/open-audio-providers-20261025.md`).

MusicBrainz, a MetaBrainz project, supplies recording metadata behind the same
audio workflow. When direct repository searches find no audio, up to two recording
references and two linked Archive/Commons pages are resolved through the existing
source adapters within an 18-second, cancellable budget. Exact file links retain
their full source path; missing files cannot substitute another item track.
Item-level Archive references use the existing artist/title matching rules.
Commons references must resolve to the same file page. Source rights, duration,
size and byte checks still apply; a catalog relationship grants no import rights.
The result list contains eligible audio files only, using the existing Fetch and
2/4/6-stem controls. No separate metadata panel or related-page button appears.
Source IDs remain authoritative; files are never collapsed or assigned recording
MBIDs on the basis of title similarity. No mixer changes are included.

Public MusicBrainz reads use no OAuth, API key or callback. Requests identify
Stem Splitter, use literal search terms, bound response size and time, and hold
one shared D1 lease through each request with a further 1.1-second cooldown.
Rate-limit responses establish a durable cooldown; cached public metadata can be
reused for one hour. Audio results do not depend on MusicBrainz availability.

Instructor-selected sample playlists retain their exact Archive item/file
verification and existing settings. Personal/course ownership, explicit sharing
consent, successful-split quotas, 90-day production retention, download names and
resplit source bytes retain their existing contracts. YouTube parsing/retrieval,
Auto recognition, instrument extraction and Listening Guy audio input are outside
this change.

Sources checked November 4, 2026:

- https://musicbrainz.org/doc/MusicBrainz_API
- https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
- https://musicbrainz.org/doc/Recording
- https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia
