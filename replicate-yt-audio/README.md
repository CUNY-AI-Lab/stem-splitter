# yt-audio — pinned permitted-source importer

This directory maintains the source of the private Replicate audio-import
model. Changing it does **not** change the deployed model version selected by
`REPLICATE_YT_MODEL_VERSION`. No image was published or paid canary run for this
PR. An approved image build, exact new version pin and permitted-source canary
remain release gates.

The image pins `yt-dlp[default,pin]==2026.8.19`, matching
`yt-dlp-ejs==0.8.0`, and the extractor's pinned supported Deno `2.9.5` runtime.
These pins were checked against their public package metadata on 2026-10-06.
The system ffmpeg package must also be recorded in the eventual image digest.
The previous model image is not evidence that the updated JS/EJS runtime runs.

Only supported YouTube video URLs enter yt-dlp. Authentication, age, region,
DRM, removed/private video and challenge restrictions stop the request. There
is no cookie injection, logged-in browser impersonation, proxy rotation,
mobile-client rotation or challenge bypass. The app offers an original or
licensed upload, the user's own Studio/Takeout download, and authorized Archive
sources when importing is unavailable. A valid URL is not a promise of access.

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

The tests use a Cog shim and synthetic subprocesses, not YouTube or Replicate.
They cover URL restrictions, dependencies, timeout/process termination,
metadata-only failure, invalid media, disk failure, concurrent paths and
restart cleanup. They do not validate a published image, account entitlement,
or live source availability. See [the operations runbook](../docs/reliability-operations.md).
