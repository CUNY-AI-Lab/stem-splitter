# Cloudflare Listening Guide implementation

1. Clone the clean, published Cloudflare candidate into the handoff scratch
   workspace. Read its source contracts and current remote CAIL authority.
2. Add the private Gateway adapter and paired identity verification. Keep the
   root dependency lock, prompt, Remixer design and storage namespace unchanged.
3. Thread the transport, safe errors and cancellation through the existing
   Listening Guide. Preserve local narration and separate Replicate limits.
4. Exercise same-subject identity, one attempt, trailing stream failures,
   bounded/cancelled calls, unavailable quota, recording ownership and browser
   workflows. Run source and existing browser/audio gates.
5. Push a candidate-branch PR and record exact evidence. Release only the
   isolated candidate under its existing gates; never reconfigure Railway,
   publish a shared service change, or enable Remixer from fixture evidence.

## Local source acceptance

Implemented on the isolated candidate base `a4d6c18`. Shared Worker regression
tests pass 320/320 after fetching the historical commits required by the analyzer
evidence; Node adapter tests pass 42/42 and analysis contracts pass 24/24. Both
shared typechecks and the adapter typecheck pass. Root audio/browser suites pass
19/19, Auto 6/6 and isolation 1/1. The six Cloudflare Chrome journeys pass,
including native capture/credit export, accounts/roles, guide completion, safe
quota refusal with support ID and cancellation without a second model request.
The 22 adapter/security tests include the actual Worker/Hono/private-client
boundary with signed synthetic identities, D1/R2, one guide request plus cache,
terminal stream failures, informational quota and concurrent split reservations.
The isolated Worker bundle dry-builds successfully.

Cancellation testing exposed a dependent Request signal losing propagation
while an intentionally non-cooperative fetch was pending in Node. The adapter
now retains and races the caller's original signal. Error fixtures now follow
the published Gateway envelope, including its `cail` metadata. Two intermediate
local Workerd runs reported a harness connection loss; the isolated Workerd run
and subsequent complete adapter/browser run passed. Hosted CI remains a separate
required check before release.

These checks use synthetic identity, Admission, Replicate and Gateway responses.
They do not establish deployed login, live model quality/accounting or paid audio
separation. No database migration, provider change, Railway release or shared
Gateway/Doorway/Admission deployment is included. Keep the existing live release
and false-default feature gates until separately accepted.
