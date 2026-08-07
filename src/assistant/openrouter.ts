// Plain-fetch OpenRouter client (OpenAI-compatible chat completions).
// No SDK on purpose: one endpoint, one auth header, and every provider
// failure maps to a student-safe message; detail goes to `bun run wrangler -- tail`.
import type { Env } from '../env';
import type { WireCompletion, WireMessage, WireTool, WireToolCall } from './types';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;

export const COACH_DOWN =
  'The listening coach is unavailable right now — the mixer still works. Try again later.';

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
  if (!env.OPENROUTER_API_KEY || !env.ASSISTANT_MODEL) {
    throw new AssistantError(503, "The listening coach isn't set up yet — tell your instructor.");
  }

  let res: Response;
  try {
    res = await requestOnce(env, params);
    if (res.status === 429 && params.retry429) {
      const waitSec = Math.min(Number(res.headers.get('retry-after')) || 2, 10);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      res = await requestOnce(env, params);
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

function requestOnce(env: Env, { messages, tools, maxTokens, temperature }: OpenRouterParams): Promise<Response> {
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
      max_tokens: maxTokens,
      temperature,
      // Route only to providers that don't retain/train on prompts (class data).
      provider: { data_collection: 'deny' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
