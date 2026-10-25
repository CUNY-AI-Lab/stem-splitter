import { publicSampleResource, readSampleResource } from '../src/song-sample-resource.ts';
import { isPlaylistSample, playlistSampleResponse } from '../src/playlist-samples.ts';
import { recordPageUse, recordServerUse, recordSignInUse } from '../src/reliability/observability.ts';
import { youtubeImportConfiguration } from '../src/youtube.ts';
import { logSplitError } from '../src/reliability/error-log.ts';
import { validateStemAudio } from './audio-validator.ts';
import { composeStemAudio } from './adaptive-audio.ts';
import app, { runReliableJobs, resumeAdaptiveOutput } from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { verifyCailIdentity } from './verify.ts';
import { gatewayForRequest, canonicalModel, gatewayModelsConfigured } from './gateway.ts';
import { authenticatedRequest, handleAuth, sanitizedRequest, publicApi, type WorkerIdentity } from './sso.ts';
import { guestConfigured, guestChatConfigured, hasMemberCookie, readGuestSession, revokeGuestSession, startGuestSession, clearGuestCookie, GUEST_COOKIE } from './guest.ts';
import { guestFailure } from '../src/guest/access.ts';
import { purgeExpiredListeningConversations } from './retention.ts';
import { purgeOperationContent } from '../src/reliability/retention.ts';
import { handleBugReport, type BugReportService } from './bug-reports.ts';
import { handleBugReport as handleDevBugReport, handleGuestBugReport, bugReportActor } from './dev-bug-reports.ts';
import { reportDelivery } from './report-delivery.ts';
import { redmineReports } from './redmine-reports.ts';
import { authorizeCailRequest, type AppPrincipal } from '../src/identity.ts';
import { intakeEnvironment, intakePauseResponse, type IntakePauseEnv } from './intake-pause.ts';
import { youtubeBrowserLoader } from './youtube-browser.ts';
import { refreshCourseUsageAccounts } from '../src/classroom/activity.ts';
export type WorkerEnv = Omit<Env, 'AUDIO' | 'DB' | 'ASSETS' | 'REQUEST_LIMIT'> &
  Pick<PreviewBindings, 'AUDIO' | 'DB' | 'ASSETS' | 'REQUEST_LIMIT'> &
  Partial<Pick<PreviewBindings, 'CANONICAL_BASE_URL'>> & IntakePauseEnv &
  { ADAPTIVE_OUTPUT?: Queue<{jobId:string}>; IDENTITY?: WorkerIdentity; PREVIEW_IDENTITY?: WorkerIdentity; GATEWAY?: Fetcher; GATEWAY_MODEL?: string; GATEWAY_FALLBACK_MODEL?: string; BUG_REPORTS?: BugReportService; REDMINE_API_KEY?: string; BUG_REPORT_MODE?: string };

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Native same-origin POST forms need their Origin for CSRF validation.
  // Continue suppressing referrers to other sites.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function adaptiveHandoff(env: WorkerEnv) {
  return env.ADAPTIVE_OUTPUT ? {deferAdaptiveOutput:async (jobId:string)=>{await env.ADAPTIVE_OUTPUT!.send({jobId},{delaySeconds:10});}} : {};
}

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
  return app.fetch(request, { ...env, ...adaptiveHandoff(env), ASSISTANT_MODEL: env.GATEWAY_MODEL,
    ASSISTANT_FALLBACK_MODELS: env.GATEWAY_FALLBACK_MODEL ?? '',
    assistantTransport: gateway.stream, assistantQuota: guest ? undefined : gateway.quota, verifyCailIdentity, validateStemAudio, composeStemAudio,
    fetchYouTubeBrowserAudio: youtubeBrowserLoader(env.BROWSER) }, ctx);
}

export default {
  async queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    env = intakeEnvironment(env);
    for (const message of batch.messages) {
      const body=message.body as {jobId?:unknown}|null;
      if (!body || typeof body.jobId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.jobId)) { message.ack(); continue; }
      try {
        const done=await resumeAdaptiveOutput({...env,validateStemAudio,composeStemAudio},body.jobId);
        if(done)message.ack();else message.retry({delaySeconds:15});
      } catch(error) {
        logSplitError('adaptive_queue_failed',body.jobId,'adaptive_output',error);
        message.retry({delaySeconds:30});
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    env = intakeEnvironment(env);
    ctx.waitUntil(runReliableJobs({...env,...adaptiveHandoff(env),guestRuntimeReady:guestConfigured(env),guestChatReady:guestChatConfigured(env),validateStemAudio,composeStemAudio}));
    ctx.waitUntil(env.DB.prepare('DELETE FROM guest_challenges WHERE expires_at<?').bind(Date.now()).run());
    ctx.waitUntil(refreshCourseUsageAccounts(env).catch(()=>{}));
    if (_controller.cron === '0 8 * * *') ctx.waitUntil(Promise.all([purgeExpiredListeningConversations(env.DB),purgeOperationContent(env.DB)]));
  },
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    env = intakeEnvironment(env);
    const url = new URL(request.url);
    if (['/sound-stations', '/sound-stations.html', '/sound-stations.js', '/sound-stations.json'].includes(url.pathname)) {
      return new Response('Not found', { status: 410, headers: { 'Cache-Control': 'no-store' } });
    }
    // The explicit alias shares this runtime through a service binding. Keep
    // browser writes and signed provider URLs on its origin without trusting
    // arbitrary Host/Forwarded headers or widening the CSRF allowlist.
    if (env.CANONICAL_BASE_URL && url.origin === env.CANONICAL_BASE_URL) {
      env = { ...env, PUBLIC_BASE_URL: env.CANONICAL_BASE_URL };
    }
    env = {...env,guestRuntimeReady:guestConfigured(env),guestChatReady:guestChatConfigured(env),guestStartAllowed:!hasMemberCookie(request),guestSession:undefined,guestClaimSession:undefined};
    let response: Response;
    try {
      const paused = intakePauseResponse(request, env);
      if (paused) {
        response = paused;
      } else if (url.pathname === '/healthz') {
        const db = await env.DB.prepare('SELECT 1 AS ready').first();
        const courseSchema = await env.DB.prepare("SELECT COUNT(*) AS present FROM sqlite_master WHERE type='table' AND name IN ('job_courses','app_operations')").first<{ present: number }>();
        response = Response.json({ ok: Boolean(db), release: env.RELEASE || 'preview', authMode: env.AUTH_MODE,
          remixer: env.REMIXER_ENABLED === 'true', production: false, intakePaused: env.INTAKE_PAUSED === 'true',
          courseAccess: courseSchema?.present === 2 && env.CAIL_CLASSROOM_ENABLED !== 'false' ? { contract: 'stem-course-v2' } : null,
          youtubeImport: youtubeBrowserLoader(env.BROWSER)
            ? {configuration:'configured',strategy:'cloudflare-browser'}
            : {configuration:youtubeImportConfiguration(env),strategy:'durable-pinned-provider'},
          listeningGuide: { configured: Boolean(env.GATEWAY && gatewayModelsConfigured(env.GATEWAY_MODEL,env.GATEWAY_FALLBACK_MODEL)),
            transport: 'cail-gateway', fallbackConfigured: gatewayModelsConfigured(env.GATEWAY_MODEL,env.GATEWAY_FALLBACK_MODEL) } });
      } else if (request.method === 'GET' && ['/search-samples.json','/api/song-samples'].includes(url.pathname)) {
        response = await publicSampleResource(env.DB,request);
      } else if (request.method === 'GET' && url.pathname === '/api/music/search' && (url.searchParams.has('sampleItem') || url.searchParams.has('sampleFile'))) {
        const resource=await readSampleResource(env.DB);
        const allowed=resource.settings.enabled ? resource.settings.tracks : [];
        if(!isPlaylistSample(request,allowed))response=Response.json({error:'Choose a current playlist suggestion.'},{status:401,headers:{'Cache-Control':'no-store'}});
        else {
        const limited = env.REQUEST_LIMIT ? await env.REQUEST_LIMIT.limit({ key: 'playlist-sample:' + (request.headers.get('cf-connecting-ip') || 'unknown') }) : { success: true };
        response = limited.success
          ? await playlistSampleResponse(request, typeof caches !== 'undefined' ? caches.default : undefined, allowed)
          : Response.json({ results: [] }, { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
        }
      } else if (request.method === 'GET' && url.pathname === '/api/bug-reports/availability') {
        response = Response.json({ enabled: env.BUG_REPORT_MODE === 'redmine' ? Boolean(env.REDMINE_API_KEY) : Boolean(env.REDMINE_API_KEY || env.BUG_REPORTS), ...(env.BUG_REPORT_MODE === 'redmine-fallback' ? { mode: 'contact', delivery: 'redmine-or-email' } : env.BUG_REPORT_MODE === 'redmine' || env.REDMINE_API_KEY ? { mode: 'contact', delivery: 'redmine' } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
      } else if (env.BUG_REPORT_MODE === 'redmine' && !env.REDMINE_API_KEY && url.pathname.startsWith('/api/bug-reports')) {
        response = Response.json({ ok: false, code: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      } else if ((env.REDMINE_API_KEY || env.BUG_REPORT_MODE === 'redmine-fallback') && url.pathname === '/api/bug-reports/guest') {
        const ip = request.headers.get('cf-connecting-ip');
        response = ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip)
          ? await handleGuestBugReport(request, { origin: env.PUBLIC_BASE_URL, release: env.RELEASE,
            rateKey: await bugReportActor(`guest-report-ip:v1\n${env.REDMINE_API_KEY ?? new Date().toISOString().slice(0,10)}\n${ip}`),
            service: env.BUG_REPORT_MODE === 'redmine-fallback' ? reportDelivery(env.DB, env.REDMINE_API_KEY, env.BUG_REPORTS) : redmineReports(env.DB, env.REDMINE_API_KEY!), limiter: env.REQUEST_LIMIT })
          : Response.json({ ok: false, code: 'unavailable' }, { status: 503 });
      } else if ((env.REDMINE_API_KEY || env.BUG_REPORT_MODE === 'redmine-fallback') && ['/api/bug-reports', '/api/bug-reports/session'].includes(url.pathname)) {
        const internal = await authenticatedRequest(request, env);
        if (internal instanceof Response) response = internal;
        else {
          let principal: AppPrincipal | undefined;
          const denied = await authorizeCailRequest(internal, { ...env, verifyCailIdentity }, value => { principal = value; });
          response = denied ?? (principal
            ? await handleDevBugReport(internal, { origin: env.PUBLIC_BASE_URL, subject: principal.subject,
              preferredName: principal.preferredName, release: env.RELEASE,
              service: env.BUG_REPORT_MODE === 'redmine-fallback' ? reportDelivery(env.DB, env.REDMINE_API_KEY, env.BUG_REPORTS) : redmineReports(env.DB, env.REDMINE_API_KEY!), limiter: env.REQUEST_LIMIT })
            : Response.json({ ok: false, code: 'unavailable' }, { status: 503 }));
        }
      } else if (['/api/bug-reports', '/api/bug-reports/session'].includes(url.pathname)) {
        response = await handleBugReport(request, { origin: env.PUBLIC_BASE_URL,
          release: env.RELEASE, service: env.BUG_REPORTS, limiter: env.REQUEST_LIMIT });
      } else if (env.AUTH_MODE !== 'cail') {
        response = Response.json({ error: 'Service configuration is incomplete.' }, { status: 503 });
      } else if (url.pathname === '/auth/guest') {
        response = await startGuestSession(request,env);
      } else if (url.pathname.startsWith('/auth/')) {
        const started = Date.now();
        response = await handleAuth(request, {...env,guestSignout:()=>revokeGuestSession(request,env)});
        ctx.waitUntil(recordSignInUse(env,request,response,started));
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
        if (!(internal instanceof Response) && hasMemberCookie(request) && request.method==='POST' && url.pathname==='/api/account/claim-guest') {
          env={...env,guestClaimSession:(await readGuestSession(request,env))??undefined};
        }
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
    if ((url.pathname.startsWith('/api/') && !(['/api/song-samples','/api/music/search'].includes(url.pathname) && response.headers.get('Cache-Control')?.startsWith('public'))) || url.pathname.startsWith('/auth/') || url.pathname === '/healthz') headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<WorkerEnv>;
