// Plain-fetch OpenRouter client (OpenAI-compatible chat completions).
// No SDK on purpose: one endpoint, one auth header, and every provider
// failure maps to a student-safe message; detail goes to `bun run wrangler -- tail`.
import type { Env } from '../env';
import type { WireCompletion, WireMessage, WireStreamChunk, WireTool, WireToolCall } from './types';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;
const STREAM_RETRY_DELAY_MS = 250;
const MAX_MODEL_ROUTES = 4;

// Independent, inexpensive tool-capable routes. An explicitly empty
// ASSISTANT_FALLBACK_MODELS disables these defaults; otherwise a deployment
// gains cross-model failover without needing another credential.
export const DEFAULT_ASSISTANT_FALLBACK_MODELS = [
  'anthropic/claude-haiku-4.5',
  'google/gemini-3-flash-preview',
] as const;

export const COACH_DOWN =
  'The Listening Guide is unavailable right now — the mixer still works. Try again later.';
export const COACH_UNCONFIGURED = "The Listening Guide isn't set up yet — tell your instructor.";

/** Errors whose studentMessage is safe to show verbatim (cf. YouTubeError). */
export class AssistantError extends Error {
  httpStatus: 502 | 503;
  studentMessage: string;
  constructor(httpStatus: 502 | 503, studentMessage: string) {
    super(studentMessage);
    this.httpStatus = httpStatus;
    this.studentMessage = studentMessage;
  }
}

export interface OpenRouterParams {
  messages: WireMessage[];
  tools?: WireTool[];
  maxTokens: number;
  temperature: number;
  /** Retry a 429 once, honoring Retry-After (used on the guide path). */
  retry429?: boolean;
}

export interface OpenRouterReply {
  content: string;
  toolCalls: WireToolCall[];
  finishReason: string;
  model: string;
}

/** Primary-first model order, de-duplicated and bounded for one request. */
export function assistantModelOrder(env: Pick<Env, 'ASSISTANT_MODEL' | 'ASSISTANT_FALLBACK_MODELS'>): string[] {
  const primary = env.ASSISTANT_MODEL?.trim();
  if (!primary) return [];
  const configured = env.ASSISTANT_FALLBACK_MODELS;
  const fallbacks = configured === undefined
    ? DEFAULT_ASSISTANT_FALLBACK_MODELS
    : configured.split(',').map((value) => value.trim()).filter(Boolean);
  return [...new Set([primary, ...fallbacks])].slice(0, MAX_MODEL_ROUTES);
}

export async function openRouterChat(env: Env, params: OpenRouterParams): Promise<OpenRouterReply> {
  const res = await openRouterFetch(env, params, false);
  const body = (await res.json().catch(() => null)) as WireCompletion | null;
  const choice = body?.choices?.[0];
  if (!choice?.message) {
    console.error('openrouter malformed response', JSON.stringify(body).slice(0, 500));
    throw new AssistantError(502, COACH_DOWN);
  }
  return {
    content: (choice.message.content ?? '').trim(),
    toolCalls: choice.message.tool_calls ?? [],
    finishReason: choice.finish_reason || 'stop',
    model: body?.model || assistantModelOrder(env)[0] || 'unknown',
  };
}

/**
 * Streaming variant: `onDelta` fires for each prose fragment as it arrives;
 * the returned reply is the fully accumulated result (tool calls only become
 * usable once the stream ends). Setup failures (auth, credits, 429) throw
 * before any delta, so callers can still map them to real HTTP statuses.
 */
export async function openRouterChatStream(
  env: Env,
  params: OpenRouterParams,
  onDelta: (text: string) => void | Promise<void>
): Promise<OpenRouterReply> {
  // A provider can accept the request (HTTP 200) and then return an empty or
  // broken SSE body. That was previously surfaced immediately to students.
  // Retry once only when no prose has escaped to the browser; the retry puts
  // an independent fallback model first. Never replay a partial answer.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await readOpenRouterStream(env, params, onDelta, attempt > 0);
    } catch (err) {
      if (!(err instanceof RetryableStreamStartError) || attempt > 0) {
        if (err instanceof RetryableStreamStartError) {
          console.error('openrouter pre-content stream failure exhausted', err.reason);
          throw new AssistantError(502, COACH_DOWN);
        }
        throw err;
      }
      console.error('openrouter pre-content stream failure, retrying', err.reason);
      await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_DELAY_MS));
    }
  }
  throw new AssistantError(502, COACH_DOWN);
}

class RetryableStreamStartError extends Error {
  readonly reason: 'missing-body' | 'provider-error' | 'read-error' | 'incomplete' | 'empty';

  constructor(reason: 'missing-body' | 'provider-error' | 'read-error' | 'incomplete' | 'empty') {
    super(reason);
    this.reason = reason;
  }
}

async function readOpenRouterStream(
  env: Env,
  params: OpenRouterParams,
  onDelta: (text: string) => void | Promise<void>,
  preferFallback: boolean
): Promise<OpenRouterReply> {
  const res = await openRouterFetch(env, params, true, preferFallback);
  if (!res.body) throw new RetryableStreamStartError('missing-body');

  let content = '';
  const toolCalls: WireToolCall[] = [];
  let finishReason = '';
  let terminal = false;
  let visibleOutput = false;
  let model = orderedModels(env, preferFallback)[0] || 'unknown';
  const reader = res.body.getReader();

  try {
    const decoder = new TextDecoder();
    let buf = '';
    while (!terminal) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while (!terminal && (nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data: ')) continue; // ignore comments/blank keep-alives
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          terminal = true;
          continue;
        }
        let chunk: WireStreamChunk;
        try {
          chunk = JSON.parse(payload) as WireStreamChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          console.error('openrouter stream provider error', chunk.error.code ?? 'unknown');
          if (!visibleOutput) throw new RetryableStreamStartError('provider-error');
          throw new AssistantError(502, COACH_DOWN);
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          terminal = true;
        }
        if (choice.delta?.content) {
          content += choice.delta.content;
          // Mark it before awaiting the transport sink: if the browser has
          // disconnected mid-write, replay safety is unknowable.
          visibleOutput = true;
          await onDelta(choice.delta.content);
        }
        for (const d of choice.delta?.tool_calls ?? []) {
          const i = d.index ?? 0;
          const slot = (toolCalls[i] ??= { id: d.id, type: 'function', function: { name: '', arguments: '' } });
          if (d.function?.name) slot.function!.name = d.function.name;
          if (d.function?.arguments) slot.function!.arguments = (slot.function!.arguments ?? '') + d.function.arguments;
        }
      }
    }
  } catch (err) {
    if (err instanceof RetryableStreamStartError || err instanceof AssistantError) throw err;
    console.error('openrouter stream error', err);
    if (!visibleOutput) throw new RetryableStreamStartError('read-error');
    throw new AssistantError(502, COACH_DOWN);
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!terminal) {
    console.error('openrouter stream ended without a terminal event');
    if (!visibleOutput) throw new RetryableStreamStartError('incomplete');
    throw new AssistantError(502, COACH_DOWN);
  }
  const completeToolCalls = toolCalls.filter(Boolean);
  if (!content.trim() && completeToolCalls.length === 0) {
    throw new RetryableStreamStartError('empty');
  }
  return {
    content: content.trim(),
    toolCalls: completeToolCalls,
    finishReason: finishReason || 'stop',
    model,
  };
}

/** Shared request/status handling for both modes; resolves only on 2xx. */
async function openRouterFetch(
  env: Env,
  params: OpenRouterParams,
  stream: boolean,
  preferFallback = false
): Promise<Response> {
  if (!env.OPENROUTER_API_KEY || !env.ASSISTANT_MODEL) {
    throw new AssistantError(503, COACH_UNCONFIGURED);
  }

  // One quiet retry absorbs transient provider flakes (dropped connections,
  // 5xx blips, and — on the guide path — burst 429s). This runs before any
  // stream bytes reach the student, so a retry can never double-speak.
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await requestOnce(env, params, stream, preferFallback);
    } catch (err) {
      console.error('openrouter network error', err);
      if (attempt > 0) throw new AssistantError(502, COACH_DOWN);
      await new Promise((r) => setTimeout(r, 1_500));
      continue;
    }
    const transient = res.status >= 500 || (res.status === 429 && params.retry429);
    if (!transient || attempt > 0) break;
    console.error('openrouter transient status, retrying', res.status);
    if (res.body) void res.body.cancel().catch(() => {});
    const waitSec = Math.min(Number(res.headers.get('retry-after')) || 2, 10);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }

  if (!res.ok) {
    console.error('openrouter error', res.status, await res.text().catch(() => ''));
    if (res.status === 401 || res.status === 403) {
      throw new AssistantError(502, "The Listening Guide can't sign in — tell your instructor.");
    }
    if (res.status === 402) {
      throw new AssistantError(502, 'The Listening Guide is out of credits — tell your instructor.');
    }
    if (res.status === 429) {
      throw new AssistantError(503, 'The Listening Guide is swamped — try again in a few seconds.');
    }
    throw new AssistantError(502, COACH_DOWN);
  }
  return res;
}

function orderedModels(env: Env, preferFallback: boolean): string[] {
  const models = assistantModelOrder(env);
  return preferFallback && models.length > 1 ? [...models.slice(1), models[0]] : models;
}

function requestOnce(
  env: Env,
  { messages, tools, maxTokens, temperature }: OpenRouterParams,
  stream = false,
  preferFallback = false
): Promise<Response> {
  const models = orderedModels(env, preferFallback);
  return fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // Optional OpenRouter attribution headers.
      'HTTP-Referer': env.PUBLIC_BASE_URL,
      'X-Title': 'Stem Splitter',
    },
    body: JSON.stringify({
      ...(models.length > 1 ? { models } : { model: models[0] }),
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      ...(stream ? { stream: true } : {}),
      max_tokens: maxTokens,
      temperature,
      // Route only to providers that don't retain/train on prompts (class data).
      provider: {
        data_collection: 'deny',
        allow_fallbacks: true,
        ...(tools?.length ? { require_parameters: true } : {}),
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
