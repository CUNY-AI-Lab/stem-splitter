# Plan: Listening Guy — AI listening coach

**Design:** `docs/superpowers/specs/2026-07-24-listening-guy-design.md`
**Date:** 2026-07-24

Execution order; `npm run typecheck` after every backend task.

## Task 1 — Migration + schema

- `migrations/0003-assistant.sql`: `guides` table (`job_id` PK, `text`, `model`,
  `created_at`). Append the same table to `schema.sql`.
- `package.json`: `db:migrate:3` / `db:migrate:3:local` (copy the `:2` pattern).
- Verify: `npm run db:migrate:3:local` runs clean.

## Task 2 — Env plumbing

- `src/env.ts`: var `ASSISTANT_MODEL?: string`; secret `OPENROUTER_API_KEY: string`.
- `wrangler.jsonc`: `"ASSISTANT_MODEL": "z-ai/glm-5.2"` in `vars`; add the
  secret name to the secrets comment block.
- `.dev.vars.example`: `OPENROUTER_API_KEY=sk-or-your-openrouter-key`.
- Local `.dev.vars` gets the real key (gitignored).

## Task 3 — `src/assistant/` modules (types → openrouter → tools → prompt → index)

- `types.ts`: `AssistantContext { title, model, stems:[{name,label}],
  annotations:[{atSeconds,text}], durationSec?, mode }`, `ChatTurn`,
  `AssistantToolCall { name, args }`, OpenRouter wire types.
- `openrouter.ts`: `openRouterChat(env, { messages, tools?, maxTokens,
  temperature, retry429? })` plain fetch; `AssistantError { httpStatus,
  studentMessage }`; 60 s `AbortSignal.timeout`; status mapping per spec §4;
  one Retry-After-honoring 429 retry when `retry429`.
- `tools.ts`: `buildMixerTools(stemNames)` — 4 function schemas with per-job
  stem enums, no `strict`; `sanitizeToolCalls(raw, stemNames, durationSec?)` —
  JSON-parse args, allowlists, clamp seconds, trim note text to 200, cap 6.
- `prompt.ts`: the v2 Listening Guy prompt as `buildSystemPrompt(ctx)` (persona,
  splitter honesty, teaching approach, tool rules, fenced student data) +
  `buildGuideInstruction(ctx)` (guide mode ask). Canonical prompt home.
- `index.ts`: `contextFromJob(row, annotations, durationSec?, mode)`;
  `getOrCreateGuide(env, row, annotations, durationSec?)` (cache → generate →
  `ON CONFLICT DO NOTHING` upsert → re-SELECT; never cache empty);
  `runChat(env, row, annotations, turns, durationSec?)` (validate turns → call
  with tools → sanitize → `{ reply, toolCalls, finishReason }`).

## Task 4 — Routes (`src/index.ts`)

- `GuideRow` interface; guide SELECT in `GET /api/jobs/:id` when `done`;
  `jobResponse(row, annotations, guide)` emits `guide`.
- New `// --- listening guy ---` section: `POST /api/jobs/:id/guide` and
  `POST /api/jobs/:id/chat`, both `requireClassCode`; 404/409/503 checks before
  provider calls; `AssistantError` → `(studentMessage, httpStatus)`.
- Verify: typecheck + `npx wrangler deploy --dry-run --outdir dist`.

## Task 5 — Frontend (`public/app.js`, `public/styles.css`)

- Coach panel markup appended in `Mixer.build()` after the notes div; refs;
  `channelsByName` Map built in the stem loop.
- Methods: `renderGuide`, `requestGuide`, `duration`, `linkifyTimecodes`
  (esc-then-regex `\b\d+:[0-5]\d\b`), `sendChat` (12-turn client trim, typing
  row, error rows), `executeToolCalls` (sequential ~400 ms stagger; chips;
  `.coach-flash` in `var(--ch)`; aria-pressed sync), `saveNote` refactor shared
  with the ＋NOTE form.
- `styles.css`: `/* ─── listening guy ─── */` section, existing tokens only;
  coach form wraps in the 540px breakpoint.

## Task 6 — Ship

- `npm run db:migrate:3` (remote), `npx wrangler secret put OPENROUTER_API_KEY`
  (ailab login), `npm run deploy`.

## Task 7 — Verification + docs

- `scripts/smoke.sh`: free checks (guide sans code → 401; guide on zero-UUID →
  404; chat empty messages → 400) always; paid checks behind
  `SMOKE_ASSISTANT=1` + job id (guide 200 non-empty; second call
  `cached:true`; chat non-empty reply).
- Manual e2e checklist from the spec's Testing section.
- Update `CLAUDE.md` (feature, secret/var names, cost guardrails); hand-update
  untracked `V2.md`; paste the v2 prompt into the planning doc's Tab 2.
