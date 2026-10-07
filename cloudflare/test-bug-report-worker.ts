// Local fixture only. This module is never referenced by deployment configuration.
import app from './worker.ts';
let mode = 'accepted';
let calls: unknown[] = [];
const reports = new Map<string, unknown>();
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const headers = new Headers(request.headers); headers.set('cf-connecting-ip', '192.0.2.5');
    request = new Request(request, { headers });
    const url = new URL(request.url);
    if (url.pathname === '/__bug-fixture') {
      if (request.method === 'POST') { mode = (await request.json<any>()).mode; calls = []; reports.clear(); }
      return Response.json({ mode, calls });
    }
    const service = { submit: async (report: any) => {
      calls.push(report);
      if (mode === 'unavailable') return { ok: false, code: 'unavailable', retryable: true, retryAfterSeconds: 1 };
      if (mode === 'unknown') return { ok: false, code: 'delivery_unknown', retryable: false, reportId: report.reportId };
      if (!reports.has(report.reportId)) reports.set(report.reportId, { ok: true, status: 'accepted', reportId: report.reportId });
      return reports.get(report.reportId);
    } };
    return app.fetch(request, { ...env, PUBLIC_BASE_URL: url.origin, BUG_REPORTS: service }, ctx);
  },
};
