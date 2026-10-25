// Local synthetic transport only; never deployed.
import { reportDelivery } from './report-delivery.ts';
export default { async fetch(request: Request, env: { DB: D1Database; MAIL: Fetcher }) {
  const path = new URL(request.url).pathname;
  if (path === '/schema') { for (const sql of await request.json<string[]>()) await env.DB.prepare(sql).run(); return new Response('ok'); }
  if (path === '/receipts') return Response.json((await env.DB.prepare('SELECT * FROM bug_report_deliveries ORDER BY rowid').all()).results);
  const {report,key,mail=true} = await request.json<any>();
  const adapter=reportDelivery(env.DB,key,mail ? {submitPublic: async data => (await env.MAIL.fetch('https://mail.test/',{method:'POST',body:JSON.stringify(data)})).json()} : undefined);
  return Response.json(await (report.contact ? adapter.submitGuest!(report) : adapter.submitAuthenticated(report)));
} };
