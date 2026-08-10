# v3.2 native-amd64 analysis-image acceptance

This directory records native Linux amd64 evidence for the exact role-v4,
source-scope-v2 analysis image. No `evidence.json` is committed yet because the
local v3.2 branch has not run on GitHub infrastructure.

The `analysis-image` CI job:

1. checks out the exact pull-request head or push commit;
2. proves the runner and Docker daemon are Linux x86_64;
3. builds the current Dockerfile with `--pull --platform linux/amd64`;
4. runs the constrained image smoke with the same expected platform;
5. verifies the non-root command, image-size ceiling, Node/Bun/FFmpeg,
   classifier and source-scope pins, and all smoke claims;
6. binds every Docker build input, fixture, smoke script, capture script,
   workflow, dependency lock, and TypeScript configuration by SHA-256; and
7. uploads `audio-analysis-native-amd64-<commit>` for 30 days using the
   digest-pinned official upload action.

After publication is separately authorized and the native job passes, download
the artifact from that exact workflow run. Inspect its run, commit, platform,
image ID and source hashes, then add only the JSON as
`docs/acceptance/2026-08-10-v3.2-native-amd64-image/evidence.json`. Do not add
the image, runtime logs, credentials, or audio.

In the same reviewed change, set `nativeAmd64Image` to `true`, remove
`native-amd64-image-missing`, and run:

```sh
bun run check:audio-pipeline -- --require-action provision-audio-analysis
```

The promotion loader independently revalidates the canonical artifact against
the current repository inputs. A fabricated boolean, stale source hash,
emulated arm64 run, wrong GitHub repository/job, floating pin, oversized image,
failed smoke claim, or dirty source capture cannot clear the gate. Railway
resource and restart acceptance remain separate post-provision evidence.
