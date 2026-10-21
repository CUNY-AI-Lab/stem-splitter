# v3.2 native-amd64 analysis-image acceptance

This directory records native Linux amd64 evidence for the exact role-v4,
source-scope-v2 analysis image. `evidence.json` was captured by the successful
native `analysis-image` job in GitHub Actions run `39631116325` for source
`4bbbbdd22f7321a9b0e55c2968b065e6c2402550`.

The artifact `audio-analysis-native-amd64-4bbbbdd22f7321a9b0e55c2968b065e6c2402550`
(GitHub artifact ID `12358913146`) was downloaded unchanged. The artifact archive
SHA-256 is `8968909bb8083cee13892f7366e07070e6cc396af20d1cfc273724c617e2f04b`;
the extracted `evidence.json` SHA-256 is
`876a31aa84f13dd94f9853b5592e53f5a2c179ccb897bf742d9d29f61efe289a`.
Its source hashes match this checkout. The image job succeeded after a native
Linux amd64 build and constrained smoke. The source job correctly rejected the
stale native evidence before this import; the YAMNet and EfficientAT receipts
remain separate gates. Full hosted source acceptance is a separate check on the
import commit.

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

The committed JSON is the downloaded commit-named artifact only. The image,
runtime logs, credentials, and audio remain outside Git.

The same reviewed change sets `nativeAmd64Image` to `true`, removes
`native-amd64-image-missing`, and run:

```sh
bun run check:audio-pipeline -- --require-action provision-audio-analysis
```

The promotion loader independently revalidates the canonical artifact against
the current repository inputs. A fabricated boolean, stale source hash,
emulated arm64 run, wrong GitHub repository/job, floating pin, oversized image,
failed smoke claim, or dirty source capture cannot clear the gate. Railway
resource and restart acceptance remain separate post-provision evidence.
