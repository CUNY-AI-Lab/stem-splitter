# Guest workspace parity at the Tools address

The Tools mount must preserve the existing Worker's guest capability and stored
work. A different hostname has a separate HttpOnly cookie jar; serving the same
assets and D1/R2 bindings alone cannot recover that guest's identity.

## Required behavior

- Keep the public landing, song lookup, 2/4/6 split selection, guest uploads,
  retained jobs, playback, annotations and private saved conversations available
  through `/stem-splitter/` with their existing limits and ownership rules.
- On the first anonymous visit, start a nonce-bound top-level handoff to the
  original host. Reuse its active unclaimed guest session, or bootstrap there so
  a new visitor receives the same guest identity at both addresses.
- For an already signed-in first visit, check the original host for an existing
  guest before the normal account claim. This check never creates an empty
  guest. A per-account tab marker avoids repeat navigation after completion;
  the marker grants no access and server ownership remains authoritative.
- Sign the target cookie for the Tools origin without moving rows, extending
  expiry, resetting allowance, changing provider URLs or copying audio.
- Encrypt the five-minute handoff and carry it only in the URL fragment.
  Remove the fragment before requesting data. Require the initiating HttpOnly
  nonce cookie, exact write Origin, canonical encoding, active unclaimed guest
  and atomically single-use nonce. Concurrent/reissued tokens must not replay.
- Preserve distinct valid workspaces. A collision returns explicit recovery
  choices; it must not replace ownership or hide either original. A legacy
  member-cookie presence directs the user to sign in rather than creating a
  guest under the existing sign-in.
- Keep current Admission and same-subject app/Gateway verification for members.
  Absence of both signed identities may enter the guest boundary. Partial,
  invalid, mismatched or rejected member credentials must not downgrade.
- Forward only the two exact guest/transfer cookies through Doorway on the API
  and exact guest routes. Preserve safe clears as well as positive cookies.
  Public pages/assets receive neither cookies nor identity.
- Record mounted page responses and verified sign-in returns using existing
  privacy-safe server usage categories. Doorway owns actual sign-in failures
  before the receiver; a successful return is not evidence of a new session.

## Scope and acceptance

No schema, enrollment, quota, provider or retention change is required. Existing
class sharing still requires current Admission course membership and a folder
comment grant; private conversation history remains private. Browser-only unsent
drafts and player settings are not Worker data and remain origin-local.

Local acceptance must cover preserved data, playable audio, writes visible at
both addresses, guest/member isolation, CSRF, revocation, claim, conflicts,
replays and concurrent completion. Release the exact tested receiver through
the local Dev-first process, then the coordinated Doorway source through its
own release process. Verify the production Turnstile widget permits the Tools
hostname. Observe the existing user's tracks at the CUNY address after release.

Agustina's current owner grant, student roster, Gateway attribution and dashboard
records require authorized live reads. Synthetic tests and configured course IDs
do not establish that operational state.
