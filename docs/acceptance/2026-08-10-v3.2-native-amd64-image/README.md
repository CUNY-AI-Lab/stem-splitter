# v3.2 native-amd64 analysis-image acceptance

This directory records native Linux amd64 evidence for the exact role-v4,
source-scope-v2 analysis image. `evidence.json` was captured by the successful
native `analysis-image` job in GitHub Actions run
[`40039301021`](https://github.com/CUNY-AI-Lab/stem-splitter/actions/runs/40039301021)
for commit `093a6bac611f84b5c53d44bc8e90f6a04235fe34`. This refresh records the
CI selection policy added on October 23; the image retains the same runtime
inputs and native smoke contract.

The `analysis-image` CI job:

1. checks out the exact pull-request head or push commit;
2. proves the runner and Docker daemon are Linux x86_64;
3. builds the current Dockerfile with `--pull --platform linux/amd64`;
4. runs the constrained image smoke with the same expected platform;
5. verifies the non-root command, image-size ceiling, Node/Bun/FFmpeg,
   classifier and source-scope pins, and all smoke claims;
6. binds every Docker build input, fixture, smoke script, capture script,
   workflow and selection helpers, dependency lock, and TypeScript
   configuration by SHA-256; and
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
