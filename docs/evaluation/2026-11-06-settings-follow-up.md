# Settings statefulness follow-up

This correction follows deployed source `b953107` and documentation checkpoint
`1de6f84`. It does not change production until a separate verified release.

## Reproduced behavior

When a session ended during a pending account or student-list read, the session
guard removed private controls. An unsent report correctly kept the page open,
but Settings' late catch/finally callbacks tried to change removed elements.
Both local browser cases reproduced `Cannot set properties of null (setting
'disabled')`. Private data remained cleared, but the callbacks threw errors.

Automatic lookup of a selected account's activity could also run indefinitely
on alternating cursors or empty pages with advancing cursors. Both regressions
ran past the test's 15-page safety boundary before the fix.

## Correction

Settings now invalidates pending callbacks and cached selection state when its
session ends. Initialization, account administration, student lists, saved-run
reads, quota reads and queued disclosure events respect that invalidation.
Existing roles and server authorization are unchanged.

Automatic activity lookup tracks cursors and stops after at most ten additional
pages. The page explains the stop and retains manual pagination and retry.
An empty selection no longer triggers a search through every account page.

## Validation

Seven new browser cases cover late account-list, student-list, saved-run,
administration-save and quota responses; retained report state; queued
disclosure events; cursor cycles; empty advancing pages; and manual recovery.
All identities and writes in these tests are synthetic and local.

The initial Chromium-focused run passed 44/44. The first Firefox run passed
43/44: an existing sign-in recovery test reproducibly stalled at a viewport
resize after a noopener popup closed. This was a test-window lifecycle issue,
on a route that does not load `account.js`. Desktop and phone now run in separate
fresh contexts with all original assertions preserved. That change adds one
test case rather than removing coverage.

The first diagnostic browser launch was blocked by the filesystem/process
sandbox; rerunning the authorized local browser check outside it succeeded.
The original late-response test also awaited an unconsumed response body's
completion; it was corrected to await response delivery before checking the
actual application callback failure. Those harness failures are distinct from
the application regressions above.

Final aggregate counts and exact file hashes are recorded in the separate
local verification receipt. No paid service, live authentication, audio upload,
real account mutation, GitHub publication or deployment occurs in these tests.

## Release status

The Cloudflare control-plane read still identifies production deployment
`793aff04-e71d-40fa-82f6-b01c4d51414e`, version
`3c591905-32a0-40a9-ba7b-9762f6376451` at 100 percent. Existing CUNY account
membership was verified without changing credentials. This confirms deployment
identity, not fresh served assets or end-to-end acceptance of this correction.
The separate Dev health endpoint returned HTTP 200 with source `b953107`; it
still serves the previous release and has not received this correction.

The prior production health request returned HTTP 403, with the denial layer
unresolved. It was not retried with another route or headers. The new correction
is retained locally until the normal exact-source Dev/production verification
can be completed. No old acceptance receipt is reused for changed code.

The optional SAM Audio trial remains unexecuted, with zero trial spend. It does
not gate this Settings correction. The separate instrument-label/isolation
requirements still need independently reviewed audio and a validated separator.
