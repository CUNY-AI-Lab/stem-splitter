# Dashboard, activity and focus corrections — November 6, 2026

## Scope

One primary Dashboard entry replaces Settings and Instructor Console. Account and
Listening Guy remain separate views within Dashboard. Every authenticated CAIL
member can save their own Personal instructions and immutable revision history.
Class instructions require the existing current capabilities and take precedence
for class work. Guests receive only the base prompt. Personal guide caches are
keyed by recording and authenticated subject; private policy never enters the
shared base-only guide cache. Migration 0033 is additive and rollback-compatible.

Focus checks retain geometry and drafts while making uncertain private controls
inert/concealed. Same-person account role changes clear old privileged content
without reloading the document. Identity changes still clear private content.
The user's two intro sentences wrap before the midpoint inside the 780px main
container, with no dividing rule. Share with and Run splitter share the control
palette and sizing. The source selector and search accordion remain absent.

## Activity accuracy

A read-only production audit of the existing b953107 release confirmed 16
account records; 13 successful chat operations, 11 successful opening-guide
operations, and nine historical owned jobs without a split-operation receipt.
These are aggregate storage observations, not a claim of complete usage history.
The previous Guide turns combined replies and cues. First account access was
actually app_users.created_at. Last activity mixed background authenticated
requests, processing and browser observations. The claimed October 29 collection
start was wrong: retained visit/page observations reach October 11, while retained
playback observations begin October 29. No data backfill or user record was changed.

The UI separates each measure, uses None recorded for zero stored observations,
shows date provenance under Recorded dates, and explains the 30-day browser window
without inventing a collection start. Authenticated background requests never add
visits or plays. Existing legacy jobs and claimed guest work remain counted once.
Client reports are best effort, not attendance or proof of non-use.

## Verification and release

Completed local checks before the frozen-source release: Cloudflare backend
449/449, shared app 421/421, server adapter 44/44, release tooling 8/8, three
TypeScript checks, and production dry bundle. Firefox affected workflows passed
44/44 and the legacy prompt-editor browser check passed 1/1. New browser tests
exercise individual/student/instructor Personal instructions, history, scope
changes, conflicts, outages, account changes, focus geometry and role loss.
All model transport and identities in these tests are synthetic; audio is muted.
The final complete browser result and exact source are recorded in release receipts.
Earlier diagnostic failures included obsolete navigation assertions, missing
personal cache context in old tests, the old migration-equivalence fixture, and
sandbox port restrictions. Those do not count as passing final checks.

The current public Dev and production health markers were read successfully and
both returned b953107d6e9d6f744a01d9cb9a6ff7acd108285e. Production version was
3c591905-32a0-40a9-ba7b-9762f6376451, deployment
793aff04-e71d-40fa-82f6-b01c4d51414e at 100%. Its compatible version remains the
rollback point for this additive release. The CUNY Cloudflare account membership
was verified. Existing Firefox Stem tabs currently show Guest; no sign-in was
attempted and the user's prior tab was restored.

No paid model call, audio upload, provider change, GitHub publication or shared
service deployment is part of these checks. Instrument validation remains a
separate open requirement; the detector and isolation flags remain off.
