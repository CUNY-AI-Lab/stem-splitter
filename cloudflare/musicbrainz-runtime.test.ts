import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { preserveWorkerRequestInit } from './test-outbound-request.mjs';

test('workerd: optional recording metadata, brief outage recovery and caching', async () => {
  const issuer = await createTestIdentityIssuer();
  const id = '12345678-1234-1234-1234-123456789012';
  const recording = { id, title: 'Worker fixture melody', 'artist-credit': [{ name: 'Fixture artist' }] };
  let mode = 'ready';
  const starts: number[] = [];
  const network = setupServer(
    http.get('https://archive.org/advancedsearch.php', () => HttpResponse.json({ response: { docs: [] } })),
    http.get('https://archive.org/metadata/fixture-reference', () => HttpResponse.json({ metadata: { title: 'Unavailable fixture', creator: 'Fixture artist', mediatype: 'audio', subject: 'Music' }, files: [] })),
    http.get('https://commons.wikimedia.org/w/api.php', () => HttpResponse.json({ query: { pages: [] } })),
    http.get('https://musicbrainz.org/ws/2/recording/*', ({ request }) => {
      starts.push(Date.now());
      assert.match(request.headers.get('user-agent')!, /StemSplitter.*CUNY-AI-Lab/);
      assert.equal(request.headers.has('authorization'), false);
      assert.equal(request.headers.has('cookie'), false);
      if (mode === 'retry' && starts.length === 1) return HttpResponse.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': '0' } });
      if (new URL(request.url).pathname.split('/').at(-1)?.length === 36) return HttpResponse.json({ ...recording, id: new URL(request.url).pathname.split('/').at(-1),
        relations: [{ 'target-type': 'url', type: 'free download', url: { resource: 'https://archive.org/details/fixture-reference' } }] });
      return HttpResponse.json({ recordings: [recording] });
    }),
  );
  network.listen({ onUnhandledRequest: 'error' });
  let restoreFetch: (() => void) | undefined;
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_NO_COURSES: 'true' } }] });
  try {
    await harness.listen();
    restoreFetch = preserveWorkerRequestInit();
    const worker = harness.getWorker();
    const schema = await worker.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' },
      body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
    assert.equal(schema.status, 200);
    const identity = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
    const get = async (path: string) => {
      const response = await worker.fetch(path, { headers: { 'x-fixture-identity': identity } });
      assert.equal(response.status, 200); return await response.json() as any;
    };
    const detail = await get('/api/music/recordings/' + id);
    assert.equal(detail.id, id); assert.equal(detail.kind, 'metadata');
    assert.equal(detail.sourceUrl, 'https://musicbrainz.org/recording/' + id);
    assert.ok(!detail.downloadUrl && !detail.openAudio);
    assert.deepEqual(detail.relations, [{ label: 'free download · archive.org', url: 'https://archive.org/details/fixture-reference' }]);
    assert.equal(starts.length, 1);
    await get('/api/music/recordings/' + id); assert.equal(starts.length, 1, 'metadata cache prevents another request');

    mode = 'retry'; starts.length = 0;
    const recovered = await get('/api/music/recordings/12345678-1234-1234-1234-123456789013');
    assert.equal(recovered.kind, 'metadata'); assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 1000, String(starts));

    assert.deepEqual((await get('/api/jobs')).jobs, []);
  } finally { await harness.close(); restoreFetch?.(); network.close(); }
});
