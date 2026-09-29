# Class access and usage

## Current state

The Cloudflare app accepts current CUNY AI Lab membership, including membership
provided by an active class. Signing up identifies a person; admission or a
claimed class place grants access. `src/identity.ts` asks Admission on every
protected request and creates the local student record on first use. A class
does not need a second student import into STEM Splitter.

This branch includes the Gateway integration from PR #11. Listening Guide
requests carry the signed-in person's Gateway credential, so the Lab Gateway
resolves their current allowance and accounting key. The Account usage display
is an estimate of the person's effective Lab allowance, including other tools;
it is neither a class-only bill nor an extra STEM Splitter balance.

Before the September 29 release, the deployed Cloudflare address reported
`cloudflare-cuny-sso-20260908`, with Remixer disabled. The new release candidate
is `cloudflare-crate-gateway-20260929`, preserving the disabled Remixer default
and targeting https://stem-splitter.ailab-452.workers.dev/. Verify `/healthz`
and deployed asset hashes when promoting it. Local tests use synthetic
identities and controlled provider responses; they cannot establish live
allowance drawdown.

## Enroll a class

1. In [Lab administration](https://tools.ailab.gc.cuny.edu/admin), approve or open
   the intended class with its instructors, dates, capacity and allowance scope.
2. Have students claim the class invitation using CUNY Login. This works for
   people who have already signed up as well as new sign-ins. Existing individual
   access and class membership keep their separate provenance.
3. Students open STEM Splitter and sign in. Any current eligible Lab membership
   satisfies the app check. No per-student activation in STEM Splitter is needed.
4. Give instructors the app's expiring Instructor role through Account → Manage
   access when they need to edit Listening Guide guidance. A class instructor is
   not automatically a Lab administrator or a STEM Splitter instructor.

This is automatic admission for the enrolled cohort, not an administrator bulk
import of arbitrary email addresses. Adding already-approved people to a class
without their invitation claim would need a supported Admission operation and
an exact class/roster. No live class or membership was modified here.

Admission combines active individual and class sources. Ending a class removes
that source; someone with another valid membership can retain Lab access. STEM
Splitter's local suspension still overrides access to this app. Each student
owns their recordings; class enrollment alone does not share everyone's audio.

## What uses an allowance

| Action | Current accounting |
| --- | --- |
| Search the Crate, load source details | No model inference |
| Preview or add Archive audio to Remixer | No separation model; browser mixing |
| Play, mute, layer, annotate, export | No model inference |
| Generate a new Listening Guide or chat reply | Lab Gateway, using the signed-in person's current allowance, in PR #11 |
| Open an already cached Listening Guide | No new model call |
| Separate audio with Replicate | Provider spend, not yet deducted from the Lab allowance |
| Replicate YouTube fallback | Additional provider prediction, not yet deducted from the Lab allowance |

Current split safeguards reserve at most five attempts per person and twenty
for the whole app each UTC day. These limits are not dollar accounting and may
constrain a full-class exercise. Failed or uncertain attempts consume a slot.
Capacity changes should follow the expected class workload and a verified cost
limit rather than silently raising these caps.

## Finish unified audio accounting

Cloudflare documents a Replicate proxy, but forwarding a prediction is not proof
that its GPU cost is recorded against a human allowance. Its custom-cost header
is token-based and does not calculate costs for responses without token usage.
The current CAIL Gateway has no Replicate prediction contract. Keep this an
explicit class-launch gap; do not substitute an app key, a browser-supplied user
label, fake token counts or a separate local dollar balance.

Required implementation order:

1. Extend the shared Gateway with a bounded Replicate prediction contract. It
   must resolve the verified human identity and current Admission accounting
   key itself, pin allowed models, and retain the existing approved Replicate
   credential. STEM Splitter must not choose the user's budget scope or key.
2. Establish how actual asynchronous prediction cost reaches the Lab's existing
   accounting plane and spend enforcement. Prove create, terminal success,
   cancellation, failure and uncertain-response behavior. If the accounting
   plane cannot accept GPU-cost events, resolve that limitation before enabling
   the route; a custom diagnostic log is insufficient.
3. Bind each prediction to its requesting person and operation, preserve that
   binding through webhooks/polling, and reconcile terminal events idempotently.
   Repeated polls, callbacks or retries must not double-charge or launch another
   paid job. A YouTube import and its split are separate provider operations.
4. Exercise the real receiving contract, then switch STEM Splitter's separation
   transport only after the receiver is deployed and verified. Keep the current
   job limits until enforcement is demonstrated.
5. Run an authorized class-only student through CUNY sign-in, upload, completed
   split, playback and Guide. Verify both provider operations' accounting
   attribution, delayed aggregate readback, exhausted-allowance rejection before
   new work, and continued access to existing playback. Separately verify that
   revoked/expired class-only membership loses access.

## Crate purpose

The Crate is an Internet Archive source browser: students can search music or
other open audio, inspect the creator/license/source, and import an eligible
track for separation. The server repeats license checks and excludes material
that prohibits derivatives. Displayed imports are bounded to five minutes and
100 MB.

With Remixer enabled, PREVIEW and ADD TO MIX load bounded whole-track audio
without separating it. Students can combine up to eight layers, including stems
sent from Splitter, adjust volume/pan/entry/speed/reverse/loop/mute, record a take,
and download audio with credits and arrangement metadata. License compatibility
is checked before combining/exporting. Raw layers and takes are browser-session
work; download them before leaving. The Crate itself is not saved-work storage.

## Sources

- [Cloudflare Gateway PR #11](https://github.com/CUNY-AI-Lab/stem-splitter/pull/11)
- [CAIL Admission contract](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/main/05%20Infrastructure/CAIL%20Tools%20Admission%20Control.md)
- [Lab accounting policy](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/main/04%20Operations/Decision%20Records/2026-07-19%20AI%20Gateway%20Is%20the%20Accounting%20Plane.md)
- [Cloudflare Replicate proxy](https://developers.cloudflare.com/ai-gateway/usage/providers/replicate/)
- [Cloudflare custom-cost limitations](https://developers.cloudflare.com/ai-gateway/configuration/custom-costs/)
