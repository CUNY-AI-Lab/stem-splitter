# yt-audio — pinned permitted-source importer

This directory maintains the shared YouTube/Vimeo audio importer published as
`cali-thinkering/yt-audio`. The existing `REPLICATE_YT_MODEL` and
`REPLICATE_YT_MODEL_VERSION` settings retain their names for configuration
compatibility. Source edits take effect after image publication, exact-version
verification, a successful source canary, and deployment of the new pin.

The image pins `yt-dlp[default,pin]==2026.8.19`, matching
`yt-dlp-ejs==0.8.0`, and the extractor's pinned supported Deno `2.9.5` runtime.
These pins were checked against their public package metadata on 2026-10-06.
The system ffmpeg package must also be recorded in the eventual image digest.
The previous model image is not evidence that the updated JS/EJS runtime runs.

The importer accepts individual YouTube and Vimeo links on exact supported
hosts. Vimeo page and player links normalize to the same video ID; an unlisted
hash is preserved when supplied. Vimeo extraction uses its public player,
which supplies playback metadata without the account-only API fallback used
by the pinned library for ordinary Vimeo pages. The player remains responsible
for enforcing visibility, password and media restrictions.

Authentication, age, region, DRM, removed/private video and challenge
restrictions stop the request. Each source uses one fixed extraction path.

Each prediction has a unique output directory, a 230-second total deadline,
a 90-second subprocess ceiling and zero nested yt-dlp retries. Timeout or
cancellation kills the subprocess group, including ffmpeg children. Audio is
limited to 100 MiB and 15 minutes, probed for an audio stream, then fully decoded
with ffmpeg before returning success. Metadata success alone is insufficient.
Failed/cancelled requests remove their temporary directory immediately.
Successful output must remain until Cog uploads the returned `Path`; it is
swept after one hour on setup or the next request. A terminated container's
filesystem remains governed by the provider's container lifecycle. Stdout and
stderr are captured on disk, bounded when read, and never sent to students.

Run the free fault fixtures with:

```sh
python3 -m unittest discover -s replicate-yt-audio -p 'test_*.py'
```

The tests use a Cog shim and synthetic subprocesses, without platform or Replicate requests.
They cover URL restrictions, dependencies, timeout/process termination,
metadata-only failure, invalid media, disk failure, concurrent paths and
restart cleanup. They do not validate a published image, account entitlement,
or live source availability. See [the operations runbook](../docs/reliability-operations.md).
