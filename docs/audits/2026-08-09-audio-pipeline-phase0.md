# Audio pipeline adversarial hardening audit — 2026-08-09

This audit is tied directly to `TODO.md`. It distinguishes implemented local
code from committed, pull-requested, deployed, and live-accepted work. It does
not authorize a release.

## Canonical scope and provenance

- Canonical checkout: `/Users/milwright/Projects/dev/stem-splitter`.
- Branch: `codex/v3.2-audio-pipeline`.
- Implementation base: `9c3120c` (`feat: link footer to instructor console`).
- The reviewed local audio-pipeline implementation is preserved in commit
  `db99864` (`feat: prepare v3.2 audio routing pipeline`). It has not been
  pushed and no pull request contains it.
- GitHub has no open pull request for this branch. PRs 1–5 are merged historical
  work and must not be cited as delivery of this implementation.
- Canonical Railway scope is project
  `f070742b-3375-4cba-9a86-335f39273c88`, production environment
  `b3381640-1e2f-4765-8e15-15baec599ec2`, Node/Railpack service
  `f53a2915-087c-493a-a345-7a1fa73e6588`.
- The repository's current local Railway link points instead at same-named
  legacy project `b9bf3524-a01d-47f6-a104-2472f86bd0f1`, including a workerd
  `web` service. Release commands now use explicit canonical IDs so that local
  link cannot redirect a write.
- No Railway service, variable, deployment, volume, or Cloudflare resource was
  changed during this audit.

## TODO-linked review

| TODO gate | Builder miss or adversarial case | Hardening now present | State |
|---|---|---|---|
| Phase 0 response contract | A service could declare `choice: two` while resolving a six-track model, claim a mismatched degraded fallback, return unversioned detections, or exceed the 45-second budget. | The boundary rejects choice/model contradictions, fallback contradictions, unversioned vocabulary output, invalid/bloated values, and timing drift before a paid job can be routed. | Local tests pass. |
| Phase 0 fixed corpus | Rights and audible instruments were prose-only; the jazz Archive identifier was invalid. | Eleven authorized file fixtures now carry structured coverage, expected instruments, Archive provenance, derivative-safe CC licenses, hashes where available, and verification dates. Three additional electronic controls include an independently authored CC0 recording. A manifest test prevents impossible model/track expectations. | Local manifest gate passes; listening calibration remains. |
| Phase 1 calibration | A broad “four or six is fine” range hid taxonomy failures. The first strict v1 run under-routed jazz to two and over-routed synthwave to six. | Targets partition preferred, accepted, and rejected outcomes. V2 fixed jazz; v3 adds independent electronic controls and raises the six-track evidence threshold without relabeling the original failure acceptable. | Local FFmpeg, real Chrome, and the pinned 8.0.3 amd64 image are 11/11 accepted; native Railway and listening gates remain. |
| Cross-service version drift | Merely requiring a non-floating classifier string allowed a separately deployed analyzer or stale browser to route with an unknown version. | The shared contract pins `autosplit-role-v3` exactly. An analyzer mismatch becomes `analysis_contract_invalid` and uses the frozen fallback; an invalid browser comparison summary is rejected before it can affect paid routing. | Parser and paid-routing fallback tests pass. |
| Phase 2 advisory isolation | An incomplete discovery schema initially broke five core tests and made a valid six-track authoritative result silently fall back to four. Version names alone also allowed model weights or vocabulary content to drift, and an unconstrained HTTPS target could exfiltrate PCM. | Discovery parsing is quarantined from core routing; schema, checkpoint, weight, vocabulary version, and vocabulary content hash are exact pins. The analyzer sends bounded PCM only to loopback/private Railway origins, rejects redirects and malformed tokens, and redacts labels/private pins from student responses. | Contract/client and teacher-auth/redaction E2E pass; CLAP execution, calibration, and Railway service remain open. |
| Browser responsiveness | Correct anti-alias resampling performed roughly 48 filter taps per output sample on the UI thread, risking a multi-second freeze on long tracks; Web Audio decode had no deadline and allocated the complete source. | Authoritative Auto no longer invokes Web Audio. Browser-only/shadow mode checks metadata first, caps sources at 5 minutes and 24 MiB, moves resampling/FFT into the worker, and gives decode and worker phases independent 20-second deadlines. | Real Chrome, policy unit test, and both Auto E2E paths pass. Proxy caps cannot exactly bound exotic multichannel/high-rate decoded PCM, so retiring the shadow decoder remains open. |
| Browser/server window parity | The first browser guard wired no metadata events, so it always timed out; a separate downmix defect analyzed only the first third of sources shorter than 45 seconds while FFmpeg analyzed them in full. | Metadata success/error handlers are attached before loading. The browser now analyzes short sources in full and uses the same three 15-second positions as FFmpeg only when the source exceeds the budget; the flags-off E2E fixture must resolve to its measured two-track result rather than the four-track fallback. | Unit, targeted real-browser, and full flags-off E2E pass. |
| Phase 1B fallback and transport | A degraded analyzer could falsely appear to agree with the browser fallback; a provider ignoring `AbortSignal` could hang job creation; an arbitrary HTTP URL, embedded URL credential, redirect, weak token, or malformed origin could leak the analyzer bearer token or signed source URL. Workerd also refuses to dispatch analyzer subrequests with `redirect: "error"`. | Degraded comparisons are `unavailable`; timeout uses an independent race; endpoint configuration accepts HTTPS plus loopback/private Railway HTTP only and rejects credentials/path/query/fragment; tokens require at least 32 characters; `redirect: "manual"` preserves Workerd compatibility while every 3xx is rejected without following; streamed JSON stops at 64 KiB. | Unit tests, Railway-host config tests, and all three mocked authoritative E2E journeys pass. |
| Phase 1A source authority | Origin allowlisting alone allowed the analyzer token to fetch arbitrary endpoints on the app origin, and accepting the six-hour separator URL would widen analyzer authority beyond its purpose-specific URL. | The service accepts only the exact signed `/api/local-sources/uploads/…` URL shape within the ten-minute issuance window, rejects redirects, bounds declared and streamed bytes, and deletes its private temp directory. | Local service tests pass. |
| Phase 1A decoder | Output-side seeking could decode from the start to reach later windows, consuming the timeout on long inputs. | FFmpeg uses bounded input-side accurate seeks for beginning, middle, and end; probe/decode share one phase deadline and stdout caps. | Real local fixture test passes. |
| Phase 1A readiness | A classifier startup exception rejected the readiness promise and turned `/readyz` into a 500; liveness called the classifier too. | `/healthz` is process-only. Decoder and classifier failures settle to explicit 503 readiness reasons, and analysis stays unavailable. | Local service tests pass. |
| Phase 1A privacy/versioning | Success logs omitted pins and included exact source byte count/duration. | Logs contain schema, classifier and FFmpeg versions plus bounded timing and decision metadata, but no URL, signature, token, raw features, source byte count, or source duration. | Local service tests inspect records. |
| Build/release | The analysis README named a Dockerfile that did not exist; Docker contexts included ignored classroom corpus audio and could include `.dev.vars` variants; a broad FFmpeg build retained unnecessary codecs/formats; the final image copied static libraries, headers, examples, and 33 MB of unused root-project dependencies. | Non-root multi-stage image pins base digests and signature-verified FFmpeg checksum. FFmpeg explicitly disables unused component families and enables only required audio components and file/pipe protocols. Bun bundles the analyzer at build time; the runtime contains one application artifact plus `ffmpeg` and `ffprobe`. `.dockerignore` excludes secrets, corpus audio, caches, and private documents. | Local emulated `linux/amd64` role-v3 image passes runtime surface, readiness/auth, eight-format decode, and 11-source corpus gates. Native CI/Railway and resource gates remain. |
| CI | The authoritative Auto E2E, analysis service, and current pinned image were absent from the GitHub workflow. | CI now runs analysis typecheck/tests, the three-source authoritative Auto suite, and a separate amd64 Docker build that requires FFmpeg 8.0.3, role v3 readiness, a runtime decoder allowlist, a real WAV decode, and a 401 auth boundary. | The latest workflow hardening is local and uncommitted; no GitHub run exists. The gitignored real corpus still requires a separate mounted/live run. |
| Railway configuration | Two projects share the same name, the live canonical service lacks the newly required YouTube fetcher version variable, and variable edits redeploy by default. | Release docs use explicit IDs; the analyzer runbook uses typed Dockerfile configuration, staged service config, and `--skip-deploys` variable batching; `/healthz` reports value-free configuration state without pretending it probed the analyzer. | Read-only audit complete; coordinated variable staging and release remain. |

## Local validation evidence

The final combined local gate after the audit edits passed:

- Shared app TypeScript typecheck: pass.
- Analysis service TypeScript typecheck: pass.
- Worker/unit tests: 80 passed.
- Dedicated analysis service gate: 21 passed, including real local FFmpeg
  decode, source policy, authentication, concurrency, cleanup,
  liveness/readiness, container pin assertions, deterministic browser/server
  PCM parity, and the flag-off discovery contract/client seam. Four parity
  cases are intentionally also exercised by the broad worker glob; do not add
  the two counts as if they were disjoint.
- Railway Node host tests: 5 passed.
- Local separator tests: 5 passed.
- Baseline browser E2E: 19 passed.
- Authoritative Auto E2E: 3 passed across upload, YouTube, Archive, and outage
  fallback.
- Pinned analysis image: local `linux/amd64` build passed as non-root with an
  audio-only runtime surface, FFmpeg `8.0.3`, classifier `autosplit-role-v3`,
  401 missing/wrong-auth boundaries, all eight tested variants of the six
  advertised format families, and the eleven-source corpus at 8 preferred,
  3 accepted alternatives, and 0 rejected.
- Real Chrome 151 decoded and classified all eleven authorized MP3s through the
  browser worker. It agreed with the local FFmpeg 8.1.2 service path on 11/11
  choices; feature values were close but not byte-identical. The repeatable
  `npm run eval:auto:browser` gate also passed after adding decode and worker
  deadlines.
- `git diff --check`: pass.

Docker Desktop remained unavailable after its earlier metadata-store errors,
so an existing stopped Colima VM was started without changing the active Docker
context or its saved configuration. Its registered amd64 emulator provided an
independent local build route. The first broad FFmpeg build reached irrelevant
video/audio filter compilation and crashed under emulation; that failure
exposed the overbroad build surface rather than becoming an accepted flake.

The corrected image compiles the checksum-pinned official FFmpeg 8.0.3 source
with a reproducible single-job default, explicit component-family disables,
and a narrow audio allowlist. A clean two-job QEMU rebuild produced inconsistent
libc `hypot` feature detection, while the serial build is repeatable; native
builders may override parallelism only after their own image gate passes. Runtime
inspection found only AIFF, FLAC, MOV/M4A, MP3, OGG, and WAV demuxers; only
audio decoders; and only file/pipe protocols. The non-root image reported
FFmpeg 8.0.3 and role v3 readiness, rejected missing and incorrect bearer
tokens, decoded WAV, MP3, FLAC, AAC-M4A, ALAC-M4A, Vorbis-OGG, Opus-OGG, and
AIFF, and repeated the eleven-source 8/3/0 corpus result. A final hardening pass
removed installed FFmpeg development artifacts and bundled the application at
build time, leaving only `/app/dist/server.mjs`, `ffmpeg`, and `ffprobe` in the
application-owned paths. The resulting local image is amd64 but emulated; native
GitHub and Railway resource behavior remain unproved. No Docker reset, prune,
cache deletion, or user-data removal was attempted.

The strict real-corpus evaluation used local FFmpeg 8.1.2. Role v1 produced 3
preferred, 3 accepted-alternative, and 2 rejected decisions (jazz-sax to two;
synthwave to six). Role v2 fixed jazz without moving orchestral, producing 4
preferred, 3 alternatives, and 1 rejection. Synthwave still routes to six
because harmonic programmed attacks resemble evidence for guitar/piano-trained
channels. Role v3 added three authorized electronic controls, including an
independent CC0 house/electro source, and raised the six-track evidence
threshold. It produced 8 preferred, 3 accepted-alternative, and 0 rejected
decisions across eleven sources. Chrome, local FFmpeg 8.1.2, and the pinned
FFmpeg 8.0.3 amd64 image agreed on all choices, but the narrow synth boundary,
manual listening, native CI, and Railway gates remain. The exact trace is in
`docs/model-processing-changelog.md` and
`docs/evaluation/autosplit-role-v3-candidate.md`.

## Live state and unresolved acceptance

Read-only Railway inspection found the canonical deployment healthy at the
pre-pipeline commit: `/healthz` returned `ok: true` and `promptSchema: ready`,
and the live separation catalogue remained the frozen 2/4/6 baseline. That is
baseline evidence only; it does not prove the local v3.2 commit.

The canonical service has `REPLICATE_YT_MODEL` but not
`REPLICATE_YT_MODEL_VERSION`. Deploying the current branch before staging the
exact version would intentionally disable the Replicate YouTube fallback. The
new Auto/analyzer flags and credentials are also absent, as expected while the
feature remains off.

The teacher console still needs its authorized human acceptance: save one
revision with a real teacher account, restart the canonical Railway service,
and prove the prompt revision persists. Do not retrieve the credential to
automate this check.

## Mandatory next order

1. Preserve the reviewed local commit; do not push or open a pull request until
   the current-image gate and final release scope are reviewed.
2. Reproduce the locally passing role-v3 image, runtime allowlist, readiness,
   authentication, and corpus evidence on native CI/amd64; then validate actual
   Railway CPU, memory, FFmpeg child-process, concurrency, and disk limits.
3. Capture the rollback baseline with one authorized real-audio four-track job,
   provider pin, hashes, and latency.
4. Stage the exact YouTube fetcher version against the canonical service as one
   coordinated release input; do not trigger a standalone redeploy.
5. Provision `audio-analysis` as a private Railway CPU service with explicit
   memory/CPU/restart/disk limits, no shared volume, no public domain, and Auto
   still off.
6. Verify analyzer readiness, then enable **shadow** only. Calibrate the fixed
   manifest and investigate browser/server disagreement by genre.
7. Run upload, YouTube, Archive, timeout, outage, restart, and rollback journeys
   on Railway. Complete the separate teacher persistence acceptance.
8. Only after those gates may authoritative Auto be considered. Instrument
   discovery and optional separation remain later phases and cannot rename or
   reroute the frozen core stem contracts.
