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
- **Load and logs:** at most two downloads run at once. The log records outcomes, sizes
  and timings, never titles or video IDs.

Keep yt-dlp current (`pip install -U yt-dlp`). YouTube changes often, and yt-dlp
releases follow within days.
