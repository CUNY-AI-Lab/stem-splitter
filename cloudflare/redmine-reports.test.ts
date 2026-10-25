import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
// Dispatch the bundled adapter in Workerd with a synthetic outbound service.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

const base = 'https://tools.ailab.gc.cuny.edu/help/issues.json';
const report = { reportId: '77000000-0000-4000-8000-000000000001', subject: 'cail-'+'a'.repeat(32),
  description: 'Synthetic playback report.', origin: 'https://fixture.test', path: '/', release: 'fixture' };

test('Workerd Redmine transport saves once, refuses redirects without reading bodies, and only looks up uncertain deliveries', { timeout: 60000 }, async () => {
  let mode = 'saved', status = 302, destination = 'https://redirect.invalid/collect', posts = 0, gets = 0, redirects = 0, savedSubject = '';
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./test-redmine-worker.ts', import.meta.url))], bundle: true,
    format: 'esm', write: false, platform: 'browser', target: 'es2022' });
  const server = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-06', script: bundle.outputFiles[0].text,
    d1Databases: ['DB'], outboundService: async (request: Request) => {
      const url=new URL(request.url);
      if (url.origin+url.pathname !== base) {
        redirects++; assert.equal(request.headers.get('X-Redmine-API-Key'),null,'redirect destination must never receive a key');
        return new Response('must not follow');
      }
      assert.equal(request.headers.get('X-Redmine-API-Key'), 'synthetic-redmine-key');
      if (request.method === 'GET') {
        gets++;
        return Response.json({ total_count: mode === 'found' ? 1 : 0, issues: mode === 'found' ? [{ id: 42, subject: savedSubject }] : [] });
      }
      posts++;
      savedSubject = ((await request.json()) as any).issue.subject;
      if (mode === 'redirect' || mode === 'oversize-redirect' || mode === 'stalled-redirect') {
        const body = mode === 'oversize-redirect' ? 'x'.repeat(2*1024*1024+1)
          : mode === 'stalled-redirect' ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('pending')); } }) : '';
        return new Response(body, { status, headers: { Location: destination } });
      }
      if (mode === 'lost') throw new Error('Synthetic network failure');
      if (mode === 'rate') return new Response('', { status: 429 });
      if (mode === 'malformed') return new Response('invalid JSON synthetic-private-upstream', { status: 201 });
      if (mode === 'oversize') return new Response('x'.repeat(2*1024*1024+1), { status: 201 });
      return Response.json({ issue: { id: 42 } }, { status: 201 });
    },
  }));
  const fetch = (path: string, init?: RequestInit) => server.dispatchFetch('http://fixture.test'+path, init);
  try {
    await fetch('/schema', { method: 'POST', body: JSON.stringify(schemaStatements(await readFile(new URL('./redmine-reports.sql', import.meta.url), 'utf8'))) });
    let sequence = 0;
    const fresh = () => ({ ...report, subject: 'cail-'+sequence.toString(16).padStart(32,'0'), reportId: `77000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}` });
    const submit = async (value: any) => await (await fetch('/submit', { method: 'POST', body: JSON.stringify(value) })).json() as any;
    const receipt = async () => (await (await fetch('/receipts')).json() as any[]).at(-1);
    const first = fresh();
    assert.equal((await submit(first)).ok,true); assert.equal(posts,1);
    assert.equal((await submit(first)).ok,true); assert.equal(posts,1);
    assert.equal((await submit({...first,description:'Changed synthetic report'})).code,'idempotency_conflict'); assert.equal(posts,1);
    for (status of [301,302,303,307,308]) for (destination of ['https://redirect.invalid/collect','https://tools.ailab.gc.cuny.edu/redirect-target']) {
      mode='redirect'; const value=fresh(),before=posts;
      assert.equal((await submit(value)).code,'redmine_rejected');
      assert.equal((await receipt()).state,'rejected');
      assert.equal((await submit(value)).code,'redmine_rejected'); assert.equal(posts,before+1); assert.equal(redirects,0);
    }
    for (mode of ['oversize-redirect','stalled-redirect']) {
      const started=Date.now();
      assert.equal((await submit(fresh())).code,'redmine_rejected');
      assert.ok(Date.now()-started<3000,'redirect rejection must not wait for its response body');
      assert.equal((await receipt()).state,'rejected'); assert.equal(redirects,0);
    }
    for (mode of ['lost','malformed','oversize']) {
      const value=fresh(),before=posts;
      const result=await submit(value); assert.equal(result.code,'unavailable');
      assert.doesNotMatch(JSON.stringify(result),/synthetic-private-upstream|synthetic-redmine-key/);
      assert.equal((await receipt()).state,'pending');
      const reads=gets; assert.equal((await submit(value)).code,'unavailable'); assert.equal(gets,reads+1); assert.equal(posts,before+1);
      mode='found'; assert.equal((await submit(value)).ok,true); assert.equal(posts,before+1); assert.equal((await receipt()).state,'saved');
    }
    mode='rate'; const limited=fresh(),before=posts;
    assert.equal((await submit(limited)).code,'rate_limited'); assert.equal((await receipt()).state,'retryable');
    mode='saved'; await Promise.all([submit(limited),submit(limited)]); assert.equal(posts,before+2); assert.equal((await receipt()).state,'saved');
  } finally { await server.dispose(); }
});
