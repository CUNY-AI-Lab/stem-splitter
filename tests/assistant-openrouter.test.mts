import assert from 'node:assert/strict';
import test from 'node:test';

import type { Env } from '../src/env.ts';
import {
  AssistantError,
  assistantModelOrder,
  COACH_DOWN,
  openRouterChatStream,
} from '../src/assistant/openrouter.ts';

const PRIMARY = 'vendor/primary';
const FALLBACK_A = 'vendor/fallback-a';
const FALLBACK_B = 'vendor/fallback-b';

function env(fallbacks: string | undefined = `${FALLBACK_A},${FALLBACK_B}`): Env {
  return {
    OPENROUTER_API_KEY: 'test-key',
    ASSISTANT_MODEL: PRIMARY,
    ASSISTANT_FALLBACK_MODELS: fallbacks,
    PUBLIC_BASE_URL: 'https://stem-splitter.test',
  } as unknown as Env;
}

function params() {
  return {
    messages: [{ role: 'user' as const, content: 'Guide me.' }],
    tools: [
      {
        type: 'function' as const,
        function: {
          name: 'seek',
          description: 'Seek playback.',
          parameters: { type: 'object' },
        },
      },
    ],
    maxTokens: 200,
    temperature: 0.6,
  };
}

function sse(...events: (string | Record<string, unknown>)[]): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('an empty accepted stream retries once with an independent model first', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, any>[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return sse('[DONE]');
    return sse(
      {
        model: FALLBACK_A,
        choices: [{ delta: { content: 'Listen for ' }, finish_reason: null }],
      },
      {
        model: FALLBACK_A,
        choices: [{ delta: { content: 'the handoff.' }, finish_reason: 'stop' }],
      }
    );
  };

  const deltas: string[] = [];
  try {
    const reply = await openRouterChatStream(env(), params(), (text) => deltas.push(text));

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].models, [PRIMARY, FALLBACK_A, FALLBACK_B]);
    assert.deepEqual(requests[1].models, [FALLBACK_A, FALLBACK_B, PRIMARY]);
    assert.deepEqual(requests[0].provider, {
      data_collection: 'deny',
      allow_fallbacks: true,
      require_parameters: true,
    });
    assert.deepEqual(deltas, ['Listen for ', 'the handoff.']);
    assert.equal(reply.content, 'Listen for the handoff.');
    assert.equal(reply.model, FALLBACK_A);
    assert.equal(reply.finishReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a partial visible stream is never replayed', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return sse({
      model: PRIMARY,
      choices: [{ delta: { content: 'First, listen to the drums.' }, finish_reason: null }],
    });
  };

  const deltas: string[] = [];
  try {
    await assert.rejects(
      () => openRouterChatStream(env(), params(), (text) => deltas.push(text)),
      (error: unknown) => error instanceof AssistantError && error.studentMessage === COACH_DOWN
    );
    assert.equal(requests, 1);
    assert.deepEqual(deltas, ['First, listen to the drums.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authentication failures are not retried as model failures', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('{"error":"invalid key"}', { status: 401 });
  };

  try {
    await assert.rejects(
      () => openRouterChatStream(env(), params(), () => {}),
      (error: unknown) =>
        error instanceof AssistantError && error.studentMessage.includes("can't sign in")
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback configuration is bounded, de-duplicated, and explicitly disableable', () => {
  assert.deepEqual(
    assistantModelOrder(env(`${PRIMARY}, ${FALLBACK_A}, ${FALLBACK_A}, ${FALLBACK_B}, vendor/fourth`)),
    [PRIMARY, FALLBACK_A, FALLBACK_B, 'vendor/fourth']
  );
  assert.deepEqual(assistantModelOrder(env('')), [PRIMARY]);
});
