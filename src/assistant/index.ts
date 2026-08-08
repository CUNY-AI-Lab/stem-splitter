// Listening Guy orchestrators: cached guide generation + chat with validated
// mixer tool calls, both streaming prose through an onDelta sink while the
// caller owns the transport (SSE). Routes stay thin; everything
// provider-shaped lives here.
import type { Env } from '../env';
import { AssistantError, COACH_DOWN, COACH_UNCONFIGURED, openRouterChatStream } from './openrouter';
import { buildGuideInstruction, buildSystemPrompt, fmtTime } from './prompt';
import { buildMixerTools, sanitizeToolCalls } from './tools';
import type { AssistantContext, AssistantToolCall, ChatTurn, WireMessage } from './types';

export { AssistantError, COACH_DOWN, COACH_UNCONFIGURED };

const MAX_TURNS = 12;
const MAX_TURN_CHARS = 2000;

/** The slice of a JobRow the assistant needs (avoids importing route types). */
export interface AssistantJob {
  id: string;
  filename: string;
  model: string | null;
  stems: string | null; // JSON [{ name, key }]
  labels: string | null; // JSON map
}

export interface AssistantAnnotation {
  at_seconds: number;
  text: string;
}

export interface GuideRecord {
  text: string;
  model: string;
  createdAt: string;
}

export function contextFromJob(
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  durationSec: number | undefined,
  mode: 'guide' | 'chat',
  amendment = ''
): AssistantContext {
  const labels = row.labels ? (JSON.parse(row.labels) as Record<string, string>) : {};
  const stems = (row.stems ? (JSON.parse(row.stems) as { name: string }[]) : []).map((s) => ({
    name: s.name,
    label: labels[s.name] || s.name,
  }));
  return {
    title: row.filename,
    model: row.model ?? 'htdemucs_ft',
    stems,
    annotations: annotations.map((a) => ({ atSeconds: a.at_seconds, text: a.text })),
    durationSec,
    amendment,
    mode,
  };
}

/**
 * The instructor amendment lives in assistant_settings. It is read per call
 * rather than cached in module scope so an edit takes effect on the next
 * request instead of at the next isolate recycle. Missing table (a deployment
 * that has not run migration 0004) degrades to no amendment.
 */
async function loadAmendment(env: Env): Promise<string> {
  try {
    const row = await env.DB.prepare(
      'SELECT amendment FROM assistant_settings WHERE id = 1'
    ).first<{ amendment: string }>();
    return row?.amendment ?? '';
  } catch (err) {
    console.error('assistant amendment lookup failed', err);
    return '';
  }
}

export async function getGuide(env: Env, jobId: string): Promise<GuideRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM guides WHERE job_id = ?')
    .bind(jobId)
    .first<{ text: string; model: string; created_at: string }>();
  return row ? { text: row.text, model: row.model, createdAt: row.created_at } : null;
}

/**
 * Stream the guide (a short conversation opener) through `onDelta`, caching it
 * in D1 once complete. A cached guide returns immediately without touching
 * `onDelta` — the caller ships the full text in its final event instead.
 */
export async function streamGuide(
  env: Env,
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  durationSec: number | undefined,
  onDelta: (text: string) => void | Promise<void>
): Promise<{ guide: GuideRecord; cached: boolean }> {
  const existing = await getGuide(env, row.id);
  if (existing) return { guide: existing, cached: true };

  const ctx = contextFromJob(row, annotations, durationSec, 'guide', await loadAmendment(env));
  const reply = await openRouterChatStream(
    env,
    {
      messages: [
        { role: 'system', content: buildSystemPrompt(ctx) },
        { role: 'user', content: buildGuideInstruction() },
      ],
      maxTokens: 500, // the opener is ~110 words; the rest is reasoning headroom
      temperature: 0.6,
      retry429: true,
    },
    onDelta
  );
  if (!reply.content) throw new AssistantError(502, COACH_DOWN); // never cache an empty guide

  // Two students racing converge on one canonical row (last SELECT wins for both).
  await env.DB.prepare(
    'INSERT INTO guides (job_id, text, model) VALUES (?, ?, ?) ON CONFLICT(job_id) DO NOTHING'
  )
    .bind(row.id, reply.content, env.ASSISTANT_MODEL ?? 'unknown')
    .run();
  const winner = await getGuide(env, row.id);
  if (!winner) throw new AssistantError(502, COACH_DOWN); // unreachable after upsert
  return { guide: winner, cached: false };
}

export interface ChatResult {
  reply: string;
  toolCalls: AssistantToolCall[];
  finishReason: string;
}

/** Validate the client-held conversation; null means 400. */
export function validateTurns(value: unknown): ChatTurn[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURNS) return null;
  const turns: ChatTurn[] = [];
  for (const item of value) {
    const t = item as { role?: unknown; content?: unknown } | null;
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string') return null;
    const content = t.content.trim();
    if (!content || content.length > MAX_TURN_CHARS) return null;
    turns.push({ role: t.role, content });
  }
  if (turns[turns.length - 1].role !== 'user') return null;
  return turns;
}

/**
 * Stream a chat reply through `onDelta`; tool calls are only known once the
 * stream ends, so the caller emits them after the prose. A tools-only reply
 * gets its narration follow-up streamed through the same sink.
 */
export async function streamChat(
  env: Env,
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  turns: ChatTurn[],
  durationSec: number | undefined,
  onDelta: (text: string) => void | Promise<void>
): Promise<ChatResult> {
  const ctx = contextFromJob(row, annotations, durationSec, 'chat', await loadAmendment(env));
  const stemNames = ctx.stems.map((s) => s.name);
  const messages: WireMessage[] = [{ role: 'system', content: buildSystemPrompt(ctx) }, ...turns];
  const reply = await openRouterChatStream(
    env,
    {
      messages,
      tools: buildMixerTools(stemNames),
      maxTokens: 600, // reasoning models spend part of the budget before the reply
      temperature: 0.7,
    },
    onDelta
  );
  const toolCalls = sanitizeToolCalls(reply.toolCalls, stemNames, durationSec);
  if (!reply.content && toolCalls.length === 0) throw new AssistantError(502, COACH_DOWN);

  // Tool-calling models often act without narrating, but the narration IS the
  // coaching. One cheap tool-free follow-up turns the console moves into prose;
  // if it fails, degrade to action-chips-only rather than failing the request.
  let content = reply.content;
  if (!content && toolCalls.length > 0) {
    try {
      const followUp = await openRouterChatStream(
        env,
        {
          messages: [
            ...messages,
            { role: 'assistant', content: `[console] I just did this on the mixer: ${toolCalls.map(describeCall).join('; ')}.` },
            { role: 'user', content: 'In one or two short sentences, tell me what you just did and what I should listen for.' },
          ],
          maxTokens: 300,
          temperature: 0.7,
        },
        onDelta
      );
      content = followUp.content;
    } catch (err) {
      console.error('narration follow-up failed', err);
    }
  }
  return { reply: content, toolCalls, finishReason: reply.finishReason };
}

function describeCall({ name, args }: AssistantToolCall): string {
  if (name === 'solo') return `soloed the "${String(args.stem)}" channel`;
  if (name === 'set_mute') return `${args.muted ? 'muted' : 'unmuted'} the "${String(args.stem)}" channel`;
  if (name === 'seek') return `jumped playback to ${fmtTime(Number(args.seconds))}`;
  return `pinned a class note at ${fmtTime(Number(args.seconds))}`;
}
