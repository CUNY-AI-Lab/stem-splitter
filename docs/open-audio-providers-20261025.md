# Open audio source integration — October 25, 2026

Commons release candidate; Internet Archive remains the default. ccMixter is hidden
from the selector and rejected by search/submission entry points with503. Its
internal adapter and three failed receipts remain available for future review,
without another download attempt.
Commons and ccMixter share the existing selection/import path. Client selections
contain only provider/item/file IDs. Imports resolve recording metadata afresh,
require CC BY, CC0 or verified public-domain recording metadata, and reject NC,
ND, SA, ambiguous rights, remix chains and unsupported media. Composition age is
not used as permission. Initial search favors MP3; native validation supports
MP3/WAV/FLAC with matching MIME, bytes and duration (12 MiB, guest5min/member15min).

Requests use pinned public/keyless API/download hosts, manual conservative
redirects, no credentials, bounded 15s metadata/60s audio/90s import deadlines,
one shared D1 request slot/second/provider and at most one 429/503 GET retry.
Retry-After is a floor; long cooldowns fail safely instead of retrying early.
403 is terminal. This is not an arbitrary-URL proxy. Existing quotas, private
source storage, current course authority and paid-start fences remain in place.

Provenance persists with the recording and appears in its console, public
listening, session Markdown and ZIP attribution JSON. Public responses expose
only recording-credit fields. Authoritative Auto reuses the already hashed,
immutable imported source rather than taking a second upload snapshot.

## Six actual application source-import attempts

Raw receipts: [six-run JSON](evidence/open-audio-six-runs-20261025.json).
These call the actual submitSplit -> resumeOwnedSourceImport -> native adapter ->
fenced FsR2/SQLite commit path with a synthetic local member. They stop at queued
split. They do not claim HTTP-browser submission or paid end-to-end separation.
Synthetic browser/API checks exercise selection and request wiring separately.

| Provider/item | Music recording | Outcome | Bytes | MIME | Elapsed |
|---|---|---|---:|---|---:|
| Commons64734368 | Exit the Premises | imported; FFmpeg decode0 |6724725|audio/mpeg|1751ms|
| Commons64736120 | Hitman | imported; FFmpeg decode0 |8035387|audio/mpeg|2127ms|
| Commons64739672 | Merry Go | imported; FFmpeg decode0 |4821076|audio/mpeg|1501ms|
| ccMixter5847/file5176 | Body banging Inst | audio GET403, terminal |0|text/html refusal|1389ms|
| ccMixter5843/file5172 | Mystro Soul Instumental | audio GET403, terminal |0|text/html refusal|1954ms|
| ccMixter5734/file5060 | After Winter Dreams | audio GET403, terminal |0|text/html refusal|1990ms|

All three Commons recordings: Kevin MacLeod, CC BY3.0, recording-level source,
creator, required credit, license URL and rights evidence persisted/read back.
Stored SHA-256 matched bytes and FFmpeg7.1 decoded each complete file without
errors. ccMixter's public metadata/license check succeeded (CC BY2.5), but each
canonical audio URL returned403. No audio persisted and no retry was made; the
three failures remain in the denominator. The reason for the remote refusal is
unknown. No referrer spoofing, protected-page scraping or alternate download
bypass was attempted. ccMixter is disabled pending provider-supported
public download access. Three Commons successes do not establish production
reliability or parity with Archive.

No participant records, live writes, account creation, paid model/split calls or
new credentials were used. Six attempts occurred before review fixes to public
credits, malformed-provider validation and authoritative Auto; those fixes use
synthetic regression coverage and do not convert failed imports into successes.
The real runner is opt-in: STEM_REAL_OPEN_AUDIO=1 node --import tsx
scripts/verify-open-audio-imports.mts. Do not rerun denied ccMixter downloads
without materially new relevant evidence; preserve original receipts.

## Documentation checked against live public metadata

- https://www.mediawiki.org/wiki/API:Imageinfo
- https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia
- https://ccmixter.org/query-api
- https://ccmixter.org/about/attributionGenerator

Commons uses Action API imageinfo size/mime/mediatype/extmetadata and original
upload URLs. ccMixter uses /api/query?f=json, lic=by, reqtags=original and ids for
fresh selection resolution. Its valid JSON currently arrives as text/plain.
No Jamendo, new account, API key or agreement acceptance is included.
