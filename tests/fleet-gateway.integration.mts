/** Actual Stem Hono/Node → actual Gateway receiver over loopback HTTP.
 * Synthetic Registry, catalog and Cloudflare AI Gateway provider only. This is
 * not Workerd, a deployed /stem-splitter mount, or live provider/accounting E2E.
 * Run: node --import tsx --test tests/fleet-gateway.integration.mts
 * Set CAIL_GATEWAY_CHECKOUT to a clean Gateway checkout with frozen-installed dependencies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';

// Only the unused private quota-reader entrypoint needs this Workerd class.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: "data:text/javascript,export class WorkerEntrypoint { constructor() { throw new Error('Private Worker entrypoint is unavailable in this Node fixture'); } }", shortCircuit: true };
  return next(specifier, context);
} });
assert.ok(process.env.CAIL_GATEWAY_CHECKOUT, 'Set CAIL_GATEWAY_CHECKOUT to a clean, frozen-installed Gateway receiver checkout.');
const gatewayRoot = resolve(process.env.CAIL_GATEWAY_CHECKOUT);
const gatewayRelease = execFileSync('git', ['-C', gatewayRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const gatewayRequire = createRequire(join(gatewayRoot, 'package.json'));
const identityEntry = gatewayRequire.resolve('@cuny-ai-lab/cail-identity');
const identityPackage = JSON.parse(readFileSync(join(dirname(identityEntry), '../package.json'), 'utf8'));
const receiverIdentity = await import(pathToFileURL(identityEntry).href);
assert.equal(identityPackage.version, '5.2.4', 'Receiver must resolve its frozen identity dependency');
assert.equal(receiverIdentity.CAIL_CANONICAL_ISSUER, 'https://tools.ailab.gc.cuny.edu/cail-sso', 'Stale ambient Gateway dependencies: reinstall the receiver with bun install --frozen-lockfile');
execFileSync('git', ['-C', gatewayRoot, 'diff', '--exit-code', 'HEAD', '--', 'src', 'package.json', 'bun.lock']);
const { handleRequest } = await import(pathToFileURL(join(gatewayRoot, 'src/index.ts')).href);
const MODEL = 'gpt-oss-120b';
const PROVIDER_MODEL = '@cf/openai/gpt-oss-120b';
const QUOTA_KEY = `quota-v1-${'3'.repeat(64)}`;
const REQUEST_ID = '018f1f50-7c21-7abc-9def-0123456789ab';
const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const encode = (value: unknown) => new TextEncoder().encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
async function listen(fetcher: (request: Request) => Promise<Response>) {
  const server = serve({ fetch: fetcher, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
async function eventually(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), 'expected boundary observation within five seconds');
}

test('real local receiver: identity, cache, denial, correlation and cancellation', async (t) => {
  t.diagnostic(`Gateway receiver revision: ${gatewayRelease}; Node HTTP adapter; synthetic Registry/catalog/provider; no deployed mount or live accounting.`);
  const issuer = await createTestIdentityIssuer();
  const temp = mkdtempSync(join(tmpdir(), 'stem-fleet-'));
  const db = new SqliteD1(join(temp, 'db.sqlite'));
  db.applySchema(readFileSync('schema.sql', 'utf8'));
  db.applyNodeMigrations();
  await db.prepare("INSERT INTO jobs (id, filename, source_key, status, stems) VALUES (?, ?, ?, 'done', ?)")
    .bind('fixture', 'Synthetic song', 'source', JSON.stringify([
      { name: 'vocals', key: 'stems/fixture/vocals.mp3' },
      { name: 'instrumental', key: 'stems/fixture/instrumental.mp3' },
    ])).run();
  let mode = 'success';
  let registryCalls = 0;
  let providerCalls = 0;
  let providerAborted = false;
  const incoming: Request[] = [];
  const receiverErrors: { status: number; body: unknown }[] = [];
  const metadata: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => { for (const value of args) if (value && typeof value === 'object') events.push(value as Record<string, unknown>); };
  console.log = capture; console.warn = capture; console.error = capture;
  const gatewayEnv = {
    MODEL_PRESENTATION: { get: async () => JSON.stringify({
      schema_version: 1, source_commit: 'a'.repeat(40), entries: [],
      refreshed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }) },
    CAIL_GATEWAY_AUDIENCE: 'cail:gateway', CAIL_IDENTITY_ISSUER: issuer.issuer, CAIL_IDENTITY_JWKS: issuer.jwksJson,
    CAIL_LOG_ENV: 'test', RELEASE: gatewayRelease,
    AI_GATEWAY_ID: 'cail-model-api', CF_ACCOUNT_ID: '452c33847cf5cb1e46f391fca32fd1b5',
    CF_AIG_AUTH_TOKEN_STORE: { get: async () => 'synthetic-token-at-least-twenty-characters' },
    MODEL_SOURCES: 'workers-ai', MODEL_CATALOG_MAX_STALE_SECONDS: '3600',
    AI: { models: async () => [{ name: PROVIDER_MODEL, description: 'Synthetic catalog entry', properties: [{ property_id: 'function_calling', value: 'true' }] }] },
    MODEL_ACCESS_REGISTRY_GATEWAY: {
      resolveAccessWithQuota: async () => ({ ok: false, code: 'invalid', retryable: false }),
      resolveDoorwayAccessWithQuota: async () => { registryCalls++; return mode === 'registry-denied' ? { ok: false, code: 'not_admitted', retryable: false } : { ok: true, scope: 'models:invoke models:read quota:read', quotaKey: QUOTA_KEY, budgetScope: 'person' }; },
    },
  };
  const gateway = await listen(async request => {
    incoming.push(request);
    const result = await handleRequest(request, gatewayEnv, { now: Date.now, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === 'https://models.dev/api.json') return Response.json({
        'cloudflare-workers-ai': { models: { [PROVIDER_MODEL]: { id: PROVIDER_MODEL, open_weights: true } } },
      });
      if (new URL(request.url).pathname.endsWith('/ai/models/schema')) return Response.json({ success: true, result: {} });
      assert.equal(new URL(request.url).hostname, 'api.cloudflare.com');
      providerCalls++;
      metadata.push(JSON.parse(request.headers.get('cf-aig-metadata') ?? '{}'));
      if (mode === 'quota-denied') return Response.json({ success: false, error: [{ code: 2041, message: 'synthetic spend denial' }], internalCode: 2041 }, { status: 429 });
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(encode({ id: 'synthetic', model: MODEL, choices: [{ index: 0, delta: { content: 'Listen to the vocals.' }, finish_reason: null }] }));
        if (mode === 'abort') {
          const cancel = () => { providerAborted = true; controller.error(new DOMException('Cancelled', 'AbortError')); };
          init?.signal?.addEventListener('abort', cancel, { once: true });
        } else {
          controller.enqueue(encode({ id: 'synthetic', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
          controller.enqueue(encode('[DONE]')); controller.close();
        }
      }, cancel() { providerAborted = true; } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cf-aig-log-id': 'synthetic-log' } });
    } });
    if (result.status !== 200) receiverErrors.push({ status: result.status, body: await result.clone().json() });
    return result;
  });
  const env = { DB: db, AUDIO: new FsR2Bucket(join(temp, 'audio')), LOCAL_HOSTING: 'true', LOCAL_DEV: '1', PUBLIC_BASE_URL: 'http://127.0.0.1', CLASS_CODE: 'class-fixture', WEBHOOK_SECRET: 'synthetic-secret', ASSISTANT_MODEL: MODEL, CAIL_GATEWAY_URL: gateway.url, CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer, CAIL_SOURCE_VERSION: 'a'.repeat(40), CAIL_READINESS_TOKEN: 'synthetic-readiness' };
  const stem = await listen(request => app.fetch(request, env as never));
  const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter' });
  const gatewayJwt = await issuer.mintIdentityJwt({ audience: 'cail:gateway' });
  const headers = { 'content-type': 'application/json', 'x-class-code': 'class-fixture', 'x-cail-identity-jwt': appJwt, 'x-cail-gateway-identity-jwt': gatewayJwt, 'x-cail-request-id': REQUEST_ID, traceparent: TRACE };
  const post = (route = 'chat', extra = {}, signal?: AbortSignal) => fetch(`${stem.url}/api/jobs/fixture/${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(route === 'chat' ? { messages: [{ role: 'user', content: 'What should I hear?' }] } : {}), signal });
  try {
    assert.equal((await fetch(`${stem.url}/api/fleet/readyz`)).status, 401);
    const ready = await fetch(`${stem.url}/api/fleet/readyz`, { headers: { authorization: 'Bearer synthetic-readiness' } });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true, sourceVersion: 'a'.repeat(40), audience: 'cail:stem-splitter' });
    const wrong = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.bob });
    for (const override of [{ 'x-cail-gateway-identity-jwt': wrong }, { 'x-cail-identity-jwt': gatewayJwt }, { 'x-class-code': 'wrong' }]) assert.equal((await post('chat', override)).status, 401);
    assert.equal(incoming.length, 0);
    const guide = await (await post('guide')).text();
    assert.equal(incoming.length, 1, 'authorized guide reaches actual Gateway receiver');
    assert.equal(incoming[0].headers.get('x-cail-identity-jwt'), gatewayJwt);
    assert.equal(incoming[0].headers.get('x-cail-request-id'), REQUEST_ID);
    assert.equal(incoming[0].headers.get('traceparent')?.split('-')[1], TRACE.split('-')[1]);
    assert.deepEqual(receiverErrors, [], 'Gateway must admit the canonical model and current identity contract');
    assert.match(guide, /Listen to the vocals/); assert.match(guide, /"cached":false/);
    assert.equal(providerCalls, 1);
    const bobHeaders = { 'x-cail-identity-jwt': await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.bob }), 'x-cail-gateway-identity-jwt': await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.bob }) };
    const cached = await (await post('guide', bobHeaders)).text();
    assert.match(cached, /"cached":true/); assert.equal(providerCalls, 1);
    const publicJob = await fetch(`${stem.url}/api/jobs/fixture`);
    assert.equal(publicJob.status, 200); assert.match(await publicJob.text(), /Listen to the vocals/);
    assert.match(await (await post()).text(), /"type":"done"/);
    assert.equal(providerCalls, 2); assert.equal(registryCalls, 2);
    assert.equal(metadata[0].user_id, QUOTA_KEY); assert.equal(metadata[0].budget_scope, 'person');
    mode = 'registry-denied';
    assert.match(await (await post()).text(), /"type":"error"/);
    assert.equal(incoming.length, 3); assert.equal(registryCalls, 3); assert.equal(providerCalls, 2);
    mode = 'quota-denied';
    assert.match(await (await post()).text(), /"type":"error"/);
    assert.equal(incoming.length, 4); assert.equal(registryCalls, 4); assert.equal(providerCalls, 3);
    mode = 'abort';
    const abort = new AbortController();
    const response = await post('chat', {}, abort.signal);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /Listen to the vocals/);
    abort.abort();
    await reader.cancel().catch(() => {});
    await eventually(() => providerAborted);
    await eventually(() => events.some(event => event['service.name'] === 'cail-gateway' && event['cail.outcome'] === 'cancelled' && event['cail.request.id'] === REQUEST_ID));
    assert.equal(providerCalls, 4);
    await eventually(() => incoming.at(-1)!.signal.aborted);
    assert.deepEqual(receiverErrors.map(result => result.status), [403, 429]);
    assert.match(JSON.stringify(receiverErrors[0].body), /insufficient_scope/);
    assert.match(JSON.stringify(receiverErrors[1].body), /quota_exceeded/);
    const terminals = events.filter(event => event['service.name'] === 'cail-gateway' && event['event.name'] === 'cail.model.call.terminal');
    assert.deepEqual(terminals.map(event => event['cail.outcome']), ['ok', 'ok', 'denied', 'cancelled']);
    assert.equal(new Set(terminals.map(event => event['cail.call.id'])).size, 4);
    assert.ok(terminals.every(event => event['cail.retry.count'] === 0 && event['cail.request.id'] === REQUEST_ID));
    assert.ok(metadata.every(value => value.user_id === QUOTA_KEY && value.budget_scope === 'person'));
    const serializedEvents = JSON.stringify(events);
    for (const privateValue of [appJwt, gatewayJwt, TEST_SUBJECTS.alice, 'What should I hear?', 'Listen to the vocals.']) assert.ok(!serializedEvents.includes(privateValue));
  } finally {
    await stem.close(); await gateway.close(); Object.assign(console, originalConsole); rmSync(temp, { recursive: true, force: true });
  }
});
