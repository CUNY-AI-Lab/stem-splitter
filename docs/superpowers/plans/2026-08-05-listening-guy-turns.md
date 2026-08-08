# Plan: Listening Guy v3 — streaming, turn-taking, no markdown bleed

**Design:** `docs/superpowers/specs/2026-08-05-listening-guy-turns-design.md`
**Date:** 2026-08-05

Execution order; `npm run typecheck` after every backend task.

## Task 1 — Prompt v3 (`src/assistant/prompt.ts`)

- Add the "HOW YOU TALK" block (markdown ban, one idea per message, ball-back
  ending, 1-3 sentence chat replies).
- Rewrite the guide mode block as the ~80-word three-beat opener; drop CAPS
  headings, the song map, and the mascot sign-off.
- Teaching approach: song shape revealed one piece at a time; drop the old
  "small bites" rule (superseded by HOW YOU TALK).
- `buildGuideInstruction()` → "Write your opening message for this song now."

## Task 2 — Streaming client (`src/assistant/openrouter.ts`, `types.ts`)

- `types.ts`: add `WireStreamChunk` (delta content + indexed tool_call deltas).
- Extract shared status/error/429-retry handling into `openRouterFetch(env,
  params, stream)`; `requestOnce` gains a `stream` flag (`stream: true` body).
- Add `openRouterChatStream(env, params, onDelta)`: SSE line parse, forward
  `delta.content`, accumulate tool calls by index, return the aggregated
  `OpenRouterReply`. Mid-stream failures → `AssistantError(502)`.
- Export `COACH_UNCONFIGURED` (shared with the routes' pre-stream 503 guard).

## Task 3 — Orchestrators (`src/assistant/index.ts`)

- `getOrCreateGuide` → `streamGuide(..., onDelta)`; cache-hit returns without
  touching the sink; `maxTokens` 900 → 500; D1 upsert/winner logic unchanged.
- `runChat` → `streamChat(..., onDelta)`; narration follow-up streams through
  the same sink; sanitization and empty-reply guard unchanged.

## Task 4 — SSE routes (`src/index.ts`)

- `sseResponse(c, run)` helper: TransformStream + `waitUntil` pump; errors →
  `{type:'error'}` event; always close. Replaces `assistantFailure`.
- Both routes: explicit `COACH_UNCONFIGURED` 503 before streaming; existing
  401/404/409/400 JSON checks stay pre-stream; then emit `delta*` →
  (`tool_calls`) → `done` (done carries full text; guide adds
  `model`/`createdAt`/`cached`).

## Task 5 — Frontend (`public/app.js`, `public/styles.css`)

- `streamApi()` helper next to `api()`; `coachHtml()` next to `esc()`
  (escape-first markdown absorber + timecode buttons), replacing
  `linkifyTimecodes`.
- `requestGuide()`/`sendChat()` stream into live `.streaming` blocks
  (textContent), final formatted render from `done.text`; tool calls after.
- Previous-session archive: `coachChat:<jobId>` localStorage log (you/coach/
  action, cap 60), collapsed `EARLIER SESSION · n` block between guide and
  live log, caret toggle. CSS: streaming caret, archive toggle/log styles.
- Cue hint copy updated for streaming latency.

## Task 6 — Mixer seek robustness (`public/app.js`)

- `resync()`: skip a `seeking` master; skip followers that are `seeking` or
  `readyState < HAVE_FUTURE_DATA` (re-seeking a fetching stem restarts the
  fetch and silences it forever — the Psycho Killer drums bug).
- `seekTo()`: promote `preload` to `auto` before assigning `currentTime`.
- `play()` catch: pause all stems (no half-playing state behind ▶).

## Task 7 — Smoke + docs

- `scripts/smoke.sh`: assistant block parses SSE via `sse_last` (last `data:`
  line) and asserts on the `done` event.
- CLAUDE.md: Listening Guy paragraph reflects SSE + opener-style guide.
- Verify: `npm run typecheck`, `node --check public/app.js`,
  `bash -n scripts/smoke.sh`, `npm run test:e2e` (all green 2026-08-05).
- Post-deploy: `SMOKE_ASSISTANT=1 ./scripts/smoke.sh <done-job-id>`.
