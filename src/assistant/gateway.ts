// CAIL owns provider transport, quota, and routing for the Listening Guide.
import { CailError, createCailClient, extractCailError } from '@cuny-ai-lab/cail-client';
import type { Env } from '../env';
import type { WireMessage, WireStreamChunk, WireTool, WireToolCall } from './types';

const TIMEOUT_MS = 60_000;
export const COACH_DOWN = 'The Listening Guide is unavailable right now — the mixer still works. Try again later.';
export const COACH_UNCONFIGURED = "The Listening Guide isn't set up yet — tell your instructor.";

export class AssistantError extends Error {
  httpStatus: 502 | 503;
  studentMessage: string;
  requestId?: string;
  constructor(httpStatus: 502 | 503, studentMessage: string, requestId?: string) {
    super(studentMessage);
    this.httpStatus = httpStatus;
    this.studentMessage = studentMessage;
    this.requestId = requestId;
  }
}

export interface GatewayParams {
  messages: WireMessage[];
  tools?: WireTool[];
  maxTokens: number;
  temperature: number;
}
export interface GatewayReply {
  content: string;
  model: string;
  usage?: Record<string, number>;
  requestId?: string;
  toolCalls: WireToolCall[];
  finishReason: string;
}

function safeError(error: unknown, fallbackRequestId?: string): AssistantError {
  const id = error instanceof CailError ? error.extras.request_id : undefined;
  const requestId = typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : undefined;
  return new AssistantError(error instanceof CailError && error.status === 429 ? 503 : 502, COACH_DOWN, requestId ?? fallbackRequestId);
}

/** Drain through terminal usage/error events, including events after finish_reason. */
export async function gatewayChatStream(
  env: Env,
  params: GatewayParams,
  onDelta: (text: string) => void | Promise<void>
): Promise<GatewayReply> {
  if (!env.CAIL_GATEWAY_IDENTITY_JWT || !env.CAIL_GATEWAY_URL || !env.ASSISTANT_MODEL) {
    throw new AssistantError(503, COACH_UNCONFIGURED);
  }
  const signal = env.CAIL_ABORT_SIGNAL
    ? AbortSignal.any([env.CAIL_ABORT_SIGNAL, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  let requestId: string | undefined;
  try {
    const client = createCailClient({ app: 'stem-splitter', baseUrl: env.CAIL_GATEWAY_URL, allowInsecureLoopback: env.LOCAL_DEV === '1' });
    const response = await client.chatCompletions({
      model: env.ASSISTANT_MODEL,
      messages: params.messages.map(({ role, content }) => ({ role, content })),
      ...(params.tools?.length ? { tools: params.tools.map((tool) => ({ type: tool.type, function: { ...tool.function, parameters: JSON.parse(JSON.stringify(tool.function.parameters)) } })), tool_choice: 'auto' } : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.maxTokens,
      temperature: params.temperature,
    }, { kind: 'jwt', token: env.CAIL_GATEWAY_IDENTITY_JWT }, {
      signal,
      sessionId: env.CAIL_CONVERSATION_ID,
      correlation: env.CAIL_CORRELATION,
    });
    const rawRequestId = response.headers.get('x-cail-request-id');
    requestId = rawRequestId && /^[a-zA-Z0-9_-]{1,128}$/.test(rawRequestId) ? rawRequestId : undefined;
    if (!response.body) throw new AssistantError(502, COACH_DOWN);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = env.ASSISTANT_MODEL;
    let finishReason = 'stop';
    let usage: Record<string, number> | undefined;
    let finished = false;
    const toolCalls = new Map<number, WireToolCall>();
    const consume = async (event: string) => {
      const payload = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') return;
      const parsed: unknown = JSON.parse(payload);
      const gatewayError = extractCailError(parsed);
      if (gatewayError) throw gatewayError;
      if (typeof parsed !== 'object' || parsed === null || 'error' in parsed) throw new AssistantError(502, COACH_DOWN);
      if ('usage' in parsed && typeof parsed.usage === 'object' && parsed.usage !== null) {
        usage = Object.fromEntries(Object.entries(parsed.usage).filter(([key, value]) =>
          ['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0));
      }
      const chunk = parsed as WireStreamChunk;
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices?.[0];
      if (!choice) return; // trailing usage has no choice
      if (choice.finish_reason === 'error') throw new AssistantError(502, COACH_DOWN);
      if (choice.finish_reason) { finishReason = choice.finish_reason; finished = true; }
      if (choice.delta?.content) {
        content += choice.delta.content;
        await onDelta(choice.delta.content);
      }
      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = delta.index;
        if (index === undefined || !Number.isSafeInteger(index) || index < 0) throw new AssistantError(502, COACH_DOWN);
        const slot = toolCalls.get(index) ?? { type: 'function', function: { name: '', arguments: '' } };
        if (delta.id) slot.id = delta.id;
        if (delta.function?.name) slot.function!.name += delta.function.name;
        if (delta.function?.arguments) slot.function!.arguments += delta.function.arguments;
        toolCalls.set(index, slot);
      }
    };
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        await consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (done) break;
    }
    if (buffer.trim()) await consume(buffer);
    if (!finished) throw new AssistantError(502, COACH_DOWN);
    completed = true;
    return { content: content.trim(), model, usage, requestId, toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), finishReason };
  } catch (error) {
    if (env.CAIL_ABORT_SIGNAL?.aborted) throw env.CAIL_ABORT_SIGNAL.reason;
    if (error instanceof AssistantError) {
      error.requestId ??= requestId;
      throw error;
    }
    throw safeError(error, requestId);
  } finally {
    if (!completed) await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
