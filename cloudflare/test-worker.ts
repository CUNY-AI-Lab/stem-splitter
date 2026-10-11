import { pollYouTubeImport } from '../src/youtube.ts';
import { validateStemAudio } from './audio-validator.ts';
import { courseFixture } from './course-fixture.ts';
import { STEM_COURSE_ID } from '../src/classroom/contract.ts';
// Local test entrypoint only. Never referenced by the deployment config.
import preview, { type WorkerEnv } from './worker.ts';
import { purgeExpiredListeningConversations } from './retention.ts';
import { SESSION_COOKIE, type WorkerIdentity } from './sso.ts';
type TestEnv = WorkerEnv & { TEST_JWKS: string; TEST_ADMIN: string; TEST_BROWSER?: string; TEST_ROSTER_SUBJECT?: string };
let gatewayCalls = 0;
let gatewayMessages: Array<{ role: string; content: string }> = [];
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
    if(new URL(request.url).pathname==='/__fixture/inline-import'&&request.headers.get('x-fixture')==='local-only') {const audio=await pollYouTubeImport('inline-memory-fixture',{...env,REPLICATE_API_TOKEN:'test-replicate-token-000',REPLICATE_YT_MODEL:'test/fixture',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64)});return Response.json({bytes:audio?.data.byteLength});}
    if(new URL(request.url).pathname==='/__fixture/validate-audio'&&request.headers.get('x-fixture')==='local-only')return Response.json({valid:await validateStemAudio(await request.arrayBuffer())});
    if(new URL(request.url).pathname==='/__fixture/operations'&&request.headers.get('x-fixture')==='local-only')return Response.json((await env.DB.prepare('SELECT id,state,phase,error_code,fence,lease_until,not_before FROM app_operations').all()).results);
    if (new URL(request.url).pathname === '/__fixture/gateway-messages' && request.headers.get('x-fixture') === 'local-only') return Response.json({ messages: gatewayMessages });
    if (new URL(request.url).pathname === '/__fixture/purge-conversations' && request.headers.get('x-fixture') === 'local-only') {
      return Response.json({ deleted: await purgeExpiredListeningConversations(env.DB) });
    }
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
    const courseOwner=request.headers.get('x-fixture-course-role')==='owner';
    const courseRevoked=request.headers.get('x-fixture-course-state')==='revoked';
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
      GATEWAY_FALLBACK_MODEL: 'deepseek-v4-flash-0731',
      GATEWAY: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const outbound = new Request(input, init);
        if (new URL(outbound.url).pathname.endsWith('/quota')) return Response.json({ object: 'quota', managed_by: 'cloudflare', state: 'estimated', unit: 'microdollar', currency: 'USD', limit: 1000000, estimated_used: 100000, estimated_remaining: 900000, used_percent: 10, remaining_percent: 90, window_seconds: 86400, window_technique: 'sliding', calculated_at: Math.floor(Date.now() / 1000) });
        gatewayCalls++;
        if (env.GUEST_ENABLED === 'true' && outbound.headers.get('authorization') === `Bearer ${env.GUEST_GATEWAY_API_KEY}`) {
          if(outbound.headers.has('x-cail-identity-jwt'))throw new Error('fixture mixed credential contract');
        } else if (outbound.headers.get('x-cail-identity-jwt') !== gatewayJwt || outbound.headers.has('authorization')) throw new Error('fixture credential contract');
        const body = await outbound.json<{ model: string }>();
        if (body.model !== 'glm-5.2') throw new Error('fixture model contract');
        if ('messages' in body && Array.isArray((body as { messages?: unknown }).messages)) gatewayMessages = (body as { messages: Array<{ role: string; content: string }> }).messages;
        if (gatewayMode === 'pending') return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
        const requestId = '01900000-0000-7000-8000-000000000001';
        const error = { error: { code: 'quota_exceeded', type: 'quota_exceeded', param: null, message: 'private fixture', cail: { request_id: requestId, should_retry: false } } };
        if (gatewayMode === 'quota') return Response.json(error, { status: 429, headers: { 'x-should-retry': 'false', 'x-request-id': requestId } });
        const chunks = [{ choices: [{ delta: { content: gatewayMode==='empty'?'':'Listen for the bass against the drums.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] },
          gatewayMode === 'trailing-error' ? error : { choices: [], usage: { total_tokens: 20 } }];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': requestId } });
      } } as Fetcher,
      ADMISSION_RESOLVER: {
        resolveCourseAccess: async ({subject,classId}) => courseRevoked?{ok:false,code:'revoked',retryable:false}:courseFixture(subject,classId,courseOwner),
        listCourseAssignments: async ({subject}) => {const assignment=await courseFixture(subject,STEM_COURSE_ID,courseOwner);return {ok:true,checkedAt:assignment.checkedAt,expiresAt:assignment.expiresAt,revision:1,assignments:[(({ok,...row})=>row)(assignment)],nextCursor:null};},
        listCourseRoster: async ({subject,classId}) => {const assignment=await courseFixture(subject,classId,true);return {ok:true,classId,checkedAt:assignment.checkedAt,expiresAt:assignment.expiresAt,revision:1,participants:env.TEST_ROSTER_SUBJECT?await Promise.all([env.TEST_ROSTER_SUBJECT,'cail-00000000000000000000000000000000'].map(async member=>{const row=await courseFixture(member,classId);return {memberId:row.memberId,displayName:member===env.TEST_ROSTER_SUBJECT?'Fixture Student with a long preferred display name':'Zero split student',displayNameSource:row.displayNameSource,startsAt:row.startsAt,expiresAt:row.expiresAt};})):[],nextCursor:null};},
        resolveMembership: async ({ subject }) => ({
        ok: true, expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 1,
        accessRole: subject === env.TEST_ADMIN ? 'admin' : 'member',
        budgetScope: subject === env.TEST_ADMIN ? 'admin' : 'person',
      }) },
    }, ctx);
  },
};
