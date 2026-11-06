# Stateful application audit

Baseline: production `4c115489bb3d9d28847b88ffe47655a5a5504d4b` (PR #94).
The audit is being verified in `codex/statefulness-audit-20261106`; publication
and exact production identity must be recorded separately after release.

## Persona boundaries

| Persona | Application view and authority |
| --- | --- |
| Signed out / guest | Guest and CUNY Login; application navigation hidden. Guest-owned runs and actual guest limits; no class, instructor or admin authority. |
| CAIL individual, no course enrollment | Splitter, Workspace, Settings; Personal work and default Listening Guy prompt. Workspace accurately reports no current classes. |
| Enrolled student | Student access is recognized; Personal remains the default. Explicit class selection requires the current disclosure. Shared folders/annotations follow the actual grant; no roster, teaching prompt editor or instructor console. |
| Course instructor with ordinary Lab membership | Instructor Console and course tools follow the exact course capabilities. The global account role remains Lab member; this grants no global account administration or application instructor folders. |
| Application instructor / Admission admin | Existing app-level tools follow the current authoritative role. Course access remains independently checked; private conversation and course boundaries are unchanged. |

## Findings and corrections

- **Class discovery:** the console read only the first page while navigation
  could correctly link to a later course. Both direct and discovery paths
  reproduced a hidden console. The console now checks bounded pagination.
- **Workspace role transitions:** student-to-instructor retained student controls;
  instructor-to-student attempted the old roster read and hid the whole class.
  A private current-class read now uses the existing exact-class resolver.
  Refresh replaces changed capabilities and clears obsolete privileged views.
- **Application instructor revocation:** navigation hid Instructor Console but
  Splitter retained instructor-only folders because its older check only ran
  when no instructor was already present. The folder controls now revalidate,
  conceal uncertainty, clear revocation, and fence late responses. Unchanged
  authority preserves a folder rename draft through a read outage.
- **Nonadvancing discovery:** Splitter and Workspace counted returned courses,
  allowing repeated empty pages to keep loading indefinitely. All affected
  discovery loops now detect repeated cursors and permit at most ten pages.
- **Session loss during discovery:** keeping an unsent report while an old
  class lookup was pending triggered a second cleanup against removed private
  controls. The regression reproduced a null-element exception. Cleanup is
  idempotent and stale initialization failures cannot overwrite the retained
  report's session-change message.

## Application coverage

| Surface | Authority/state checked | Evidence |
| --- | --- | --- |
| Header and navigation, all four pages | Pending, signed out, guest, member, student, instructor, admin; loss, outage and recovery | `auth-navigation.spec.mjs`, `statefulness-audit.spec.mjs` |
| Settings | Current account role, independent individual membership, app administration and student activity permissions | `account.spec.mjs`, new persona matrix, `identity.test.ts` |
| Upload/Search/intake | Guest/member state, all-provider search, exact class choice and disclosure, stale discovery and held upload | `guest.spec.mjs`, `course-workflow.spec.mjs`, `music-audio-flow.spec.mjs` |
| Saved runs/resplits | Ownership, exact source, placement, allowance, reload, deletion, nested controls and exclusive playback | `guest.spec.mjs`, `account-rack.spec.mjs`, resplit/backend tests |
| Public sharing | Public audio with private tools, names, notes and transcripts excluded | `sharing.spec.mjs`, ownership/backend tests |
| Personal folders | Current application instructor authority, revoke/recovery, rename persistence and late reads | `account-rack.spec.mjs`, new folder regressions |
| Workspace folders/roster | Exact class membership and capabilities, read/comment/private grants, pagination and role transitions | `instructor-acceptance.spec.mjs`, `course-workflow.spec.mjs`, new transition tests |
| Instructor Console | Actual app/course capability, paginated discovery, prompt scope, revision conflict, uncertain saves and late responses | `instructor-settings.spec.mjs`, new discovery tests |
| Listening Guy | Personal/guest base prompt, class-only amendments, private history, consent, turn counts and interrupted request accounting | `gateway.spec.mjs`, `listening-usage.spec.mjs`, `classroom.test.ts`, guest tests |
| Shared playback and notes | Explicit opt-in, instructor control, per-author changes, revocation and visibility lifecycle | `live-session.spec.mjs`, `course-workflow.spec.mjs` |
| Account/session changes | Actor fences, concealed private state, preserved report draft, no stale protected UI | `auth-navigation.spec.mjs`, account/bug-report tests |
| Server mutations/files | Fresh membership and exact class authority, ownership, same-origin writes, idempotency, limits and attribution | identity, classroom, resplit, guest and operation backend suites |

## Validation boundaries and remaining task list

The initial four browser regressions failed for their intended application
conditions, then passed after the class fixes. A separate instructor-folder
case reproduced the retained controls after its fixture's valid role/audit
fields were corrected. The default system Chrome channel was absent; the
installed Playwright Chromium was used, with no installation. Neither fixture
setup errors nor missing browser binaries are application failures.

Final local verification passed **1,278/1,278 checks**:

| Suite | Passed / total |
| --- | --- |
| Cloudflare backend | 440 / 440 |
| Shared contracts | 421 / 421 |
| Server adapter | 44 / 44 |
| Complete Chromium browser suite | 238 / 238 |
| Firefox affected browser suites | 109 / 109 |
| Legacy browser flows | 19 / 19 |
| Auto/isolation compatibility, mocked | 7 / 7 |

All three typechecks and the final Cloudflare production dry build passed.
The seven changed application files retained their frozen hashes throughout
the final runs. The 14 new browser cases are included in both browser totals;
focused diagnostic reruns are not counted again. The bundle contains the
Cloudflare Hono adapter and excludes the Node server adapter, FTP and ZIP
extraction dependencies. No schema or deployment configuration changed.

Earlier diagnostic runs retained failures: the first browser aggregate used
an obsolete two-read assertion (the new current-authority check adds one
read), Firefox reported a fractional scroll position, and a legacy fixture
set a frontend instructor variable without verifying authority. Those
assertions/fixtures were corrected, then the affected full suites were rerun.
The pending-discovery session-loss regression reproduced an application
exception before the cleanup fix. These diagnostic results are distinct from
the final passing runs above. GitHub checks, the exact merge, deployment and
served-asset checks are recorded separately in the release receipt.

Browser identities are synthetic and local; models are mocked. The final
browser profiles explicitly mute output without altering app volume/clock
behavior: Chromium's mute argument and Firefox's string-valued
[`media.volume_scale`](https://searchfox.org/firefox-main/source/dom/media/CubebUtils.cpp)
preference, set through Playwright's isolated
[launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch).
No production records, roles or credentials are modified by these tests.

Search/layout/menu/resplit-controls work was released in PRs #93/#94. The
remaining instrument recognition and audio-derived separation work is not
validated: the saved local diagnostic has classification errors and requires
a licensed, separately calibrated evaluation set. The three-genre × 2/4/6 ×
initial/resplit gate remains open. A paid SAM trial additionally requires the
previously stipulated all-in $0.50 cap and specific excerpt transmission
rights. Neither gate is established; no paid job or upload occurred. UI tests
do not count toward the 18 real-audio cases. YouTube and Remixer stay excluded.
