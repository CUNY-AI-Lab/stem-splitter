import assert from 'node:assert/strict';
import test from 'node:test';
import type { Env } from '../src/env.ts';
import { AssistantError, COACH_DOWN, COACH_QUOTA, gatewayChatStream } from '../src/assistant/gateway.ts';

const env = {
  CAIL_GATEWAY_URL: 'https://tools.ailab.gc.cuny.edu',
  CAIL_GATEWAY_IDENTITY_JWT: 'verified-identity',
  CAIL_CONVERSATION_ID: 'conversation-123',
  ASSISTANT_MODEL: 'gpt-oss-120b',
} as Env;
const params = { messages: [{ role: 'user' as const, content: 'Listen' }], maxTokens: 100, temperature: 0.5 };
function sse(events: unknown[], headers?: HeadersInit) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers });
}
async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('CAIL client sends verified identity and affinity, drains trailing usage, and assembles fragmented tools', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), 'https://tools.ailab.gc.cuny.edu/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-cail-identity-jwt'), 'verified-identity');
    assert.equal(headers.get('x-cail-session-id'), 'conversation-123');
    assert.equal(headers.get('x-cail-app'), 'stem-splitter');
    assert.equal(headers.get('authorization'), null);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.provider, undefined);
    assert.equal(body.stream_options.include_usage, true);
    return sse([
      { model: 'resolved/model', choices: [{ delta: { content: 'Hello', tool_calls: [{ index: 0, id: 'tool', function: { name: 'seek', arguments: '{"seconds":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '3}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11, private_field: 'secret' } },
    ], { 'x-cail-request-id': '018f1f50-7c21-7abc-9def-0123456789ab' });
  }, async () => {
    const deltas: string[] = [];
    const reply = await gatewayChatStream(env, params, (text) => { deltas.push(text); });
    assert.deepEqual(deltas, ['Hello']);
    assert.equal(reply.model, 'resolved/model');
    assert.equal(reply.toolCalls[0].function?.arguments, '{"seconds":3}');
    assert.deepEqual(reply.usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
    assert.equal(reply.requestId, '018f1f50-7c21-7abc-9def-0123456789ab');
  });
});

test('trailing stream errors fail safely after finish reason', async () => {
  await withFetch(async () => sse([
    { choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] },
    { error: { message: 'PRIVATE PROVIDER DETAIL', code: 'provider_error' } },
  ]), async () => {
    await assert.rejects(gatewayChatStream(env, params, () => {}), (error: unknown) => error instanceof AssistantError && error.message === COACH_DOWN);
  });
});

test('quota failure makes exactly one request with no fallback', async () => {
  let requests = 0;
  await withFetch(async () => {
    requests++;
    return Response.json({ error: { code: 'quota_exceeded', type: 'quota_exceeded', param: null, message: 'PRIVATE', cail: { request_id: '018f1f50-7c21-7abc-9def-0123456789ab' } } }, { status: 429, headers: { 'x-should-retry': 'false' } });
  }, async () => {
    await assert.rejects(gatewayChatStream(env, params, () => {}), (error: unknown) => error instanceof AssistantError && error.httpStatus === 503 && error.message === COACH_QUOTA && error.code === 'quota_exceeded' && error.shouldRetry === false && error.requestId === '018f1f50-7c21-7abc-9def-0123456789ab');
    assert.equal(requests, 1);
  });
});

test('truncated completion fails instead of caching partial text', async () => {
  await withFetch(async () => sse([{ choices: [{ delta: { content: 'partial' } }] }]), async () => {
    await assert.rejects(gatewayChatStream(env, params, () => {}), AssistantError);
  });
});

test('aborted caller sends no request and preserves abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('caller disconnected');
  controller.abort(reason);
  await withFetch(async () => { throw new Error('must not fetch'); }, async () => {
    await assert.rejects(gatewayChatStream({ ...env, CAIL_ABORT_SIGNAL: controller.signal }, params, () => {}), (error) => error === reason);
  });
});

test('consumer failure cancels the receiver stream', async () => {
  let cancelled = false;
  await withFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')); },
    cancel() { cancelled = true; },
  })), async () => {
    await assert.rejects(gatewayChatStream(env, params, () => { throw new Error('sink closed'); }), AssistantError);
    assert.equal(cancelled, true);
  });
});

for (const [label, body] of [
  ['truncated', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
  ['malformed', 'data: {broken json}\n\n'],
  ['trailing error', 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"error":{}}\n\n'],
] as const) {
  test(`${label} preserves safe response correlation`, async () => {
    await withFetch(async () => new Response(body, { headers: { 'x-cail-request-id': '018f1f50-7c21-7abc-9def-0123456789ab' } }), async () => {
      await assert.rejects(gatewayChatStream(env, params, () => {}), (error: unknown) =>
        error instanceof AssistantError && error.requestId === '018f1f50-7c21-7abc-9def-0123456789ab' && error.message === COACH_DOWN);
    });
  });
}

test('invalid response correlation is never exposed', async () => {
  await withFetch(async () => new Response('data: {}\n\n', { headers: { 'x-cail-request-id': 'private payload with spaces' } }), async () => {
    await assert.rejects(gatewayChatStream(env, params, () => {}), (error: unknown) => error instanceof AssistantError && error.requestId === undefined);
  });
});

test('tools-only chat streams and returns local narration with one model request', async () => {
  const { streamChat } = await import('../src/assistant/index.ts');
  let requests = 0;
  await withFetch(async () => {
    requests++;
    return sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 'seek', arguments: '{"seconds":30}' } },
      { index: 1, id: 'b', function: { name: 'solo', arguments: '{"stem":"vocals"}' } },
    ] }, finish_reason: 'tool_calls' }] }]);
  }, async () => {
    const db = { prepare: () => ({ first: async () => ({ amendment: '', revision: 1 }) }) };
    const deltas: string[] = [];
    const reply = await streamChat({ ...env, DB: db } as unknown as Env,
      { id: 'job', filename: 'song', model: null, stems: '[{"name":"vocals"}]', labels: null }, [],
      [{ role: 'user', content: 'Jump ahead and solo vocals' }], 120, (text) => { deltas.push(text); });
    assert.equal(requests, 1);
    assert.equal(reply.toolCalls.length, 2);
    assert.match(reply.reply, /Moved playback to/);
    assert.match(reply.reply, /Soloed the "vocals" channel/);
    assert.equal(deltas.join(''), reply.reply);
  });
});

test('tools-only remix keeps deck tool limits and narrates without a second model call', async () => {
  const { streamChat } = await import('../src/assistant/index.ts');
  let requests = 0;
  await withFetch(async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ['solo', 'set_mute']);
    assert.match(body.messages[0].content, /Class lead voice/);
    return sse([{ choices: [{ delta: { tool_calls: [
      { index: 0, function: { name: 'seek', arguments: '{"seconds":30}' } },
      { index: 1, function: { name: 'solo', arguments: '{"stem":"vocals"}' } },
      { index: 2, function: { name: 'add_note', arguments: '{"seconds":1,"text":"No class mutation"}' } },
    ] }, finish_reason: 'tool_calls' }] }]);
  }, async () => {
    const db = { prepare: () => ({ first: async () => ({ amendment: '', revision: 1 }) }) };
    const deltas: string[] = [];
    const reply = await streamChat({ ...env, DB: db } as unknown as Env,
      { id: 'job', filename: 'song', model: null, stems: '[{"name":"vocals"}]', labels: null }, [],
      [{ role: 'user', content: 'Solo the voice' }], 120, (text) => { deltas.push(text); },
      { mode: 'remix', deck: 'vocals: Class lead voice' });
    assert.equal(requests, 1);
    assert.deepEqual(reply.toolCalls, [{ name: 'solo', args: { stem: 'vocals' } }]);
    assert.equal(reply.reply, 'Soloed the "vocals" channel.');
    assert.equal(deltas.join(''), reply.reply);
  });
});
