// Local test entrypoint only. Never referenced by the deployment config.
import preview, { type WorkerEnv } from './worker.ts';
import { SESSION_COOKIE, type WorkerIdentity } from './sso.ts';
type TestEnv = WorkerEnv & { TEST_JWKS: string; TEST_ADMIN: string; TEST_BROWSER?: string };
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
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
    const fixtureToken = '00000000-0000-4000-8000-000000000001.' + 'a'.repeat(43);
    const identity: WorkerIdentity = {
      begin: async () => { throw new Error('No fixture login'); },
      redeem: async () => ({ ok: false, status: 401 }),
      identities: async (token) => jwt && token === fixtureToken ? { ok: true, appJwt: jwt, gatewayJwt: '', workspaceJwt: null } : { ok: false, status: 401 },
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
      ADMISSION_RESOLVER: { resolveMembership: async ({ subject }) => ({
        ok: true, expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 1,
        accessRole: subject === env.TEST_ADMIN ? 'admin' : 'member',
        budgetScope: subject === env.TEST_ADMIN ? 'admin' : 'person',
      }) },
    }, ctx);
  },
};
