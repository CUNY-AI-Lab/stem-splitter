// Synthetic transport fixture only. Never referenced by deployment configuration.
import { redmineReports } from './redmine-reports.ts';
export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const path = new URL(request.url).pathname;
    if (path === '/schema') {
      for (const statement of await request.json<string[]>()) await env.DB.prepare(statement).run();
      return new Response('seeded');
    }
    if (path === '/receipts') return Response.json((await env.DB.prepare('SELECT state,issue_id FROM bug_report_receipts ORDER BY rowid').all()).results);
    if (path === '/submit') return Response.json(await redmineReports(env.DB, 'synthetic-redmine-key').submitAuthenticated(await request.json()));
    return new Response('Not found', { status: 404 });
  },
};
