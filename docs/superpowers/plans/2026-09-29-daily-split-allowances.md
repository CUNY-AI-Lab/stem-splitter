# Daily split allowance implementation

- [x] Inspect current Admission, SSO, ownership, split reservations and shared
  Gateway accounting before changing access.
- [x] Extract atomic signed-in reservation policy, increase to ten and remove
  only the shared split-count ceiling.
- [x] Report private per-person count and local reset time in My account;
  distinguish an unavailable count from an unused allowance.
- [x] Add concurrent-request, cross-person (>20 total), UTC rollover, retained
  legacy guide guard and fail-closed storage regression tests.
- [x] Record passing local Workerd and browser checks: 27 backend tests, seven
  desktop/mobile scenarios, Cloudflare/shared/server typechecks and unchanged
  frozen audio-pipeline gate. No production or paid-provider acceptance implied.
  Shared regression suites also pass: 320 Worker tests and 42 server tests.
- [x] Confirm user approval for bot verification and continued existing covered
  Replicate billing; no transport, key, sponsor or Gateway changes needed here.
- [ ] Resume Turnstile setup after its missing API credential is supplied locally.
- [ ] Implement the separate three-per-day visitor flow and its release gates
  in the [specification](../specs/2026-09-29-daily-split-allowances.md).
- [ ] Separate follow-up: resolve async Replicate/shared monetary accounting if
  still desired; the user-approved existing Replicate billing is unchanged.
- [ ] Commit/review/release the verified changes when authorized, and perform
  fresh authenticated production acceptance separately from local fixtures.
