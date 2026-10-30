import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayForRequest } from './gateway.ts';
import { AssistantError } from '../src/assistant/openrouter.ts';
import { streamChat } from '../src/assistant/index.ts';
import type { Env } from '../src/env.ts';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from '../server/d1.ts';
import { reserveAssistant } from '../src/reliability/assistant.ts';
import { setCooldown } from '../src/reliability/retry.ts';
import { assistantDiagnosticCode, assistantRequestId, assistantRetrySeconds, gatewayRetrySeconds } from '../src/assistant/diagnostics.ts';
const id = '01900000-0000-7000-8000-000000000001';
const request = () => new Request('https://split.test/api/jobs/job/chat', { headers: { 'x-request-id': id } });
const env = { ASSISTANT_MODEL: 'glm-5.2' } as Env;
const params = { messages: [{ role: 'user' as const, content: 'Synthetic listening question' }], maxTokens: 100, temperature: 0.5 };
const sse = (events: unknown[]) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': id } });
const finished = { choices: [{ delta: {}, finish_reason: 'stop' }] };

test('Gateway diagnostics distinguish failures without copying provider messages or changing accepted-call retries', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (value: string) => logs.push(value));
  const upstreamId = '01900000-0000-7000-8000-000000000002';
  for (const mode of ['empty', 'incomplete', 'stream-rejection', 'rejection', 'unknown', 'timeout']) {
    logs.length = 0;
    let calls = 0;
    const controller = new AbortController();
    const transport = gatewayForRequest({ fetch: async () => {
      calls++;
      if (mode === 'timeout') {
        setTimeout(() => controller.abort(new DOMException('private timeout text', 'TimeoutError')), 5);
        return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': upstreamId } });
      }
      if (mode === 'empty' || mode === 'incomplete') return sse([{ choices: [{ delta: { content: mode === 'empty' ? '' : 'Partial fixture.' }, finish_reason: mode === 'empty' ? 'stop' : 'length' }] }]);
      const code = mode === 'unknown' ? 'private_provider_secret' : 'upstream_unavailable';
      const error = { error: { code, type: code, param: null, message: 'private provider body', cail: { request_id: upstreamId, should_retry: true, retry_after_seconds: 45 } } };
      return mode === 'rejection' ? Response.json(error, { status: 503, headers: { 'Retry-After': '46', 'x-request-id': upstreamId } }) : sse([error]);
    } } as unknown as Fetcher, 'private-gateway-leg', request(), 'test');
    const code = mode === 'empty' ? 'empty_response' : mode === 'incomplete' ? 'incomplete_response' : mode === 'timeout' ? 'upstream_timeout' : mode === 'unknown' ? 'assistant_unavailable' : 'upstream_unavailable';
    await assert.rejects(transport.stream({ ...env, ASSISTANT_ABORT_SIGNAL: controller.signal,
      ...(mode === 'rejection' ? {} : { ASSISTANT_FALLBACK_MODELS: 'deepseek-v4-flash-0731' }) }, params, () => {}), error => {
      assert.ok(error instanceof AssistantError); assert.equal(error.code, code);
      if (['stream-rejection', 'unknown', 'rejection'].includes(mode)) assert.equal(error.retryAfterSeconds, mode === 'rejection' ? 46 : 45);
      assert.ok(!error.message.includes('private')); return true;
    });
    assert.equal(calls, 1, 'an accepted response must not cause another model call');
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]), attributes = event.attributes;
    assert.equal(event.event_name, 'stem-splitter.gateway.completed');
    assert.equal(attributes['error.type'], code);
    assert.equal(attributes['http.response.status_code'], mode === 'rejection' ? 503 : 200);
    assert.equal(attributes['cail.request.id'], ['empty','incomplete'].includes(mode) ? id : upstreamId);
    assert.ok(Number.isFinite(attributes['cail.operation.duration_ms']));
    assert.equal(attributes['cail.retry.count'], 0);
    assert.ok(!logs[0].includes('private'));
  }
});

test('diagnostic codes, support IDs and retry delays are bounded allowlisted metadata', () => {
  assert.equal(assistantDiagnosticCode('empty_response'), 'empty_response');
  assert.equal(assistantDiagnosticCode('private_provider_secret'), 'assistant_unavailable');
  assert.equal(assistantRequestId(id), id); assert.equal(assistantRequestId('private credential'), undefined);
  for (const value of [-1, Infinity, NaN, 604801, '60', {}, null]) assert.equal(assistantRetrySeconds(value), undefined);
  assert.equal(assistantRetrySeconds(1.2), 2);
  assert.equal(gatewayRetrySeconds('12.5'), 13);
  const now = Date.parse('2026-10-29T00:00:00Z');
  assert.equal(gatewayRetrySeconds('Thu, 29 Oct 2026 00:01:00 GMT', now), 60);
  for (const value of ['private text', '-5', 'Infinity', '604801', '999999999999999999999']) assert.equal(gatewayRetrySeconds(value), undefined);
});

test('the private client sends one Gateway credential and drains trailing usage or failure', async () => {
  let calls = 0, trailingError = false;
  const binding = { fetch: async (outbound: Request) => {
    calls++;
    assert.equal(new URL(outbound.url).pathname, '/v1/chat/completions');
    assert.equal(outbound.headers.get('x-cail-identity-jwt'), 'private-gateway-leg');
    assert.equal(outbound.headers.get('authorization'), null);
    assert.equal(outbound.headers.get('x-cail-request-id'), id);
    const body = await outbound.json() as Record<string, unknown>;
    assert.equal(body.model, 'glm-5.2'); assert.equal(body.provider, undefined);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.max_tokens, params.maxTokens);
    return sse([{ choices: [{ delta: { content: 'Listen for the bass.' }, finish_reason: null }] }, finished,
      trailingError ? { error: { code: 'quota_exceeded', type: 'quota_exceeded', param: null, message: 'private provider text', cail: { request_id: id, should_retry: false } } } : { choices: [], usage: { total_tokens: 10 } }]);
  } } as unknown as Fetcher;
  const client = gatewayForRequest(binding, 'private-gateway-leg', request(), 'test');
  const deltas: string[] = [];
  assert.equal((await client.stream(env, params, text => { deltas.push(text); })).content, 'Listen for the bass.');
  assert.equal(calls, 1); assert.deepEqual(deltas, ['Listen for the bass.']);
  trailingError = true;
  await assert.rejects(client.stream(env, params, () => {}), error => error instanceof AssistantError && error.code === 'quota_exceeded' && error.requestId === id && error.shouldRetry === false && !error.message.includes('private provider'));
  assert.equal(calls, 2);
});

test('empty and truncated streams are failures, never successful attempts or automatic paid retries', async () => {
  for (const [content, finishReason, code] of [
    ['', 'stop', 'empty_response'], ['', 'length', 'incomplete_response'],
    ['Unfinished sentence', 'length', 'incomplete_response'], ['Filtered', 'content_filter', 'incomplete_response'],
  ]) {
    const local = new SqliteD1(':memory:');
    local.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const DB = local as unknown as D1Database, subject = `cail-${'e'.repeat(32)}`;
    await DB.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
    const operation = (await reserveAssistant({ DB } as Env, subject, null, 'guide', 'empty-guide-request-001', 'fixture-job', {})).operation;
    let calls = 0;
    const transport = gatewayForRequest({ fetch: async () => {
      calls++;
      return sse([{ choices: [{ delta: { content }, finish_reason: finishReason }] }, { choices: [], usage: { completion_tokens: 500 } }]);
    } } as unknown as Fetcher, 'gateway-leg', request(), 'test');
    await assert.rejects(transport.stream({ ...env, DB, ASSISTANT_OPERATION_ID: operation.id,
      ASSISTANT_FALLBACK_MODELS: 'deepseek-v4-flash-0731' }, params, () => {}),
      (error: unknown) => error instanceof AssistantError && error.code === code && error.shouldRetry === false);
    assert.equal(calls, 1);
    const attempts = (await DB.prepare('SELECT outcome,code FROM operation_attempts').all()).results;
    assert.deepEqual(attempts?.map(row => ({ ...row })), [{ outcome: content ? 'partial' : 'failed', code }]);
  }
});

test('a cooling primary skips directly to the configured backup without recording a fictitious attempt', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (value: string) => logs.push(value));
  const local = new SqliteD1(':memory:');
  local.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = local as unknown as D1Database, subject = `cail-${'f'.repeat(32)}`;
  await DB.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const operation = (await reserveAssistant({ DB } as Env, subject, null, 'chat', 'cooling-primary-request-001', 'fixture-job', {})).operation;
  await setCooldown(DB, 'gateway:glm-5.2', Date.now() + 30000);
  const models: string[] = [];
  const transport = gatewayForRequest({ fetch: async (outbound: Request) => {
    models.push((await outbound.json() as { model: string }).model);
    return sse([{ choices: [{ delta: { content: 'Listen for the bass.' }, finish_reason: 'stop' }] }]);
  } } as unknown as Fetcher, 'gateway-leg', request(), 'test');
  const result = await transport.stream({ ...env, DB, ASSISTANT_OPERATION_ID: operation.id,
    ASSISTANT_FALLBACK_MODELS: 'deepseek-v4-flash-0731' }, params, () => {});
  assert.equal(result.content, 'Listen for the bass.');
  assert.deepEqual(models, ['deepseek-v4-flash-0731']);
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).attributes['cail.retry.count'], 0, 'the first dispatched request is not a retry');
  assert.deepEqual((await DB.prepare('SELECT model,outcome FROM operation_attempts').all()).results?.map(row => ({ ...row })),
    [{ model: 'deepseek-v4-flash-0731', outcome: 'succeeded' }]);
  await setCooldown(DB, 'gateway:deepseek-v4-flash-0731', Date.now() + 30000);
  await assert.rejects(transport.stream({ ...env, DB, ASSISTANT_OPERATION_ID: operation.id,
    ASSISTANT_FALLBACK_MODELS: 'deepseek-v4-flash-0731' }, params, () => {}),
    (error: unknown) => error instanceof AssistantError && error.code === 'model_cooldown');
  assert.equal(models.length, 1);
  assert.equal(logs.length, 2);
  assert.equal(JSON.parse(logs[1]).attributes['cail.retry.count'], 0, 'cooldown rejection dispatches no retry');
});

test('tools-only replies receive local narration without another model request', async () => {
  let calls = 0;
  const transport = gatewayForRequest({ fetch: async () => {
    calls++;
    return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'solo', arguments: '{"stem":"vocals"}' } }] }, finish_reason: 'tool_calls' }] }]);
  } } as unknown as Fetcher, 'gateway-leg', request(), 'test');
  const localEnv = { ...env, assistantTransport: transport.stream, DB: { prepare: () => ({ first: async () => ({ amendment: '', revision: 1 }) }) } } as unknown as Env;
  const result = await streamChat(localEnv, { id: 'job', filename: 'Synthetic audio', model: 'htdemucs_ft', stems: '[{"name":"vocals"}]', labels: null }, [], [{ role: 'user', content: 'Solo the vocals.' }], 10, () => {});
  assert.equal(calls, 1); assert.match(result.reply, /soloed/); assert.equal(result.toolCalls.length, 1);
});

test('cancellation bounds non-cooperative fetches and response bodies; oversized responses fail', { timeout: 3000 }, async () => {
  for (const fetch of [() => new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const aborted = new AbortController();
    const transport = gatewayForRequest({ fetch } as unknown as Fetcher, 'gateway-leg', request(), 'test');
    const pending = transport.stream({ ...env, ASSISTANT_ABORT_SIGNAL: aborted.signal }, params, () => {});
    setTimeout(() => aborted.abort(new DOMException('Cancelled', 'AbortError')), 20);
    await assert.rejects(pending, { name: 'AbortError' });
  }
  const tooLarge = gatewayForRequest({ fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) } as unknown as Fetcher, 'gateway-leg', request(), 'test');
  await assert.rejects(tooLarge.stream(env, params, () => {}), AssistantError);
});

test('unavailable aggregate quota stays unavailable and is never a local permission', async () => {
  let calls = 0;
  const transport = gatewayForRequest({ fetch: async () => { calls++; return Response.json({ error: { code: 'quota_unavailable', message: 'Unavailable' } }, { status: 503 }); } } as unknown as Fetcher, 'gateway-leg', request(), 'test');
  await assert.rejects(transport.quota()); assert.equal(calls, 1);
});

test('ordered fallback uses only documented capacity rejections; policy/quota/auth/unknown do not fall back',async t=>{
 const logs: string[] = [];
 t.mock.method(console, 'log', (value: string) => logs.push(value));
 for(const [code,status,shouldRetry,fallback] of [
  ['upstream_rate_limited',429,true,true],['upstream_unavailable',503,true,true],['model_unavailable',503,true,true],
  ['quota_exceeded',429,false,false],['rate_limit_unknown',429,false,false],['upstream_auth_error',401,false,false],
  ['upstream_payment_required',402,false,false],['upstream_timeout',504,false,false],['upstream_unavailable',503,false,false],
 ] as const) {
  logs.length = 0;
  const models:string[]=[];
  const transport=gatewayForRequest({fetch:async(outbound:Request)=>{
   assert.equal(outbound.headers.get('x-cail-identity-jwt'),'same-verified-subject');
   const body=await outbound.json() as {model:string;messages:unknown[]};models.push(body.model);assert.deepEqual(body.messages,params.messages);
   if(models.length===1)return Response.json({error:{code,type:code,param:null,message:'DO NOT DISPLAY',cail:{should_retry:shouldRetry}}},{status,headers:{'x-should-retry':String(shouldRetry)}});
   return sse([{choices:[{delta:{content:'A calm backup answer.'},finish_reason:null}]},finished]);
  }} as unknown as Fetcher,'same-verified-subject',request(),'test');
  const pending=transport.stream({...env,ASSISTANT_FALLBACK_MODELS:'deepseek-v4-flash-0731'},params,()=>{});
  if(fallback){assert.equal((await pending).model,'deepseek-v4-flash-0731');assert.deepEqual(models,['glm-5.2','deepseek-v4-flash-0731']);}
  else {await assert.rejects(pending,AssistantError);assert.deepEqual(models,['glm-5.2']);}
  assert.deepEqual(logs.map(value=>JSON.parse(value).attributes['cail.retry.count']),fallback?[0,1]:[0]);
 }
});
test('both failures stop at two, stream/tool output forbids fallback, and mis-mapped backup fails closed',async()=>{
 for(const mode of ['both','partial','tools','trailing']) {
  let calls=0;
  const error={error:{code:'upstream_unavailable',type:'upstream_unavailable',param:null,message:'secret',cail:{should_retry:true}}};
  const transport=gatewayForRequest({fetch:async()=>{calls++;
   if(mode==='both')return Response.json(error,{status:503,headers:{'x-should-retry':'true'}});
   const delta=mode==='tools'?{tool_calls:[{index:0,id:'a',function:{name:'solo',arguments:'{"stem":"vocals"}'}}]}:{content:'Partial.'};
   return sse([{choices:[{delta,finish_reason:null}]},...(mode==='trailing'?[finished]:[]),error]);
  }} as unknown as Fetcher,'identity',request(),'test');
  await assert.rejects(transport.stream({...env,ASSISTANT_FALLBACK_MODELS:'deepseek-v4-flash-0731'},params,()=>{}),AssistantError);
  assert.equal(calls,mode==='both'?2:1);
 }
 let calls=0;const transport=gatewayForRequest({fetch:async()=>{calls++;return sse([finished]);}} as unknown as Fetcher,'identity',request(),'test');
 await assert.rejects(transport.stream({...env,ASSISTANT_FALLBACK_MODELS:'deepseek-flash'},params,()=>{}),AssistantError);assert.equal(calls,0);
});
