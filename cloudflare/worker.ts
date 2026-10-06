import { recordPageUse, recordServerUse } from '../src/reliability/observability.ts';
import { youtubeImportConfiguration } from '../src/youtube.ts';
import { validateStemAudio } from './audio-validator.ts';
import app, { runReliableJobs } from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { verifyCailIdentity } from './verify.ts';
import { gatewayForRequest, canonicalModel, gatewayModelsConfigured } from './gateway.ts';
import { authenticatedRequest, handleAuth, sanitizedRequest, publicApi, type WorkerIdentity } from './sso.ts';
import { guestConfigured, hasMemberCookie, readGuestSession, revokeGuestSession, startGuestSession, clearGuestCookie, GUEST_COOKIE } from './guest.ts';
import { guestFailure } from '../src/guest/access.ts';
import { purgeExpiredListeningConversations } from './retention.ts';
import { purgeOperationContent } from '../src/reliability/retention.ts';
export type WorkerEnv = Omit<Env, 'AUDIO' | 'DB' | 'ASSETS' | 'REQUEST_LIMIT'> &
  Pick<PreviewBindings, 'AUDIO' | 'DB' | 'ASSETS' | 'REQUEST_LIMIT'> &
  Partial<Pick<PreviewBindings, 'CANONICAL_BASE_URL'>> &
  { IDENTITY?: WorkerIdentity; PREVIEW_IDENTITY?: WorkerIdentity; GATEWAY?: Fetcher; GATEWAY_MODEL?: string; GATEWAY_FALLBACK_MODEL?: string };

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Native same-origin POST forms need their Origin for CSRF validation.
  // Continue suppressing referrers to other sites.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

async function serveApi(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !path.startsWith('/api/webhooks/')) {
    if (!env.REQUEST_LIMIT) return Response.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
    const key = request.headers.get('cf-connecting-ip') || 'unknown';
    const limited = await env.REQUEST_LIMIT.limit({ key: `stem-preview:${key}` });
    if (!limited.success) {
      const response=Response.json({ error: 'Please wait a moment and try again.' }, { status: 429, headers: { 'Retry-After': '60' } });
      ctx.waitUntil(recordServerUse(env,request,response,undefined,Date.now()));return response;
    }
  }
  const guest = Boolean(env.guestSession);
  const gateway = gatewayForRequest(env.GATEWAY, guest ? env.GUEST_GATEWAY_API_KEY ?? null : request.headers.get('x-cail-gateway-identity-jwt'), request, env.RELEASE || 'candidate',guest?'key':'jwt');
  return app.fetch(request, { ...env, ASSISTANT_MODEL: env.GATEWAY_MODEL,
    ASSISTANT_FALLBACK_MODELS: env.GATEWAY_FALLBACK_MODEL ?? '',
    assistantTransport: gateway.stream, assistantQuota: guest ? undefined : gateway.quota, verifyCailIdentity, validateStemAudio }, ctx);
}

export default {
  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReliableJobs({...env,guestRuntimeReady:guestConfigured(env),validateStemAudio}));
    ctx.waitUntil(env.DB.prepare('DELETE FROM guest_challenges WHERE expires_at<?').bind(Date.now()).run());
    if (_controller.cron === '0 8 * * *') ctx.waitUntil(Promise.all([purgeExpiredListeningConversations(env.DB),purgeOperationContent(env.DB)]));
  },
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The explicit alias shares this runtime through a service binding. Keep
    // browser writes and signed provider URLs on its origin without trusting
    // arbitrary Host/Forwarded headers or widening the CSRF allowlist.
    if (env.CANONICAL_BASE_URL && url.origin === env.CANONICAL_BASE_URL) {
      env = { ...env, PUBLIC_BASE_URL: env.CANONICAL_BASE_URL };
    }
    env = {...env,guestRuntimeReady:guestConfigured(env),guestStartAllowed:!hasMemberCookie(request),guestSession:undefined};
    let response: Response;
    try {
      if (url.pathname === '/healthz') {
        const db = await env.DB.prepare('SELECT 1 AS ready').first();
        response = Response.json({ ok: Boolean(db), release: env.RELEASE || 'preview', authMode: env.AUTH_MODE,
          remixer: env.REMIXER_ENABLED === 'true', production: false,
          youtubeImport: {configuration:youtubeImportConfiguration(env),strategy:'durable-pinned-provider'},
          listeningGuide: { configured: Boolean(env.GATEWAY && gatewayModelsConfigured(env.GATEWAY_MODEL,env.GATEWAY_FALLBACK_MODEL)),
            transport: 'cail-gateway', fallbackConfigured: gatewayModelsConfigured(env.GATEWAY_MODEL,env.GATEWAY_FALLBACK_MODEL) } });
      } else if (env.AUTH_MODE !== 'cail') {
        response = Response.json({ error: 'Service configuration is incomplete.' }, { status: 503 });
      } else if (url.pathname === '/auth/guest') {
        response = await startGuestSession(request,env);
      } else if (url.pathname.startsWith('/auth/')) {
        response = await handleAuth(request, {...env,guestSignout:()=>revokeGuestSession(request,env)});
      } else if (url.pathname.startsWith('/api/')) {
        // Admission and ownership run in the shared application. Limit expensive
        // ingress before provider work; signed provider callbacks are independent.
        let internal: Request | Response;
        if (!publicApi(request) && !hasMemberCookie(request) && env.guestRuntimeReady) {
          const session=await readGuestSession(request,env);
          if (session) {env={...env,guestSession:session};internal=sanitizedRequest(request);}
          else if ((request.headers.get('cookie') ?? '').split(';').some(part=>part.trim().split('=',1)[0]===GUEST_COOKIE)) {
            internal=guestFailure('guest_session_expired',401,'This guest session has ended. Start a new guest session or sign in.');
            internal.headers.append('Set-Cookie',clearGuestCookie());
          } else internal=await authenticatedRequest(request,env);
        } else internal=await authenticatedRequest(request,env);
        if(internal instanceof Response)ctx.waitUntil(recordServerUse(env,request,internal,undefined,Date.now()));
        response = internal instanceof Response ? internal : await serveApi(internal, { ...env, CAIL_LOGIN_URL: '/auth/login' }, ctx);
      } else {
        response = env.ASSETS ? await env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
        if(request.method==='GET'&&['/','/index.html','/account.html','/teacher.html','/classroom.html'].includes(url.pathname))ctx.waitUntil(recordPageUse(env,response));
      }
    } catch {
      // No provider body, private URL, SQL error, or identity enters logs.
      response = Response.json({ error: 'The service is temporarily unavailable. Please try again.' }, { status: 503 });
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
    if (env.guestRuntimeReady) headers.set('Content-Security-Policy',HEADERS['Content-Security-Policy']
      .replace("script-src 'self';","script-src 'self' https://challenges.cloudflare.com;")
      .replace("connect-src 'self';","connect-src 'self' https://challenges.cloudflare.com;")
      + '; frame-src https://challenges.cloudflare.com');
    if (url.pathname.startsWith('/auth/')) headers.set('Referrer-Policy', 'no-referrer');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/healthz') headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<WorkerEnv>;
