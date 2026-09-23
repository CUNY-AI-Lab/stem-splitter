// Local test entrypoint only. Never referenced by the deployment config.
import preview, { type WorkerEnv } from './worker.ts';
import { SESSION_COOKIE, type WorkerIdentity } from './sso.ts';
type TestEnv = WorkerEnv & { TEST_JWKS: string; TEST_ADMIN: string; TEST_BROWSER?: string };
let gatewayCalls = 0;
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/__fixture/gateway-stats' && request.headers.get('x-fixture') === 'local-only') return Response.json({ gatewayCalls });
    if (new URL(request.url).pathname === '/__fixture/audio' && request.headers.get('x-fixture') === 'local-only') {
      await env.AUDIO.put('stems/remix-fixture/vocals.mp3', await request.arrayBuffer());
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/__fixture/schema' && request.headers.get('x-fixture') === 'local-only') {
      const statements = await request.json<string[]>();
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    // Fixture-only identity receiver. Production never trusts this header;
    // it receives JWTs from Doorway RPC after an opaque-cookie lookup.
    const jwt = request.headers.get('x-fixture-identity');
    const gatewayJwt = request.headers.get('x-fixture-gateway-identity') || '';
    const gatewayMode = request.headers.get('x-fixture-gateway-mode');
    const fixtureToken = '00000000-0000-4000-8000-000000000001.' + 'a'.repeat(43);
    const identity: WorkerIdentity = {
      begin: async () => { throw new Error('No fixture login'); },
      redeem: async () => ({ ok: false, status: 401 }),
      identities: async (token) => jwt && token === fixtureToken ? { ok: true, appJwt: jwt, gatewayJwt, workspaceJwt: null } : { ok: false, status: 401 },
      revoke: async () => ({}),
    };
    if (jwt) {
      const headers = new Headers(request.headers);
      headers.set('Cookie', `${SESSION_COOKIE}=${fixtureToken}`);
      headers.delete('x-fixture-identity');
      request = new Request(request.url, { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal });
    }
    return preview.fetch(request, {
      ...env,
      IDENTITY: identity,
      PREVIEW_IDENTITY: identity,
      PUBLIC_BASE_URL: env.TEST_BROWSER === 'true' ? new URL(request.url).origin : env.PUBLIC_BASE_URL,
      CAIL_IDENTITY_JWKS: env.TEST_JWKS,
      GATEWAY_MODEL: 'glm-5.2',
      GATEWAY: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const outbound = new Request(input, init);
        if (new URL(outbound.url).pathname.endsWith('/quota')) return Response.json({ object: 'quota', managed_by: 'cloudflare', state: 'estimated', unit: 'microdollar', currency: 'USD', limit: 1000000, estimated_used: 100000, estimated_remaining: 900000, used_percent: 10, remaining_percent: 90, window_seconds: 86400, window_technique: 'sliding', calculated_at: Math.floor(Date.now() / 1000) });
        gatewayCalls++;
        if (outbound.headers.get('x-cail-identity-jwt') !== gatewayJwt || outbound.headers.has('authorization')) throw new Error('fixture credential contract');
        const body = await outbound.json<{ model: string }>();
        if (body.model !== 'glm-5.2') throw new Error('fixture model contract');
        if (gatewayMode === 'pending') return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
        const requestId = '01900000-0000-7000-8000-000000000001';
        const error = { error: { code: 'quota_exceeded', type: 'quota_exceeded', param: null, message: 'private fixture', cail: { request_id: requestId, should_retry: false } } };
        if (gatewayMode === 'quota') return Response.json(error, { status: 429, headers: { 'x-should-retry': 'false', 'x-request-id': requestId } });
        const chunks = [{ choices: [{ delta: { content: 'Listen for the bass against the drums.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] },
          gatewayMode === 'trailing-error' ? error : { choices: [], usage: { total_tokens: 20 } }];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': requestId } });
      } } as Fetcher,
      ADMISSION_RESOLVER: { resolveMembership: async ({ subject }) => ({
        ok: true, expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 1,
        accessRole: subject === env.TEST_ADMIN ? 'admin' : 'member',
        budgetScope: subject === env.TEST_ADMIN ? 'admin' : 'person',
      }) },
    }, ctx);
  },
};
