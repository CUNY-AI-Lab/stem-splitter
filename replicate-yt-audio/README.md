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
SMOKE_YOUTUBE_URL='<video-url-you-are-allowed-to-test>'
cog predict -i url="$SMOKE_YOUTUBE_URL"   # local smoke test (needs Docker)
cog push r8.im/smorello87/yt-audio
```

After a push, retrieve the new version id, run the authorized import canary, and
then update `REPLICATE_YT_MODEL_VERSION` on Railway. A push does not take effect
automatically. The app sends that exact version to Replicate and rejects the
floating value `latest`. `REPLICATE_YT_MODEL` still records the owner/name; unset
either variable to disable the fallback without making app startup fail.

If YouTube starts bot-checking Replicate's IPs too, the next escape hatch is
passing a logged-in session cookie to yt-dlp (`--cookies`); use a throwaway
Google account for that, not a personal one.
