# Self-hosted GPU separation with Replicate failover

Run the 4- and 6-track Demucs splits on a dedicated Legion laptop (RTX 5090
laptop GPU, 24 GB, Ubuntu 24.04) reached through a Cloudflare Tunnel, with
Replicate as an automatic fallback. Railway stays the host; the Cloudflare
Workers migration is out of scope.

`SEPARATION_BACKEND=failover` composes the existing `audio-separator` backend
with `replicate`. A split goes to the self-hosted service when the catalogue
has an Audio Separator runner for the choice and the `AUDIO_SEPARATOR_*` pair
is configured (HTTPS with a token of at least 32 characters off loopback); an
`http://` or weak pair is never tried, because every start carries the token
and a signed source URL. Any start failure, including a 10-second timeout, a
tunnel 502 or 530, a 503 from a full or draining queue, or a 401, sends the
same request to Replicate and logs a secret-free reason. The failover catalogue,
including the `backend` name in `/api/separation-options`, is Replicate's, so
the picker, Auto routing, stored jobs and the frozen listening baseline do not
change at the flip. The 2-track split has no self-hosted runner and stays on
Replicate.

`jobs.external_id` stores the accepting provider as an `as:` or `rep:` prefix.
Only `start()` uses the configured backend. Polls and webhooks route by the
stored prefix (`getJobBackend`); unprefixed ids keep their pre-failover meaning,
and under failover an unprefixed UUID is a self-hosted job while anything else
is a Replicate prediction. Jobs therefore finish where they began across a flip
and a rollback. A webhook counts only when its `id` equals the stored provider
id; a late self-hosted webhook for a job that fell back to Replicate is
acknowledged and ignored. Webhook URLs carry a per-job HMAC token instead of
`WEBHOOK_SECRET`, which also signs source URLs; the route still accepts the raw
secret for URLs issued before this change.

Two rules end stuck jobs. The service answers an unknown job with exactly
`{"error":"job not found"}`, and the app fails the job on that body alone, so a
service restart surfaces on the next poll; other 404s and 5xx keep polling.
`SEPARATION_STALL_MINUTES` (default 60, 0 disables) fails a pending or
processing row past that age only when the poll got no answer from its
provider. A provider that reports the job as running is never overruled, and
ingesting rows are never touched.

The service keeps jobs in memory and gains housekeeping instead of persistence:
it deletes the source when a split finishes, sweeps finished job folders after
`AUDIO_SEPARATOR_RETENTION_HOURS` (default 24), purges UUID job folders at
startup once it owns the port, caps pending jobs when
`AUDIO_SEPARATOR_MAX_PENDING` is set, honours a `DRAIN` file, and retries
webhooks three times without following redirects. Demucs runs with the pinned
Replicate inputs (shifts 1, overlap 0.25) and a 0.99 peak limit to match Demucs
`rescale`. It refuses a missing, default or short token whenever it is exposed,
which the GPU host's unit declares with `AUDIO_SEPARATOR_EXPOSED=1`; that also
requires an `https://` public URL. A CUDA device that cannot run a kernel stops
startup, and a CUDA fault during a split fails that job, stops admission and
exits so systemd re-probes the GPU while new starts fall back to Replicate.
These checks change the CPU Docker image too: bound to `0.0.0.0` it now needs
a strong token.

The CUDA environment is a sibling uv project (`local-separator/cuda`) pinned to
torch 2.13.0 from the cu130 index, because only cu130 and newer wheels carry
sm_120 kernels. Every other package is constrained to its version in the CPU
lock, and a test fails on drift. The CPU project, its lock and CI are
unchanged. `/healthz.configuration` adds value-free `separationBackend`,
`audioSeparator` and `replicateSeparation` states.

Acceptance runs on a Railway staging environment pointed at the Legion before
production changes; the checklist and runbook are in `docs/legion-separator.md`.
