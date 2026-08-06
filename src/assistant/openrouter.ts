// Plain-fetch OpenRouter client (OpenAI-compatible chat completions).
// No SDK on purpose: one endpoint, one auth header, and every provider
// failure maps to a student-safe message; detail goes to `wrangler tail`.
import type { Env } from '../env';
import type { WireCompletion, WireMessage, WireStreamChunk, WireTool, WireToolCall } from './types';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;

export const COACH_DOWN =
  'The listening coach is unavailable right now — the mixer still works. Try again later.';
export const COACH_UNCONFIGURED = "The listening coach isn't set up yet — tell your instructor.";

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
  const res = await openRouterFetch(env, params, true);
  if (!res.body) throw new AssistantError(502, COACH_DOWN);

  let content = '';
  const toolCalls: WireToolCall[] = [];
  let finishReason = 'stop';

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data: ')) continue; // ignore comments/blank keep-alives
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        let chunk: WireStreamChunk;
        try {
          chunk = JSON.parse(payload) as WireStreamChunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.delta?.content) {
          content += choice.delta.content;
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
    console.error('openrouter stream error', err);
    throw new AssistantError(502, COACH_DOWN);
  }

  return { content: content.trim(), toolCalls: toolCalls.filter(Boolean), finishReason };
}

/** Shared request/status handling for both modes; resolves only on 2xx. */
async function openRouterFetch(env: Env, params: OpenRouterParams, stream: boolean): Promise<Response> {
  if (!env.OPENROUTER_API_KEY || !env.ASSISTANT_MODEL) {
    throw new AssistantError(503, COACH_UNCONFIGURED);
  }

  let res: Response;
  try {
    res = await requestOnce(env, params, stream);
    if (res.status === 429 && params.retry429) {
      const waitSec = Math.min(Number(res.headers.get('retry-after')) || 2, 10);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      res = await requestOnce(env, params, stream);
    }
  } catch (err) {
    console.error('openrouter network error', err);
    throw new AssistantError(502, COACH_DOWN);
  }

  if (!res.ok) {
    console.error('openrouter error', res.status, await res.text().catch(() => ''));
    if (res.status === 401 || res.status === 403) {
      throw new AssistantError(502, "The listening coach can't sign in — tell your instructor.");
    }
    if (res.status === 402) {
      throw new AssistantError(502, 'The listening coach is out of credits — tell your instructor.');
    }
    if (res.status === 429) {
      throw new AssistantError(503, 'The coach is swamped — try again in a few seconds.');
    }
    throw new AssistantError(502, COACH_DOWN);
  }
  return res;
}

function requestOnce(env: Env, { messages, tools, maxTokens, temperature }: OpenRouterParams, stream = false): Promise<Response> {
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
      model: env.ASSISTANT_MODEL,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      ...(stream ? { stream: true } : {}),
      max_tokens: maxTokens,
      temperature,
      // Route only to providers that don't retain/train on prompts (class data).
      provider: { data_collection: 'deny' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
