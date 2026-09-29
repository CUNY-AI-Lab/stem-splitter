# Implementation and acceptance

Responsible task: STEM Splitter Crate position, class enrollment and Lab usage.
Branch: `codex/crate-class-usage-20260929`, based on Gateway PR #11 at `6910f35`.

1. Append the existing Crate to the active station; correct its import message
   so it no longer sends students to a shelf "below" it.
2. Link administrators to central class management and label the Account quota
   as the Lab's estimated model allowance.
3. Exercise existing Cloudflare browser, identity and Gateway coverage. Capture
   desktop/mobile placement in both Remixer flag states.
4. Document class admission and remaining Replicate cost integration in
   `docs/class-access-and-usage.md`, without creating a parallel allowance ledger.

Callers/receivers: browser → Cloudflare app → Doorway/Admission for identity and
membership; app → private Gateway for Guide inference and quota; separation
still calls Replicate. This change adds no shared receiver requirement. A future
audio accounting receiver must ship and pass real boundary acceptance before
the app uses it.

Verified September 29: adapter typecheck and all 22 identity/security/Gateway
tests pass. All six existing Chrome journeys pass, including desktop/mobile
placement with Remixer off/on, account controls, Guide quota refusal/cancellation,
stem handoff and real browser recording/export of controlled audio fixtures.
The Remixer test's old first-section assertion was updated and its full journey
rerun successfully. Initial sandbox restrictions prevented local server/browser
startup; the approved rerun completed normally.

Admission main `12634c0` still resolves active class enrollments through the
existing membership RPC. Gateway main `36cd8cd` has no Replicate route. Public
Cloudflare health/runtime readback still reports the September 8 release and
disabled Remixer; no deployment or live membership change is part of this
receipt. Actual CUNY login, paid separation and shared allowance debit remain
unverified. Screenshots are local test artifacts outside the repository.
