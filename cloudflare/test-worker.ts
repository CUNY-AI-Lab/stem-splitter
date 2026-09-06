// Local test entrypoint only. Never referenced by the deployment config.
import preview, { type WorkerEnv } from './worker.ts';
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
    return preview.fetch(request, {
      ...env,
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
