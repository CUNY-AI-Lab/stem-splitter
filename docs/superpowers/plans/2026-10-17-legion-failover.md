# Legion failover plan

1. Harden `local-separator/service.py`: pinned Demucs parameters, source
   deletion, retention sweep and startup purge, opt-in pending cap and drain
   file, webhook retries off the inference thread, value-free `/health`,
   fail-closed token and CUDA checks. Add the `local-separator/cuda` project and
   service tests.
2. Add `failover` (`src/separation/failover.ts`), prefix routing
   (`getJobBackend`), the webhook id guard, the catalogue alias, the lost-job
   404 rule, fetch timeouts, the stall deadline and the `/healthz` separation
   states, with unit and server tests. Keep the existing mocked browser suite
   unchanged and green.
3. Commit the GPU-host runbook, systemd unit and environment template. Create
   the CUDA lock on the Legion and add its `uv lock --check` to CI.
4. Bring up the Legion and its tunnel, then run the staging acceptance
   checklist in `docs/legion-separator.md` against a Railway `staging`
   environment with `SEPARATION_STALL_MINUTES=5`.
5. Release the same SHA to production unchanged, then flip production to
   `failover`. Roll back with `SEPARATION_BACKEND=replicate`.
