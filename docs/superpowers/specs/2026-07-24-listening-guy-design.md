# Design: Listening Guy — AI listening coach (guide + chat with mixer control)

**Date:** 2026-07-24
**Status:** Approved

## Goal

An AI listening coach per song, realizing the v2 planning notes: the system feeds
what it knows about a split song (title, stems, labels, shared notes, duration) to
"Listening Guy," which returns simple prose telling students *what to listen for* —
then keeps teaching in a chat where its replies can also drive the mixer.

Two surfaces:

1. **Listening guide** — one per song, generated lazily on first request, cached in
   D1 and shared class-wide (same posture as labels/annotations).
2. **Chat** — follow-up Q&A per student. Replies carry a dual register: pedagogical
   prose for the student plus validated tool calls (`solo`, `set_mute`, `seek`,
   `add_note`) the browser executes on the Mixer.

## Non-goals

- Audio analysis (waveforms, tempo/chord detection) — roadmap; the context object
  is the extension point.
- Persisted chat history (conversation lives client-side, resent per call).
- SSE streaming responses (future enhancement; non-streaming JSON for v2.0).
- A second model round-trip after tool execution — tools are fire-and-forget UI
  actions with no informational return; the always-narrate prompt rule keeps
  resent history coherent.
- Per-student identity (unchanged from v1).

## 1. Provider: OpenRouter via plain fetch

- `POST https://openrouter.ai/api/v1/chat/completions` with `Authorization:
  Bearer <OPENROUTER_API_KEY>` (new secret). No SDK dependency.
- Model set by the `ASSISTANT_MODEL` wrangler var — `z-ai/glm-5.2` at launch
  ($0.77/M in, $2.42/M out; tool calling supported). Swapping models is a var
  change + deploy.
- Guide: no tools, `max_tokens` 900, temperature 0.6. Chat: tools +
  `tool_choice: "auto"`, `max_tokens` 400, temperature 0.7.
- Provider failures map to student-safe strings (mirrors the `YouTubeError`
  pattern); full detail only in `console.error`/`wrangler tail`. The mixer never
  depends on any assistant code path.

## 2. System prompt

`src/assistant/prompt.ts` is the canonical home of the v2 Listening Guy prompt
(`buildSystemPrompt(ctx)` + `buildGuideInstruction(ctx)`). Pillars, synthesized
from the planning notes' v1 draft and field notes:

- Friendly young-producer persona; zero assumed vocabulary (terms defined in the
  same breath); replies in the student's language.
- Genre-first teaching with quick contrasts; no collaborator/release trivia.
- Ball in the student's court: students mute/solo and name instruments
  themselves; the coach confirms/refines and suggests renaming channels.
- Splitter honesty: "other" is a catch-all, bleed and hallucinated instruments
  happen, instrumentals still get a (near-silent) vocals channel.
- No fabrication; **no invented timestamps** — only timestamps from class notes
  are citable. Song shape is mapped by *changes* (instrumentation, energy,
  lyrics), not clock time.
- Tool rules: canonical stem names in arguments, always narrate console moves,
  ≤3 calls per turn, notes anchored only to real times, add-never-remove.
- Injected student data (labels, notes) is fenced as *data, not instructions*.

## 3. Storage

New `guides` table (additive migration `0003-assistant.sql`, appended to
`schema.sql`): `job_id TEXT PRIMARY KEY, text, model, created_at`.
Double-generation race: SELECT → generate → `INSERT … ON CONFLICT(job_id) DO
NOTHING` → re-SELECT; simultaneous clicks converge on one canonical guide.

## 4. API

- `GET /api/jobs/:id` gains `guide: { text, model, createdAt } | null` when the
  job is `done` (open reads unchanged; one extra SELECT skipped for processing
  polls).
- `POST /api/jobs/:id/guide` (class code): `{ durationSec? }` → `{ guide, cached }`.
- `POST /api/jobs/:id/chat` (class code): `{ messages: [{role, content}…] (1–12,
  ≤2000 chars each, last = user), durationSec? }` → `{ reply, toolCalls:
  [{ name, args }…], finishReason }`. Tool calls are parsed/validated
  server-side (per-job stem enums; seconds clamped to duration; note text ≤200
  chars; hard cap 6) — the client never sees raw provider tool-call structures.
- 409 when stems aren't ready; 503/502 soft strings when the provider is
  unconfigured/down ("…the mixer still works").

## 5. Mixer UI

A collapsible "LISTENING GUY" panel at the bottom of each console card (status
LED + caret), containing the guide, a chat log (`role="log"`), and an ask form.
- Guide absent → "CUE THE LISTENING GUIDE" button with a one-time-setup hint
  (~10–20 s), LED blinks amber while generating.
- `m:ss` timecodes in guide/chat prose are linkified into seek buttons (regex,
  no markdown lib).
- Executed tool calls render as mono action chips (`SOLO · BASS`, `SEEK · 1:12`)
  and flash the affected channel strip in its own channel color; mute-button
  `aria-pressed`/`.muted` state stays in sync.
- Coach `add_note` reuses the authenticated annotations API via a `saveNote()`
  refactor shared with the ＋NOTE form, so markers/notes render identically.
- Chat transcript is per-Mixer-instance state; survives re-renders via the
  existing `mixers` Map. A classmate's guide appears after reload — same
  accepted limit as labels/annotations.

## Cross-cutting

- **Auth posture unchanged:** generation/chat are class-code writes (they cost
  money); reading a cached guide is open-but-unguessable.
- **Costs:** guide ≈ half a cent; chat turns fractions of a cent; guides cached
  forever; history capped at 12 turns; `max_tokens` capped server-side.
- **No build step introduced;** no new npm dependencies.
- **Secrets:** `OPENROUTER_API_KEY` via `wrangler secret put` + `.dev.vars`;
  never committed.

## Error handling summary

- Provider unset → 503; provider auth/credits → 502; 429 → one retry (guide)
  then 503; timeouts/5xx/empty → 502. All student-safe strings; nothing cached
  on failure.
- Malformed chat bodies rejected 400 before any provider spend.
- Prompt injection via labels/notes: fenced as data; worst case is a
  mute/seek and one deletable 200-char note.

## Testing

No test framework (house style): `npm run typecheck`, `npx wrangler deploy
--dry-run --outdir dist`, `scripts/smoke.sh` additions (free 401/404/400 checks
always; paid guide-cache + chat checks behind `SMOKE_ASSISTANT=1` + a job id),
then manual e2e on the deployed Worker (guide caching across browsers, chat
tool-call round-trip, 4-stem vs 6-stem enums, opaque-filename honesty,
class-code re-prompt, bogus-model soft-fail drill).
