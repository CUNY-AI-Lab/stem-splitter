# Anonymous Listening Guy demo contract

The current request supersedes the earlier five-turn and three-reply proposals.
This implementation is ready for a separately approved activation; it does not
establish a live funded demo. The canonical runtime check on October 26, 2026
at 03:22 UTC confirmed guest splitting enabled and guest Listening Guy disabled
(`chatAvailable: false`, `chatLimit: null`, `chatLimitScope: session`) on release
`aa12a79b29011c5193faa97c1a8c58287f1e2ea3`.

| Interaction | Application behavior |
| --- | --- |
| First | One real successful reply. |
| Second | A second real successful reply with a subtle Sign in link inside chat. |
| Third | An application sign-in request, with zero model/provider dispatch. |

One atomic successful-plus-pending limit covers the guest browser session across
chat, cue, recordings, tabs, resets and UTC days. Failed, empty, cancelled and
incomplete replies release demo capacity. Existing attempt, Turnstile, ingress,
origin, ownership and expiry protections remain active. Same-key readback of a
committed reply uses its existing result and durable sign-in state, including a
lost second completion before or after verified sign-in. Application prompts
are never presented or counted as AI replies.

Guest receipts use separate exact-owner storage and transfer only through proof
of both the guest cookie and current admitted member. Historical guest operations
keep their original accounting class. Signed-in people, including admitted guest
instructors, retain the existing Doorway identity and person-scoped CAIL allowance.
The member five-turn/five-minute pause is removed; existing daily app and shared
provider protections remain.

The browser session is not a unique person. A user can establish another session
by clearing cookies, so the local cap cannot establish a financial ceiling.
Zach has selected his administrator funds as the intended sponsor. The exact
supported sponsorship mapping, aggregate spend amount/window/end date and any
specific credential operation remain unresolved. Current shared infrastructure
supports a dedicated application principal; it does not expose an anonymous
human delegation that silently charges Zach's individual SSO allowance. Preserve
the configuration hold and obtain that concrete shared-service approval before
installing credentials, changing spend rules, enabling the demo or running paid
acceptance. Existing optional app-key code is not such approval.

Required acceptance uses fixtures first: two successes; third pre-dispatch refusal;
concurrent mixed endpoints/recordings; failed/incomplete refunds; reload and UTC
continuity; second-reply/link recovery with one model charge; ownership isolation;
and verified sign-in with the same draft/player/conversation. A real funded test
must later verify two genuine completions and no third dispatch separately from
these simulated transport checks.
