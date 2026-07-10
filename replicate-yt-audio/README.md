# yt-audio — Replicate fetch model

Tiny CPU model (yt-dlp + ffmpeg) that turns a YouTube URL into an M4A audio
file plus title/duration. Deployed as **smorello87/yt-audio** (private) and
used by the Worker as the fallback fetcher when YouTube bot-checks the
in-Worker `youtubei.js` attempt (which it does for all Cloudflare egress IPs).

- Inputs: `url` (YouTube link), `max_duration` (seconds, default 900)
- Output: `{ audio: file, title: string, duration: float }`
- Errors are raised as `ValueError` with student-readable messages; the
  Worker surfaces prediction errors verbatim.

## Update / redeploy

```sh
brew install cog          # once
cog login                 # once, interactive — Replicate account smorello87
cd replicate-yt-audio
cog predict -i url='https://www.youtube.com/watch?v=jNQXAC9IVRw'   # local smoke test (needs Docker)
cog push r8.im/smorello87/yt-audio
```

The Worker resolves the model's **latest version** at request time
(`GET /v1/models/smorello87/yt-audio`), so a push takes effect immediately —
no version hash to pin. The model name comes from the `REPLICATE_YT_MODEL`
var in `wrangler.jsonc`; unset it to disable the fallback.

If YouTube starts bot-checking Replicate's IPs too, the next escape hatch is
passing a logged-in session cookie to yt-dlp (`--cookies`); use a throwaway
Google account for that, not a personal one.
