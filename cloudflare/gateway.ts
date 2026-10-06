import { createCailClient, CailError, extractCailError } from '@cuny-ai-lab/cail-client';
import { correlationFromHeaders, createCailLogger, defineEventCatalog } from '@cuny-ai-lab/cail-log';
import { AssistantError, COACH_DOWN, COACH_UNCONFIGURED, type OpenRouterParams, type OpenRouterReply } from '../src/assistant/openrouter.ts';
import type { WireStreamChunk, WireToolCall } from '../src/assistant/types.ts';
import type { Env } from '../src/env.ts';
import { boundedText, cancel, deadline, withSignal } from './bounded.ts';
import { beginAttempt, finishAttempt, readOperation } from '../src/reliability/ledger.ts';
import { cooldown, retryAt, setCooldown } from '../src/reliability/retry.ts';

export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const canonicalModel = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
export const GATEWAY_MODELS = ['glm-5.2', 'deepseek-v4-flash-0731'] as const;
export const gatewayModelsConfigured = (primary: unknown, backup: unknown) => primary === GATEWAY_MODELS[0] && backup === GATEWAY_MODELS[1];
export function eligibleGatewayFallback(error: unknown) {
  return error instanceof CailError && error.extras.should_retry === true &&
    (error.code==='upstream_rate_limited' && error.status===429 ||
      ['upstream_unavailable','model_unavailable'].includes(error.code) && error.status===503);
}
const catalog = defineEventCatalog({
  'stem-splitter.gateway.completed': { source: 'tenant', severity: 'outcome', required: ['request_id', 'terminal'], optional: [] },
});

function safeFailure(error: unknown, fallback: string): AssistantError {
  if (error instanceof AssistantError) { error.requestId ??= fallback; return error; }
  const code = error instanceof CailError && /^[a-z][a-z_]{1,63}$/.test(error.code) ? error.code : 'assistant_unavailable';
  const shouldRetry = error instanceof CailError && typeof error.extras.should_retry === 'boolean' ? error.extras.should_retry : false;
  const candidate = error instanceof CailError ? error.extras.request_id : null;
  const requestId = typeof candidate === 'string' && REQUEST_ID.test(candidate) ? candidate : fallback;
  const message = code === 'quota_exceeded' ? 'The CAIL model usage limit has been reached. The mixer still works.'
    : shouldRetry ? COACH_DOWN : 'The Listening Guide could not complete this request. The mixer still works.';
  return new AssistantError(error instanceof CailError && error.status === 429 ? 503 : 502, message, { requestId, code, shouldRetry });
}

export function gatewayForRequest(binding: Fetcher | undefined, token: string | null, request: Request, release: string) {
  const headers = new Headers(request.headers);
  const incoming = headers.get('x-cail-request-id') ?? headers.get('x-request-id');
  if (incoming && REQUEST_ID.test(incoming)) headers.set('x-cail-request-id', incoming);
  const correlation = correlationFromHeaders(headers);
  const log = createCailLogger({ service: 'stem-splitter', release, env: 'production', sourceClass: 'tenant', catalog,
    sink: event => console.log(JSON.stringify(event)) });
  const client = createCailClient({ app: 'stem-splitter', fetchImpl: async (input, init) => {
    if (!binding || !token) throw new AssistantError(503, COACH_UNCONFIGURED);
    const outbound = new Request(input, init);
    // Keep the caller's signal alive while a private binding is pending. A
    // Request's dependent signal can lose its propagation link after GC in Node.
    const signal = init?.signal ?? outbound.signal;
    const pending = binding.fetch(outbound);
    let response;
    try { response = await withSignal(pending, signal); }
    catch (error) { void pending.then(value => cancel(value.body), () => {}); throw error; }
    if (response.ok) return response;
    return new Response(await boundedText(response, signal), { status: response.status, headers: response.headers });
  } });

  const stream = async (env: Env, params: OpenRouterParams, onDelta: (text: string) => void | Promise<void>): Promise<OpenRouterReply> =>
    deadline(async signal => {
      if (!binding || !token || !canonicalModel(env.ASSISTANT_MODEL) ||
        (env.ASSISTANT_FALLBACK_MODELS !== undefined && !gatewayModelsConfigured(env.ASSISTANT_MODEL, env.ASSISTANT_FALLBACK_MODELS))) throw new AssistantError(503,COACH_UNCONFIGURED);
      const models = env.ASSISTANT_FALLBACK_MODELS ? GATEWAY_MODELS : [env.ASSISTANT_MODEL];
      for (const [modelIndex, model] of models.entries()) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let accepted = false, outputStarted = false;
      let attemptId: string | null = null, usage: unknown;
      const operation = env.ASSISTANT_OPERATION_ID ? await readOperation(env.DB,env.ASSISTANT_OPERATION_ID) : null;
      let requestId = correlation.request_id;
      let outcome: 'ok' | 'cancelled' | 'error' = 'error';
      try {
        if (operation) {
          if (await cooldown(env.DB,`gateway:${model}`)>Date.now()) throw new AssistantError(503,COACH_DOWN,{code:'model_cooldown',shouldRetry:true});
          attemptId=await beginAttempt(env.DB,operation,'cail-gateway',model);
        }
        const response = await client.chatCompletions({
          model, messages: params.messages.map(({ role, content }) => ({ role, content })),
          ...(params.tools?.length ? { tools: params.tools.map(tool => ({ type: tool.type, function: { ...tool.function, parameters: JSON.parse(JSON.stringify(tool.function.parameters)) } })), tool_choice: 'auto' } : {}),
          stream: true, stream_options: { include_usage: true }, max_tokens: params.maxTokens, temperature: params.temperature,
        }, { kind: 'jwt', token }, { signal, correlation });
        accepted = true;
        const responseId = response.headers.get('x-request-id') ?? response.headers.get('x-cail-request-id');
        if (responseId && REQUEST_ID.test(responseId)) requestId = responseId;
        reader = response.body?.getReader();
        if (!reader) throw new AssistantError(502, COACH_DOWN);
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
        let buffer = '', content = '', totalBytes = 0, finishReason = '';
        const calls = new Map<number, WireToolCall>();
        const consume = async (event: string) => {
          if (event.length > 262144) throw new AssistantError(502, COACH_DOWN);
          const payload = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!payload || payload === '[DONE]') return;
          const value: unknown = JSON.parse(payload);
          const error = extractCailError(value);
          if (error) throw error;
          if (!value || typeof value !== 'object' || 'error' in value) throw new AssistantError(502, COACH_DOWN);
          const chunk = value as WireStreamChunk;
          if ('usage' in value) usage=(value as {usage:unknown}).usage;
          const choice = chunk.choices?.[0];
          if (!choice) return; // Trailing accounting events still get drained.
          if (choice.finish_reason === 'error') throw new AssistantError(502, COACH_DOWN);
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (choice.delta?.content) {
            if (typeof choice.delta.content !== 'string') throw new AssistantError(502, COACH_DOWN);
            outputStarted = true;
            content += choice.delta.content;
            await withSignal(Promise.resolve(onDelta(choice.delta.content)), signal);
          }
          for (const delta of choice.delta?.tool_calls ?? []) {
            outputStarted = true;
            if (!Number.isSafeInteger(delta.index) || delta.index! < 0 || delta.index! >= 32) throw new AssistantError(502, COACH_DOWN);
            const slot = calls.get(delta.index!) ?? { type: 'function', function: { name: '', arguments: '' } };
            if (delta.id) slot.id = delta.id;
            if (delta.function?.name) slot.function!.name += delta.function.name;
            if (delta.function?.arguments) slot.function!.arguments += delta.function.arguments;
            calls.set(delta.index!, slot);
          }
        };
        for (;;) {
          const { value, done } = await withSignal(reader.read(), signal);
          if (value) totalBytes += value.byteLength;
          if (totalBytes > 2 * 1024 * 1024) throw new AssistantError(502, COACH_DOWN);
          buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) { await consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
          if (buffer.length > 262144) throw new AssistantError(502, COACH_DOWN);
          if (done) break;
        }
        if (buffer.trim()) await consume(buffer);
        if (!finishReason) throw new AssistantError(502, COACH_DOWN);
        const toolIds=[...calls.values()].map(call=>call.id).filter(Boolean);
        if (new Set(toolIds).size!==toolIds.length) throw new AssistantError(502,COACH_DOWN,{code:'invalid_tool_calls'});
        outcome = 'ok';
        if (attemptId) await finishAttempt(env.DB,attemptId,'succeeded',{usage});
        return { content: content.trim(), model, toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), finishReason };
      } catch (error) {
        if (attemptId) await finishAttempt(env.DB,attemptId,outputStarted?'partial':accepted?'uncertain':'rejected',{code:error instanceof CailError?error.code:'gateway_failure',usage});
        if (!signal.aborted && !accepted && !outputStarted && modelIndex===0 && models.length===2 && eligibleGatewayFallback(error)) {
          if (operation) await setCooldown(env.DB,`gateway:${model}`,retryAt(error instanceof CailError ? String(error.extras.retry_after ?? error.extras.retry_after_seconds ?? '30') : '30'));
          continue;
        }
        if (signal.aborted) {
          if (signal.reason?.name === 'TimeoutError') throw new AssistantError(503, COACH_DOWN, { requestId, code: 'upstream_timeout', shouldRetry: true });
          outcome = 'cancelled'; throw signal.reason;
        }
        throw safeFailure(error, requestId);
      } finally {
        try { void reader?.cancel().catch(() => {}); } catch { /* Best effort. */ }
        reader?.releaseLock();
        const terminal = outcome === 'ok' ? { outcome: 'ok', reason: 'completed' } as const
          : outcome === 'cancelled' ? { outcome: 'cancelled', reason: 'cancelled' } as const
            : { outcome: 'error', reason: 'upstream_failure' } as const;
        log.emit('stem-splitter.gateway.completed', { request_id: requestId, terminal });
      }
      }
      throw new AssistantError(503,COACH_DOWN);
    }, env.ASSISTANT_ABORT_SIGNAL ?? request.signal, 60000);
  return { stream, quota: () => deadline(async signal => {
    if (!binding || !token) throw new AssistantError(503, COACH_UNCONFIGURED);
    // cail-client validates the bounded quota envelope; it never grants access.
    const quotaClient = createCailClient({ app: 'stem-splitter', fetchImpl: async (input, init) => {
      const pending = binding.fetch(new Request(input, init));
      let response;
      try { response = await withSignal(pending, signal); }
      catch (error) { void pending.then(value => cancel(value.body), () => {}); throw error; }
      return new Response(await boundedText(response, signal), { status: response.status, headers: response.headers });
    } });
    return quotaClient.getQuota({ kind: 'jwt', token }, { signal });
  }, request.signal, 5000) };
}
