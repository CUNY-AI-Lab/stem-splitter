# Silent workspace continuity

Status: stages 1–3 are implemented locally for private listening drafts, player
settings and inert pending listening work. Focused local service and browser
checks pass; this document does not assert Dev or production deployment or real
account acceptance. The original inventory was reviewed at
`1d5e596450376f99de3e27261957020cc0d2154d`. The implementation plan and remaining
gates are `../plans/2026-11-16-workspace-continuity.md`.

## Product requirement and authority

The original Worker address and the Tools mount must preserve the user's work
through ordinary app use. The user rejects **all recovery, browser-copy and
guest-choice interfaces**. Do not add links, dialogs, banners, progress messages,
review/apply buttons, a new visible page, or a popup for continuity. This design
supersedes the explicit-interface proposals in the earlier browser-recovery and
guest-parity documents. It does not authorize a deployment or reinstate their API.

Use private, typed server persistence for settings and drafts. Initial seeding,
hydration and later saves run without user intervention. A temporary failure
leaves the normal app available and local originals intact. No copying process
may start a paid operation, submit a draft, publish instructions, create a folder,
change sharing, or resume playback/recording/live-class participation.

The implementation may be staged. The first stage covers private per-job
listening state; it must be described as that subset, not all browser-state
parity. Every other family below retains an explicit status until implemented
and accepted. Existing old-tab memory cannot be recovered by loading new code in
another document; do not reload or navigate an editing tab to collect it.

## Current state and coverage ledger

No first-party IndexedDB, CacheStorage or service-worker persistence was found in
`public/`. HttpOnly authentication cookies remain adapter-owned credentials.

| State family | Current owner/location | Planned handling and first-stage status |
| --- | --- | --- |
| `stem-listening:<subject>:<jobId>` draft | `public/guest-claim.js`; `Mixer.saveListeningProgress` | First stage: private per-job draft record; max 2,000 characters, preserve existing text without truncating migration. |
| Same key: position, rate, muted, solo, loop, guideOpen | Same writer; restored by `Mixer.restoreListeningProgress` | First stage: separately revisioned player record; never autoplay. Validate stems, duration and current playable access before applying. |
| Same key: pendingConversation, pendingChat, pendingGuide | Current cache contains transcript revision, message ID, text/history and duration | First stage preserves as **inert private versions/receipts**, never hydrates into active pending fields. A server-confirmed result may be read without replay. |
| `stem-ui-journal:<subject>:<jobId>` | New continuity client; typed pending draft/player CAS writes and explicit-clear marker | Implemented locally: preserve request ID/base revision across interruptions; drain during normal job hydration and original-host quiet handoff. Contains no AI operation queue. Conflicts are retained without overwriting the server winner. |
| `jobs:<subject>` | Rack IDs, metadata and collapsed rows in `app.js` | Later: presentation-only state, validated IDs, ordering/collapse and explicit suppression. Server jobs/titles/URLs/ownership remain authoritative. |
| `stem-workspace-choice:v1:<subject>` | Classes selected class; navigation consults it | Later: preference gated by current enrollment/capability. Never sharing consent or instructor authority. Main upload choice also has URL/in-memory state. |
| `stem-split-choice-v1` | Device-global model preference | Later: missing-only legacy seed; validate current advertised model. No automatic job creation. |
| `stem-song-rotation-v1` | Device-global sample revision, seen/last/order/pass | Later: validate current public sample catalogue; preserve different local preference on bootstrap. |
| `benchTab` | Device-global Splitter/Remixer choice | Later: enabled-tab preference only. Remixer is disabled in current Dev/production configs. |
| `jobs`, `coachChat:<jobId>` | Unscoped legacy class-code rack/transcript | Unattributed legacy data: leave original bytes untouched. No silent adoption by the current member. Not covered by account continuity without a separate attribution rule. |
| `classCode` and password inputs | Legacy credentials | Excluded from synchronization; do not revive authority. |
| `pendingSplit:<subject-or-anonymous>:<body/course hash>` | Tab-local idempotency UUID | Later inert operation-reference preservation only; never restore a submission queue or upload. An old tab's sessionStorage is not another tab's storage. |
| `stem-rack-session:<subject>` | Tab session used by failed-run handling | Keep per actual session; do not copy as content or mint historical activity. |
| `stem-usage-visit:<subject>:<UTC-day>` | Tab usage deduplication | Keep local session accounting. Never replay telemetry to simulate continuity. |
| `stem-transfer-checked`, `stem-transfer-return`, `stem-transfer-member` | Quiet guest transition bookkeeping | Preserve existing bounded, one-shot behavior; values confer no account authority and are not synchronized. |
| Historical `stem-browser-recovery:v1:<uuid>`, `stem-browser-recovery-active:v1:<subject>`, `stem-browser-recovery-hidden:v1:<subject>:<uuid>` | Removed implementation; may exist only on browsers that ran it | Leave bytes intact. Compatibility import is a separate stage: full schema/subject/integrity validation, fresh job access, inert pending data and retained suppression. Never reinstate its UI or trust an active pointer as authority. |
| Annotation/label/recording-title form drafts | DOM in `app.js`; published values use normal APIs | Later typed private form drafts. Never submit the edit during hydration. Existing old-tab-only values cannot be collected remotely. |
| Folder create/rename drafts and selected view/folder | DOM/memory and URL in `classroom.js` | Later subject/course/folder-scoped draft records with fresh capability checks. Refresh currently preserves some in-memory text, not reload continuity. |
| Instructor amendment/changelog/sample-editor drafts | DOM/memory in `teacher.js` | Later separate private instructor draft scope and base settings revision. Never auto-publish or preserve permission via a cache. |
| Anonymous report text/receipt | `bug-report/form.js` explicitly memory-only, kept until reload | Separate product/privacy contract needed before persistence. Do not silently attach anonymous prose to an account. Preserve the current tab. |
| File chooser, unfinished upload, search/link text | File objects, DOM, in-flight requests | Later text-draft handling where useful; file bytes/upload continuation need an explicit binary/operation contract. Never pretend a file chooser can be restored by a string. |
| Remixer arrangement/title/settings and recorded takes | Memory, AudioBuffers and Blob/object URLs in `app.js` | Disabled currently. Separate bounded arrangement/binary persistence if enabled; object URLs are not durable media. |
| Live-class following/hosting, open menus, playing state and other transient controls | Page controllers/DOM | Recompute current state; never restore authority, playing audio, recording or live participation automatically. |

Completed server records already shared by the aliases include jobs/stems,
published labels/annotations, folders/permissions, guides and saved conversations.
Their presence is not evidence that the above browser-only families are shared.
Course transcript-review authority does not grant access to unsent UI drafts.

## Implemented local persistence contract

The shared `src/ui-state.ts` module and additive `0035-job-ui-state.sql` schema
are routed through the existing authenticated application. First-stage routes:

- `GET /api/jobs/:id/ui-state`: current subject's draft/player records and
  revisions after fresh job access. Private responses include `X-Stem-Account`.
- `PUT /api/jobs/:id/ui-state`: a typed field update with base revision and
  idempotency ID. Draft and player updates are independent records, so periodic
  position saves cannot replace text. Explicit clear is a revisioned tombstone.
- `POST /api/account/ui-state/seed`: bounded create-if-missing records from the
  current verified local namespace. Provenance and content digests deduplicate
  retries. Differing existing text is preserved as a version, not overwritten.
- Original-host-only `GET /auth/guest-transfer/context`, `POST
  /auth/guest-transfer/seed` and `POST /auth/guest-transfer/write` verify the guest
  cookie independently of a coexisting member cookie. The write route accepts
  only draft/player CAS writes, including explicit clears, with a captured
  `X-Stem-Account`. These routes are unavailable through the Tools mount.
  Late guest state copies only through its exact claim journal/current owner;
  naming a guest or member in browser storage grants no authority.

The existing top-level handoff first serves an empty source document loading
same-origin scripts, then continues its existing encrypted nonce-bound transfer.
Member and guest namespaces seed separately. Source journal writes share the
eight-second overall deadline; an eight-second meta refresh also bounds failed
script loading. No new interface appears. Listening cache bytes remain intact;
successfully acknowledged typed journal entries may be removed. If an outage or
deadline prevents a write, the local journal remains pending, and cross-address
continuity for that write is incomplete until a later successful source visit.

Setting/form routes can follow later using explicit enums; do not expose an
arbitrary storage-key/value database. The server assigns the owner and job scope
from authenticated context and current access checks. Do not accept account IDs,
roles, instructor flags, course grants, sharing consent or URLs as authority.

Store active values, revisions and explicit clears separately from immutable
conflict versions and inert operation receipts. A version identifies actor,
logical key, source provenance, digest and server receive time; client timestamps
are not a total order. Use atomic compare-and-swap and atomic conflict/version
insertion. A stale update cannot overwrite the winning revision, even if it is a
position save or an empty draft from a newly constructed mixer.

Initial bounds: at most 64 records and 512 KiB per seed request, with explicit
pagination; at most 256 KiB per inert pending-work record and existing field
limits. Player positions/loops must be finite and bounded, rates supported, stems
bounded to existing canonical names. Enforce a per-actor retained-byte limit.
Oversize, invalid or capacity-limited input is rejected/preserved locally, never
silently truncated or marked fully migrated. Final numerical storage quota and
expiry must be settled in schema tests before release, not left unlimited.

Per-job data expires no later than its retained job. Guest access also requires
an active guest or the exact accepted claim mapping; persistence never extends
a guest session or quota. Future account preferences need their own lifecycle.
Do not delete an unacknowledged local copy on an expiry/cleanup response.

All routes use the existing current Admission and matched app/Gateway identity
boundary, same-origin mutation checks, rate limits, `private, no-store`, bounded
JSON and no payload/identity logging. Partial or malformed signed identity does
not downgrade to guest. Known job/course denial omits that inaccessible scope;
unavailable authority defers it without guessing. The state service does not
invoke providers or change usage accounting.

## Browser initialization and silent source seed

Before startup writes defaults, snapshot only actual records in the exact
verified namespace. Enumerate listening keys independently of `jobs:<subject>`:
folder moves can remove a rack row while retaining private drafts. Do not scan
other account prefixes or sibling Tools apps. Unscoped device preferences are
not proof that private unscoped text belongs to the current account.

Normal initialization captures actor plus generation and starts a bounded read.
Hydration must complete before writing default progress for that mixer. If the
read fails, use the existing local state and normal interface without a new
message/page. After every await, verify actor/generation and that the field has
not been edited since the request began. Do not change focused editor text under
the user's hands. Background saves retain local data until the corresponding
server revision is acknowledged; retry with bounded backoff and idempotency.

The initial Tools visitor may have source storage that the Tools origin cannot
read. Extend the **existing quiet top-level guest transition**, not a popup or
new visible workflow. The original host may serve a minimal script-bearing
response at its existing transition route to seed its first-party storage and
then continue the existing encrypted guest-cookie handoff. It contains no UI,
status text or editor initialization. Use a fixed return destination, remove
handoff fragments promptly, keep nonce/origin/replay validation, bound seeding
to eight seconds and return to the ordinary app on failure. Do not put data,
account identities or operation authority in query strings.

The source document obtains an adapter-verified context for each allowed member
or guest namespace; it never infers ownership from a localStorage key. The
destination reads its own independently verified principal. If source member A
and destination member B differ, A's records stay with A and cannot appear for B.
If source member access requires a fresh login, do not introduce a login or
recovery prompt just to synchronize: keep originals and defer that namespace.

Do not force this transition from an already editing document. Use initialization
before the app accepts edits and the existing one-shot loop guard. Existing old
tabs remain untouched and can only seed when they normally load compatible code.
With blocked sessionStorage, preserve the current fallback to ordinary startup;
missing loop protection is not permission to navigate repeatedly.

Tools hosts multiple applications on one origin. Key prefixes do not isolate
them from same-origin script execution. This existing trust boundary remains;
do not weaken CSP, introduce cross-origin credential CORS, or rely on an iframe
(`frame-ancestors 'none'` currently applies) to bypass it.

## Conflict semantics

Legacy cached values have no trustworthy timestamp or common revision. Seed only
missing settings. For text conflicts, retain the currently displayed local
draft, preserve both versions server-side before acknowledging, and never merge
strings or replace a nonempty destination draft automatically. Explicit cleared
values must defeat stale copies; absence is different from a clear.

For the first stage, preserve inert/conflicting versions without a new interface.
Later, existing private exports may include version records; this is not a new
recovery screen. A release that retains inaccessible alternatives must not claim
that every conflict has been resolved or made equally visible. Two conflicting
drafts cannot both occupy one text input without a choice; report that limit.

Player fields can use the normal server revision once initialized, while local
playback already in progress wins over late hydration. Do not restart audio.
Later rack migration must remember suppression instead of repeatedly merging
removed IDs. Preferences must validate current choices; class hydration must
never check the course-sharing acknowledgment.

## Pending operations are inert

This rule applies to server-seeded versions and remote hydration. Preserve the
existing same-browser sign-in claim behavior for locally requested work: only
server-confirmed claimed job IDs may copy normalized local guest progress into
an absent member cache. That local copy retains pending transcript revisions and
original chat/guide request IDs. Transcript retry requires the matching server
revision and normal CAS; chat/guide retry still requires an explicit click and
uses the original idempotency key and input fingerprint. Existing member cache
wins. This does not install remote pending versions or start a model request
during claim or hydration.

Current `Mixer.loadConversation` automatically PUTs a matching non-durable
`pendingConversation`. Therefore the whole cached progress object cannot be
installed as live state. Copy only validated draft/player fields into automatic
hydration. Store pending conversation/chat/guide objects separately, retaining
their full bounded text and IDs without filling `pendingChat`, `pendingGuide` or
`savedProgress.pendingConversation`.

A future read-only receipt lookup can reconcile a previously completed operation
without creating or retrying it. A newer transcript reset/revision takes
precedence. Do not resume a paid request, reuse a sharing bearer link as active
authority, or replay a telemetry event. Normal explicit Send/Retry remains the
only operation trigger. Pending text may become a normal draft only when that
does not overwrite another draft or imply an already-submitted action is new.

## Guest claim and dual-cookie boundary

`src/guest/claim.ts` already has an atomic ownership batch authorized by the
adapter-verified guest cookie and current personal member principal. Extend that
batch to copy per-job UI state only for exact `guest_job_claims` rows accepted by
the same gate. Create missing member values; retain existing member values and
archive divergent guest records. Keep guest originals. Do not change original
operation ownership, guest quota class, receipt reset semantics or expiry.

A source can hold both a member cookie and an unclaimed guest cookie.
`/api/account` can return the member while the transfer concerns the guest. The
source seed must use separate server-verified contexts, not label guest data
with the member identity. This is mandatory, including when source and Tools
member identities differ.

For already-claimed guest state, accept late local seeding only through its
recorded claim owner and exact claimed jobs, backed by adapter-verified guest
proof or a narrowly reviewed current-member-plus-claim proof. A caller naming a
retired guest is insufficient. Distinct active guests are not silently merged.
Expired/revoked sessions do not regain authority. Failure leaves originals and
normal guest/member access intact. Claiming server work and copying destination
localStorage alone does not establish that source browser drafts were seeded.

## Acceptance matrix

| Case | Required evidence |
| --- | --- |
| Same member on both addresses | Exact draft/player survives normal source seed and Tools load; no continuity UI and no source-byte deletion. |
| Same guest | Same verified guest/expiry/quota; per-job local state follows identity without copying credentials into data. |
| Source member plus unclaimed guest | Both contexts distinguished; guest data seeded as guest and follows only an accepted claim. No relabeling to source or target member. |
| Different source/target members or distinct guests | No cross-account render/read/write or implicit ownership merge; normal app remains usable. |
| Account change during read, seed, save and claim | Old response cannot update DOM, local keys or current-account records. Test after every awaited boundary. |
| Revoked membership, removed folder grant, expired job/guest | No state hydration through stale authority; known denial isolated, uncertain authority deferred. |
| Existing and conflicting drafts | Both versions retained; nonempty current editor unchanged; no clock-based overwrite. |
| Explicit clear/reset | Tombstone/new transcript revision prevents stale cache or pending work resurrection. |
| Source job moved out of rack | Exact account listening key still seeded; rack is not reconstructed merely to preserve draft. |
| Pending transcript/chat/guide/split | Preserved inert; no POST transcript/model/job or telemetry replay; confirmed-result lookup read-only. |
| Storage/network failure and lost acknowledgment | Local bytes retained; atomic/idempotent retry; bounded return without blank-page hang or navigation loop. |
| Simultaneous tabs and stale base revision | Exactly one conflicting update wins active revision; losing text preserved, not dropped. |
| Partial oversized batches | Explicit incomplete result internally; no silent truncation or all-data-complete claim. |
| Later preferences/rack/form stages | Validate available model/course/tab, no consent/role restoration, no removed-row resurrection, and no automatic form submission. |
| Old DOM-only draft, report text, upload or disabled Remixer take | Recorded as unavailable/deferred scope, never claimed transferred by a storage scan. |

Use local synthetic tests first. Then perform authorized real guest/member Dev
acceptance on disposable work and exact-source production acceptance only through
the repository's release policy. Preserve existing user tabs. Record the state
families actually covered; passing listening-state checks is not acceptance of
all-local-data parity.
