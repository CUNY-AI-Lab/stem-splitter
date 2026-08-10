import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  captureRailwayBaseline,
  downloadRailwayBaselineStems,
} from '../scripts/lib/railway-baseline.mjs';

function fakeMp3(marker: string): Buffer {
  const bytes = Buffer.alloc(2048, marker.charCodeAt(0));
  bytes.set([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0], 0);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 10);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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
    if (request.url === '/healthz') {
      return response.end(JSON.stringify({ ok: true, base, promptSchema: 'ready' }));
    }
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
      return response.end(fakeMp3(stem));
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

test('Railway baseline refuses plaintext remote origins before sending the class code', async () => {
  let called = false;
  await assert.rejects(
    () =>
      captureRailwayBaseline({
        base: 'http://railway.example',
        classCode: 'never-print-this',
        sourceBytes: Buffer.from('authorized-audio'),
        filename: 'authorized.mp3',
        fetchImpl: async () => {
          called = true;
          throw new Error('must not fetch');
        },
      }),
    /HTTPS origin/
  );
  assert.equal(called, false);
});

test('listening bundle download reuses one frozen job and rejects byte drift', async () => {
  const expectedStems = ['vocals', 'drums', 'bass', 'other'];
  const stemBytes = Object.fromEntries(expectedStems.map((name) => [name, fakeMp3(name)]));
  let base = '';
  let receivedClassCode = false;
  const fixture = await listen((request, response) => {
    receivedClassCode ||= request.headers['x-class-code'] !== undefined;
    if (request.url === '/healthz') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ ok: true, base, promptSchema: 'ready' }));
    }
    if (request.url === '/api/separation-options') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({
        backend: 'replicate',
        defaultModel: 'htdemucs_ft',
        models: [{ id: 'htdemucs_ft', stems: expectedStems, engine: 'DEMUCS' }],
      }));
    }
    if (request.url === '/api/jobs/frozen-job') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({
        id: 'frozen-job',
        status: 'done',
        model: 'htdemucs_ft',
        expectedStems,
        stems: expectedStems.map((name) => ({ name, url: `/stems/${name}.mp3` })),
      }));
    }
    const stem = request.url?.match(/^\/stems\/(.+)\.mp3$/)?.[1];
    if (stem && stem in stemBytes) {
      response.setHeader('content-type', 'audio/mpeg');
      return response.end(stemBytes[stem]);
    }
    response.statusCode = 404;
    response.end();
  });
  base = fixture.base;
  const baseline = {
    base,
    catalogue: {
      backend: 'replicate',
      defaultModel: 'htdemucs_ft',
      model: { id: 'htdemucs_ft', stems: expectedStems, engine: 'DEMUCS' },
    },
    job: { id: 'frozen-job', model: 'htdemucs_ft', expectedStems },
    stems: expectedStems.map((name) => ({
      name,
      bytes: stemBytes[name].byteLength,
      sha256: sha256(stemBytes[name]),
    })),
  };

  try {
    const downloaded = await downloadRailwayBaselineStems({ baseline });
    assert.deepEqual(downloaded.stems.map((stem) => stem.name), expectedStems);
    assert.deepEqual(
      downloaded.stems.map((stem) => stem.sha256),
      baseline.stems.map((stem) => stem.sha256)
    );
    assert.equal(receivedClassCode, false);

    const drifted = structuredClone(baseline);
    drifted.stems[0].sha256 = '0'.repeat(64);
    await assert.rejects(
      () => downloadRailwayBaselineStems({ baseline: drifted }),
      /drifted from the frozen bytes/
    );
  } finally {
    await fixture.close();
  }
});

test('Railway baseline does not reflect an authentication secret from an error body', async () => {
  let base = '';
  const fixture = await listen((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/healthz') {
      return response.end(JSON.stringify({ ok: true, base, promptSchema: 'ready' }));
    }
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
    response.statusCode = 403;
    return response.end('{"error":"never-print-this"}');
  });
  base = fixture.base;

  try {
    await assert.rejects(
      () =>
        captureRailwayBaseline({
          base,
          classCode: 'never-print-this',
          sourceBytes: Buffer.from('authorized-audio'),
          filename: 'authorized.mp3',
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'upload allocation failed (403)' &&
        !error.message.includes('never-print-this')
    );
  } finally {
    await fixture.close();
  }
});

test('Railway baseline rejects an ID3 marker with no MPEG audio frame', async () => {
  const expectedStems = ['vocals', 'drums', 'bass', 'other'];
  let base = '';
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, base, promptSchema: 'ready' });
    }
    if (url.pathname === '/api/separation-options') {
      return Response.json({
        backend: 'replicate',
        defaultModel: 'htdemucs_ft',
        models: [{ id: 'htdemucs_ft', stems: expectedStems, engine: 'DEMUCS' }],
      });
    }
    if (url.pathname === '/api/uploads' && init?.method === 'POST') {
      return Response.json({ key: 'uploads/test/source.mp3', uploadUrl: `${base}/put` });
    }
    if (url.pathname === '/put' && init?.method === 'PUT') return new Response(null, { status: 204 });
    if (url.pathname === '/api/jobs' && init?.method === 'POST') {
      return Response.json({ id: 'job-1' });
    }
    if (url.pathname === '/api/jobs/job-1') {
      return Response.json({
        id: 'job-1',
        model: 'htdemucs_ft',
        status: 'done',
        expectedStems,
        stems: expectedStems.map((name) => ({ name, url: `${base}/stems/${name}.mp3` })),
      });
    }
    if (url.pathname.startsWith('/stems/')) {
      const bytes = Buffer.alloc(2048);
      bytes.set([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  const fixture = await listen((_request, response) => response.end());
  base = fixture.base;
  await fixture.close();

  await assert.rejects(
    () =>
      captureRailwayBaseline({
        base,
        classCode: 'never-print-this',
        sourceBytes: Buffer.from('authorized-audio'),
        filename: 'authorized.mp3',
        fetchImpl,
        pollMs: 1,
        timeoutMs: 1000,
      }),
    /no recognizable MPEG audio frame/
  );
});
