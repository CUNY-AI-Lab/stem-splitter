# YouTube fetcher

YouTube refuses full audio downloads to Cloudflare's network. Probed on 2026-11-08
from a Worker:

- **Player responses:** bot-checked ("Sign in to confirm you're not a bot").
- **Direct iOS-client links:** stop with 403 after the first 1 MiB, because there is
  no proof-of-origin token.
- **Cloudflare's browser:** gets the same bot check.

The same requests succeed from an ordinary home or campus connection. This service
runs yt-dlp on such a machine. The Worker reaches it through a Cloudflare Tunnel and
tries it before its own importers.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install "yt-dlp[default]"
YT_FETCHER_SECRET="$(openssl rand -base64 48)" .venv/bin/python3 -I fetcher.py
cloudflared tunnel --url http://127.0.0.1:8790     # temporary trycloudflare.com address
```

Give the Worker the tunnel address and the same secret as secrets:
`YOUTUBE_FETCHER_URL` (HTTPS) and `YOUTUBE_FETCHER_SECRET` (at least 32 characters).
YouTube search results are listed only when both are set.

A quick tunnel's address changes every time it starts, so it is for Dev testing only.
Production needs an always-on machine and a named tunnel.

## Behaviour

- **Listening:** the service binds to `127.0.0.1` only, and every request needs
  `Authorization: Bearer <secret>`.
- **Request:** `POST /audio` takes `{"videoId", "maxSeconds"}`. `maxSeconds` is 300 for
  guests and 900 for members.
- **Response:** m4a (AAC) or WebM audio up to 12 MiB, with `X-Audio-Title` and
  `X-Audio-Duration`.
- **Final refusals:** too long, live, private, age-restricted, unavailable and too large.
  The Worker does not retry these.
- **Other failures:** a bot check or extractor failure lets the Worker fall back to its
  own importers.
- **Idempotent per video:** a finished download is kept for a week (2 GiB at most, least
  recently used dropped first) and served again without asking YouTube. A request for a
  video that is already downloading waits for that download instead of starting another.
  A final refusal (private, unavailable, live) is remembered for an hour; a bot check is
  not, because it is about the moment, not the video. Cache files are named by a keyed
  hash, so the folder does not list which videos were imported, and each answer carries
  `X-Audio-Sha256` and `X-Fetcher-Cache` (hit or miss).
- **Queue:** at most two downloads run at once. Up to 20 more requests wait in line for
  50 s; beyond that the answer is 429 with `Retry-After`. All waits end before the
  Worker's 60 s, so a download that outlasts the request still finishes and is cached for
  the retry. A failure that is not a refusal gets one more try after 2 s.
- **Search:** `POST /search` takes `{"query"}` and answers up to ten videos (ID, title,
  channel, duration, live) from yt-dlp's YouTube search, in about a second. Results are
  reused for 10 minutes. Searches use their own four slots, so they never wait behind downloads.
- **Logs:** outcomes, cache hits, sizes and timings, never titles, video IDs or search words.
- **Tests:** `python3 -m unittest discover -s youtube-fetcher -p 'test_*.py'` with yt-dlp
  installed. yt-dlp itself is faked; nothing reaches YouTube.

## In the app

Search asks YouTube's own search API from Cloudflare first (3.5 s). From Cloudflare's
network it sometimes does not answer in time, so a failed, slow or empty answer falls back
to the fetcher's `/search` (4.5 s), inside the 9 s every search source gets.

The split pipeline asks the fetcher first. When the fetcher is offline, busy or
bot-checked, Cloudflare's browser gets one try. After that the import waits in the queue
(`youtube_fetcher_waiting`), and the owner's open page tries again after 15 s, 30 s, 1, 2
and 5 minutes, then every 10 minutes, about 39 minutes in all. Then it uses the hosted
importer where that is configured, or fails with no allowance used. Only the fetcher's
refusals (too long, private, live) end an import at once.

Keep yt-dlp current (`pip install -U yt-dlp`). YouTube changes often, and yt-dlp
releases follow within days.
