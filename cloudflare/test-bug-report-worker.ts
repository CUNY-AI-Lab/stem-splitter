// Local signed-session fixture only; never referenced by deployment configuration.
import app from './worker.ts';
let mode = 'saved', expired = false, limitReports = false, reportMode: string | undefined;
const calls: any[] = [], reports = new Map<string, any>();
const aliceSession = '11111111-1111-4111-8111-111111111111.' + 'a'.repeat(43);
const bobSession = '22222222-2222-4222-8222-222222222222.' + 'b'.repeat(43);
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/__bug-fixture') {
      if (request.method === 'POST') {
        const input = await request.json<any>();
        if (input.sql) for (const sql of input.sql) await env.DB.prepare(sql).run();
        if (input.mode) mode = input.mode;
        if ('reportMode' in input) reportMode = input.reportMode;
        if (typeof input.expired === 'boolean') expired = input.expired;
        if (typeof input.limitReports === 'boolean') limitReports = input.limitReports;
      }
      return Response.json({ mode, expired, calls, records: [...reports.values()] });
    }
    const headers = new Headers(request.headers); headers.set('cf-connecting-ip', '192.0.2.5');
    request = new Request(request, { headers });
    const service = { submitPublic: async (report: any) => {
      calls.push(report);
      if (mode === 'unavailable') return { ok: false, code: 'unavailable', retryable: true, retryAfterSeconds: 1 };
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 300));
      const key = report.reportId, previous = reports.get(key);
      if (previous && previous.description !== report.description) return { ok: false, code: 'idempotency_conflict', retryable: false };
      if (!previous) reports.set(key, { ...report });
      if (mode === 'lost-ack') { mode = 'saved'; throw new Error('Injected lost acknowledgement after persistence'); }
      return { ok: true, status: 'accepted', reportId: report.reportId };
    } };
    const identity = { identities: async (token: string) => !expired && [aliceSession, bobSession].includes(token)
      ? { ok: true, appJwt: token === aliceSession ? env.TEST_ALICE_JWT : env.TEST_BOB_JWT, gatewayJwt: '', workspaceJwt: null }
      : { ok: false, status: 401 } };
    return app.fetch(request, { ...env, PUBLIC_BASE_URL: url.origin, CANONICAL_BASE_URL: url.origin,
      CAIL_IDENTITY_JWKS: env.TEST_JWKS, IDENTITY: identity, BUG_REPORTS: service, BUG_REPORT_MODE: reportMode,
      REQUEST_LIMIT: limitReports && url.pathname.startsWith('/api/bug-reports') ? { limit: async () => ({ success: false }) } : env.REQUEST_LIMIT,
      ADMISSION_RESOLVER: { resolveMembership: async () => ({ ok: true, expiresAt: new Date(Date.now() + 60000).toISOString(),
        revision: 1, accessRole: 'member', budgetScope: 'person' }) },
    }, ctx);
  },
};
