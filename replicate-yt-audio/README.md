# yt-audio — Replicate fetch model

Tiny CPU model (yt-dlp + ffmpeg) that turns a YouTube URL into an M4A audio
file plus title/duration. Deployed as **cali-tlc/yt-audio** (private — the
owner must match the account of the `REPLICATE_API_TOKEN` in use, or every
prediction start 422s with "version does not exist or not permitted") and
used by the app as the primary fetcher; YouTube bot-checks the in-app
`youtubei.js` attempt from all datacenter egress IPs.

- Inputs: `url` (YouTube link), `max_duration` (seconds, default 900)
- Output: `{ audio: file, title: string, duration: float }`
- Errors are raised as `ValueError` with student-readable messages; the
  Worker surfaces prediction errors verbatim.

## Update / redeploy

```sh
brew install cog          # once
cog login                 # once, interactive — the account owning REPLICATE_API_TOKEN
cd replicate-yt-audio
SMOKE_YOUTUBE_URL='<video-url-you-are-allowed-to-test>'
cog predict -i url="$SMOKE_YOUTUBE_URL"   # local smoke test (needs Docker)
cog push r8.im/cali-tlc/yt-audio
```

Rebuild and push whenever imports start failing even with a valid pin:
`cog.yaml` deliberately does not pin `yt-dlp`, so a fresh build picks up the
latest extractor fixes — stale yt-dlp is the usual reason YouTube starts
bot-blocking a previously working deployment.

After a push, retrieve the new version id, run the authorized import canary, and
then update `REPLICATE_YT_MODEL_VERSION` on Railway. A push does not take effect
automatically. The app sends that exact version to Replicate and rejects the
floating value `latest`. `REPLICATE_YT_MODEL` still records the owner/name; unset
either variable to disable the fallback without making app startup fail.

If YouTube starts bot-checking Replicate's IPs too, the next escape hatch is
passing a logged-in session cookie to yt-dlp (`--cookies`); use a throwaway
Google account for that, not a personal one.
