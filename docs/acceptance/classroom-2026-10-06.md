# Classroom candidate checks — October 6, 2026

This is local candidate evidence for PR2, based on baseline
`e1918da3cb6fc37f9715d4cd143af5a5c6c880c6`. It is not a deployment or live-account
acceptance receipt. The [access and migration contract](../classroom-access.md)
defines the authority, prospective disclosure, retention, pause and release
policy. The independent reviewer records their own findings separately.

## Automated checks

| Check | Result | Local evidence |
| --- | --- | --- |
| Root `bun run test` | Typechecks; 321 Worker, 42 server, 5 separator, 30 discovery and 9 comparator tests pass | `/tmp/stem-classroom-root-reviewed.log` |
| Cloudflare `bun run typecheck && bun run test` | 50 tests pass | `/tmp/stem-classroom-unit-final.log` |
| Full Cloudflare Chrome browser suite | 30 tests pass | `/tmp/stem-classroom-chrome-final.log` |
| Firefox playback, sharing and classroom suite | 19 pass; native Chromium zoom intentionally skipped | `/tmp/stem-classroom-firefox-reviewed.log` |
| WebKit playback, sharing and classroom suite | 19 pass; native Chromium zoom intentionally skipped | `/tmp/stem-classroom-webkit-reviewed.log` |
| Final Firefox classroom rerun | 4 pass; native Chromium zoom skipped | `/tmp/stem-classroom-firefox-final.log` |
| Final WebKit classroom control rerun | 4 pass; native Chromium zoom skipped | `/tmp/stem-classroom-webkit-controls.log` |
| Local Wrangler D1 baseline → migration 0021 | Old private jobs, note text and conversation revision/text unchanged; zero course assignments manufactured; lease column present | `/tmp/stem-classroom-d1-reviewed.log` |
| Cloudflare Wrangler dry build | Pass; no deployment | `/tmp/stem-classroom-dryrun-final.log` |
| Production dependency audit, Cloudflare | No vulnerabilities in 6 audited packages | `/tmp/stem-classroom-cloudflare-audit.log` |
| Production dependency audit, legacy root | Four pre-existing moderate Hono advisories; frozen root lock unchanged | `/tmp/stem-classroom-root-audit.log` |

The actual Cloudflare production and test bundles both alias Hono to
`hono-cloudflare` 4.13.11. The separate root Hono 4.12.34 audit reports
`GHSA-gqvv-2mrq-wpjv`, `GHSA-g6gw-c38x-mqfc`, `GHSA-crvj-82cr-hjcx`, and
`GHSA-hxh3-vqpv-xpqv`. This PR does not claim the frozen native-analyzer/root
dependency tree is clean or change the Railway lane.

The strict wire tests mirror the byte-for-byte Portal fixture pinned at
`5f13f332c120c6712aead2a355b3cf5bcc6dae58`. They cover malformed UTC dates,
inverted validity windows, stale receipts and access markers on plain assignment
pages. Conversation tests cover concurrent duplicate input, late completion
after reset with the same client message ID, interrupted claims, and storage
failure before/after commit. Recovery preserves earlier messages and does not
repeat an uncertain model operation.

## Browser observations

The Browser plugin was not available. Repository Playwright drove isolated
local Workers with synthetic identities, roster entries, stored messages and
audio. No paid model/separation calls or real account mutations were made.
Local URL ports are assigned per test; the exercised page routes and titles are:

| Route | Title | Interaction and observation |
| --- | --- | --- |
| `/?job=course-song` | Stem Splitter | Course peer reads named notes, refreshes during real audio playback, keeps audio element/time/rate/loop/volume and drafts; access revocation clears saved private content and stops playback |
| `/teacher.html` | Stem Splitter · Instructor | Current course owner edits that course's prompt; stale revisions conflict; changing accounts clears drafts |
| `/classroom.html` | Stem Splitter · Courses | Owner sees a zero-split student, reads all 70 test messages through pagination, creates a private course folder and edits course grants |
| `/account.html` | Stem Splitter · Account | Account actions remain separate from verified course ownership; existing recovery/sign-out browser coverage passes |
| Existing public shared route | Stem Splitter | Refresh uses only the public audio projection and never requests private job or conversation routes |

Refresh and classroom workflows collect uncaught page errors and finish with an
empty collection. Offline failures and revoked access are deliberately injected
and shown as recoverable status messages. Tests assert overflow and usable
controls at widths 320, 360, 390, 414, 540, 768, 1024 and 1440. Course and sharing
selectors have actual rendered heights of at least 44 pixels in all three
engines. PR27's note-entry/speed-control spacing checks remain in the suite.

CSS layout zoom and native browser zoom are different checks. The native
Chromium test calls the browser's `tabs.setZoom(2)` in a disposable test profile,
asserts `getZoom() === 2`, doubled device-pixel ratio and reduced CSS viewport,
then checks the note/SAVE and speed controls. Its screenshot uses the browser's
visible-tab capture, not CSS zoom. Firefox and WebKit skip only this
Chromium-specific native-zoom test and retain their layout/interaction checks.

Screenshots are outside the repository under
`/tmp/stem-classroom-screenshots/`. Reviewable examples:

- `classroom-refresh-mobile-chrome.png`: note draft and Refresh failure state.
- `classroom-roster-folders-desktop-chrome.png`: zero-split roster and course work.
- `classroom-folder-detail-chrome.png`: scoped folder and sharing controls.
- `classroom-roster-folders-mobile-webkit.png`: narrow course/folder layout.
- `classroom-prompt-desktop-chrome.png`: saved course prompt controls.
- `classroom-native-browser-200-chromium.png`: actual 200% browser zoom.

These checks do not prove a real CUNY MFA return, live enrollment/owner state,
production permissions, real provider output or remote migration. Those remain
separate authorized release acceptance steps. No deployment or live migration
was performed.
