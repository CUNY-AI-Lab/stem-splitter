import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { captureRailwayBaseline } from '../scripts/lib/railway-baseline.mjs';

function listen(handler: Parameters<typeof createServer>[0]): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('Railway baseline capture proves the frozen four-track output without leaking auth', async () => {
  const requests: Array<{ method?: string; url?: string; auth?: string; body?: string }> = [];
  let base = '';
  const fixture = await listen(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers['x-class-code'] as string | undefined,
      body,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/healthz') return response.end('{"ok":true}');
    if (request.url === '/api/separation-options') {
      return response.end(
        JSON.stringify({
          backend: 'replicate',
          defaultModel: 'htdemucs_ft',
          models: [
            {
              id: 'htdemucs_ft',
              stems: ['vocals', 'drums', 'bass', 'other'],
              engine: 'DEMUCS',
            },
          ],
        })
      );
    }
    if (request.url === '/api/uploads' && request.method === 'POST') {
      return response.end(JSON.stringify({ key: 'uploads/test/source.mp3', uploadUrl: `${base}/put` }));
    }
    if (request.url === '/put' && request.method === 'PUT') return response.end('{}');
    if (request.url === '/api/jobs' && request.method === 'POST') {
      return response.end(JSON.stringify({ id: 'job-1' }));
    }
    if (request.url === '/api/jobs/job-1') {
      return response.end(
        JSON.stringify({
          id: 'job-1',
          status: 'done',
          model: 'htdemucs_ft',
          expectedStems: ['vocals', 'drums', 'bass', 'other'],
          stems: ['vocals', 'drums', 'bass', 'other'].map((name) => ({
            name,
            url: `/api/files/stems/job-1/${name}.mp3`,
          })),
        })
      );
    }
    const stem = request.url?.match(/^\/api\/files\/stems\/job-1\/(.+)\.mp3$/)?.[1];
    if (stem) {
      response.setHeader('content-type', 'audio/mpeg');
      return response.end(Buffer.from(`ID3-${stem}`));
    }
    response.statusCode = 404;
    response.end('{"error":"not found"}');
  });
  base = fixture.base;

  try {
    const result = await captureRailwayBaseline({
      base,
      classCode: 'never-print-this',
      sourceBytes: Buffer.from('authorized-audio'),
      filename: 'authorized.mp3',
      pollMs: 1,
      timeoutMs: 1000,
    });
    assert.equal(result.job.status, 'done');
    assert.equal(result.job.model, 'htdemucs_ft');
    assert.deepEqual(result.stems.map((stem) => stem.name), ['vocals', 'drums', 'bass', 'other']);
    assert.equal(new Set(result.stems.map((stem) => stem.sha256)).size, 4);
    assert.equal(JSON.stringify(result).includes('never-print-this'), false);
    assert.deepEqual(JSON.parse(requests.find((entry) => entry.url === '/api/jobs')!.body!), {
      key: 'uploads/test/source.mp3',
      filename: 'authorized.mp3',
      model: 'htdemucs_ft',
    });
    assert.equal(requests.find((entry) => entry.url === '/api/jobs')!.auth, 'never-print-this');
    assert.equal(requests.find((entry) => entry.url === '/put')!.auth, 'never-print-this');
  } finally {
    await fixture.close();
  }
});
