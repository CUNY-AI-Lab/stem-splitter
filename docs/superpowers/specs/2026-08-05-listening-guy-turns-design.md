# Design: Listening Guy v3 — streaming, turn-taking, no markdown bleed

**Date:** 2026-08-05
**Status:** Approved

## Goal

Revamp the coach around conversation instead of lecture. Three observed problems
with v2 (seen live on a Grateful Dead job):

1. **Markdown bleed-through** — the prompt asked for plain text, but GLM still
   emitted `**bold**`, which the escape-only renderer displayed literally.
2. **No streaming** — the guide took 10-20 silent seconds; chat replies landed
   as one block after a long wait.
3. **Long spiel** — the ~400-word sectioned guide (genre / listen-for / song
   map / mission) front-loaded everything, leaving nothing for the chat to do
   and nothing for the student to answer.

Plus one UX gap promoted to scope: the chat conversation lived only in memory,
so a reload silently discarded the previous session.

## Non-goals

- Server-persisted chat history (the conversation stays client-held and resent
  per call; the new archive is display-only localStorage).
- Regenerating existing cached guides (old long guides stay until their job
  ages out; new jobs get openers).
- A markdown renderer. The fix is prompt-level (ban) plus a tiny escape-first
  absorber for the common bleed patterns — not a md library.
- Cross-tab/live sync of the archive (same accepted limit as labels/notes).

## 1. Prompt v3 (`src/assistant/prompt.ts`)

- New "HOW YOU TALK" block, both modes: plain conversational text, markdown
  banned by name (no `**`, `#`, bullets, tables); ONE idea per message; every
  message ends handing the ball back (one question or one mixer move); chat
  replies 1-3 short sentences (<~50 words, no filler or recaps).
- Guide mode becomes an **opening message**, hard cap ~80 words, three beats:
  genre + what makes it tick (≤1 contrast) → ONE mixer move by current label →
  ONE question. Known-song context allowed in one line; opaque titles get one
  "let's figure it out by ear" sentence, not a plan. CAPS headings, song map,
  and mascot sign-off are gone.
- Teaching approach: song shape now explicitly revealed "one piece at a time
  as the conversation gets there," never as one big map.
- Budgets: guide `max_tokens` 900 → 500 (opener + reasoning headroom); chat
  unchanged at 600.

## 2. Streaming transport (SSE)

Both endpoints keep their paths and switch to `text/event-stream`, emitting
`data: <json>` events:

| event | payload | notes |
|---|---|---|
| `delta` | `{text}` | prose fragment, append in order |
| `tool_calls` | `{calls}` | chat only; validated calls, after all prose |
| `done` | `{text, finishReason, …}` | full final text; guide adds `model`, `createdAt`, `cached` |
| `error` | `{message}` | student-safe; terminal |

- `done` carrying the complete text keeps non-streaming consumers one-line
  simple (smoke greps the last `data:` line) and covers the guide race: the
  D1 winner may differ from what streamed, and `done` is authoritative.
- Pre-stream failures keep real HTTP statuses: 401 class code, 404/409
  validation, and a new explicit config guard so unconfigured deployments
  still 503 (documented behavior) instead of erroring in-stream. Provider
  failures after headers necessarily arrive as `error` events.
- `openrouter.ts` gains `openRouterChatStream(env, params, onDelta)`: shared
  status/error/429-retry handling with the non-streaming path (extracted as
  `openRouterFetch`), SSE parse of `delta.content` (forwarded) and
  `delta.tool_calls` (accumulated by index; usable only at stream end).
- `getOrCreateGuide`/`runChat` become `streamGuide`/`streamChat` with an
  `onDelta` sink. Cached guide returns without touching the sink. The
  tools-only narration follow-up streams through the same sink.
- Routes use a `sseResponse` helper: `TransformStream` + `waitUntil` pump,
  catch → `error` event, always close. Cached guide emits `done` only.

## 3. Frontend (`public/app.js`)

- `streamApi(path, body, onEvent)`: fetch + reader, `data:` line parse, same
  401/JSON-error mapping as `api()`; throws on `error` events.
- Guide: cue swaps to a live `.coach-guide-text.streaming` block on first
  delta (blinking caret via CSS), plain `textContent` while streaming, final
  render through `coachHtml`. Errors restore the cue; partial text discarded.
- Chat: typing row converts to a streaming coach row on first delta; on done
  the row re-renders formatted, history updates from `done.text`, then tool
  calls execute with the existing stagger.
- `coachHtml(text)` replaces `linkifyTimecodes`: escape-first, then absorb
  `**bold**` → `<strong>`, `*italic*` → `<em>`, strip `` ` ``/headings,
  `-`/`*` bullets → `•`, then the existing m:ss seek buttons. Untrusted text
  never reaches `innerHTML` unescaped.

## 4. Previous-session archive

- Every durable conversation entry (`you`, `coach`, `action` chips — not
  typing/error rows) also appends to `localStorage["coachChat:<jobId>"]`,
  capped at the last 60 entries.
- On mixer build, existing entries render into a collapsed `EARLIER SESSION ·
  n` block between guide and live log; toggle reopens it. Rows reuse
  `coach-row` classes at reduced opacity; timecode buttons keep working via
  the existing delegated handler.
- Model context still starts fresh per page load — the archive is what the
  student can re-read, not what the coach remembers.

## 5. Mixer seek robustness (bug found via coach tool use)

Field report (Psycho Killer, Internet Archive source): after the coach seeked
near a drum drop-out, the drums stem went permanently silent on resume. Root
cause: `resync()` snapped any stem >80 ms behind the master every 500 ms —
but a stem still fetching after a jump is *always* behind, and each re-seek
restarted its fetch, so it never buffered enough to play. Fixes:

- `resync()` skips the master while it is `seeking`, and skips followers that
  are `seeking` or below `HAVE_FUTURE_DATA` — a buffering stem gets to finish.
- `seekTo()` promotes `preload` to `auto` so paused coach-seeks start
  buffering the target region before the student hits play.
- `play()` failure now pauses all stems, so a partial start can't leave audio
  running behind a ▶ button.

## 6. Compatibility

- `scripts/smoke.sh` assistant block parses SSE (`sse_last` = last `data:`
  line) and asserts on the `done` event; unconfigured 503 skip unchanged.
- e2e untouched (it never exercised assistant endpoints).
- `GET /api/jobs/:id` guide ride-along unchanged; cached guides keep flowing
  to `renderGuide()` exactly as before.
