import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { verifyCailIdentity } from './verify.ts';
export type WorkerEnv = Omit<Env, 'AUDIO' | 'DB' | 'ASSETS' | 'REQUEST_LIMIT'> &
  Pick<PreviewBindings, 'AUDIO' | 'DB' | 'ASSETS' | 'REQUEST_LIMIT'>;

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

async function serveApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !path.startsWith('/api/webhooks/')) {
    if (!env.REQUEST_LIMIT) return Response.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
    const key = request.headers.get('cf-connecting-ip') || 'unknown';
    const limited = await env.REQUEST_LIMIT.limit({ key: `stem-preview:${key}` });
    if (!limited.success) return Response.json({ error: 'Please wait a moment and try again.' }, { status: 429, headers: { 'Retry-After': '60' } });
  }
  return app.fetch(request, { ...env, verifyCailIdentity }, ctx);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (url.pathname === '/healthz') {
        const db = await env.DB.prepare('SELECT 1 AS ready').first();
        response = Response.json({ ok: Boolean(db), release: env.RELEASE || 'preview', authMode: env.AUTH_MODE,
          remixer: env.REMIXER_ENABLED === 'true', production: false });
      } else if (env.AUTH_MODE !== 'cail') {
        response = Response.json({ error: 'Service configuration is incomplete.' }, { status: 503 });
      } else if (url.pathname.startsWith('/api/')) {
        // Admission and ownership run in the shared application. Limit expensive
        // ingress before provider work; signed provider callbacks are independent.
        response = await serveApi(request, env, ctx);
      } else {
        response = env.ASSETS ? await env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      }
    } catch {
      // No provider body, private URL, SQL error, or identity enters logs.
      response = Response.json({ error: 'The service is temporarily unavailable. Please try again.' }, { status: 503 });
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<WorkerEnv>;
