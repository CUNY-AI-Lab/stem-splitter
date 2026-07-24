// Listening Guy orchestrators: cached guide generation + chat with validated
// mixer tool calls. Routes stay thin; everything provider-shaped lives here.
import type { Env } from '../env';
import { AssistantError, COACH_DOWN, openRouterChat } from './openrouter';
import { buildGuideInstruction, buildSystemPrompt } from './prompt';
import { buildMixerTools, sanitizeToolCalls } from './tools';
import type { AssistantContext, AssistantToolCall, ChatTurn, WireMessage } from './types';

export { AssistantError, COACH_DOWN };

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
  mode: 'guide' | 'chat'
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
    mode,
  };
}

export async function getGuide(env: Env, jobId: string): Promise<GuideRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM guides WHERE job_id = ?')
    .bind(jobId)
    .first<{ text: string; model: string; created_at: string }>();
  return row ? { text: row.text, model: row.model, createdAt: row.created_at } : null;
}

export async function getOrCreateGuide(
  env: Env,
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  durationSec?: number
): Promise<{ guide: GuideRecord; cached: boolean }> {
  const existing = await getGuide(env, row.id);
  if (existing) return { guide: existing, cached: true };

  const ctx = contextFromJob(row, annotations, durationSec, 'guide');
  const reply = await openRouterChat(env, {
    messages: [
      { role: 'system', content: buildSystemPrompt(ctx) },
      { role: 'user', content: buildGuideInstruction() },
    ],
    maxTokens: 900,
    temperature: 0.6,
    retry429: true,
  });
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

export async function runChat(
  env: Env,
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  turns: ChatTurn[],
  durationSec?: number
): Promise<ChatResult> {
  const ctx = contextFromJob(row, annotations, durationSec, 'chat');
  const stemNames = ctx.stems.map((s) => s.name);
  const messages: WireMessage[] = [{ role: 'system', content: buildSystemPrompt(ctx) }, ...turns];
  const reply = await openRouterChat(env, {
    messages,
    tools: buildMixerTools(stemNames),
    maxTokens: 400,
    temperature: 0.7,
  });
  const toolCalls = sanitizeToolCalls(reply.toolCalls, stemNames, durationSec);
  if (!reply.content && toolCalls.length === 0) throw new AssistantError(502, COACH_DOWN);
  return { reply: reply.content, toolCalls, finishReason: reply.finishReason };
}
