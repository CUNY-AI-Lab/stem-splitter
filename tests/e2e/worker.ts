import app from '../../src/index';
import { cleanupExpiredLocalAudio } from '../../src/r2';
import type { Env } from '../../src/env';
import { createInstrumentIsolation } from '../../src/isolation/resource.ts';

const E2E_SECRET = 'local-hosting-e2e-only';

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/__e2e/')) {
      return app.fetch(request, env, executionCtx);
    }
    if (request.headers.get('x-e2e-secret') !== E2E_SECRET) {
      return new Response('Not found', { status: 404 });
    }

    if (request.method === 'POST' && url.pathname === '/__e2e/schema') {
      const statements = (await request.json()) as string[];
      await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/__e2e/job-analysis') {
      const body = (await request.json()) as { id?: unknown; analysis?: unknown };
      if (typeof body.id !== 'string' || !body.id || !body.analysis) {
        return new Response(null, { status: 400 });
      }
      await env.DB.prepare(
        `INSERT INTO jobs
          (id, filename, source_key, status, model, routing_request, source_type, analysis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.id,
          'discovery-e2e.wav',
          'uploads/e2e/discovery.wav',
          'done',
          'htdemucs_6s',
          'auto',
          'upload',
          JSON.stringify(body.analysis)
        )
        .run();
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/__e2e/job-isolation') {
      const body = (await request.json()) as { jobId?: unknown };
      if (typeof body.jobId !== 'string' || !body.jobId) {
        return new Response(null, { status: 400 });
      }
      const result = await createInstrumentIsolation(env, {
        id: 'isolation_e2e_1',
        jobId: body.jobId,
        requestedBy: 'e2eteacher',
        sourceHash: '1'.repeat(64),
        sourceType: 'upload',
        normalizedTarget: 'saxophone',
        analysisVocabularyVersion: 'classroom-instruments-v1',
        identity: {
          provider: 'replicate',
          model: 'cjwbw/audiosep',
          version: 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8',
          contractVersion: 'audiosep-replicate-v1',
        },
      });
      return Response.json({ id: result.record.id, created: result.created });
    }

    if (request.method === 'POST' && url.pathname === '/__e2e/local-upload') {
      const key = url.searchParams.get('key');
      const declaredLength = url.searchParams.get('declaredLength');
      if (!key || !declaredLength) return new Response(null, { status: 400 });

      const encodedKey = key.split('/').map(encodeURIComponent).join('/');
      const body =
        url.searchParams.get('unreadBody') === 'true'
          ? new ReadableStream({
              pull() {
                throw new Error('Oversized upload body was read');
              },
            })
          : await request.arrayBuffer();
      if (!body) return new Response(null, { status: 400 });

      return app.fetch(
        new Request(new URL(`/api/local-uploads/${encodedKey}`, request.url), {
          method: 'PUT',
          headers: {
            'Content-Length': declaredLength,
            'Content-Type': request.headers.get('content-type') ?? 'application/octet-stream',
            'x-class-code': env.CLASS_CODE,
          },
          body,
        }),
        env,
        executionCtx
      );
    }

    if (request.method === 'GET' && url.pathname === '/__e2e/audio') {
      const key = url.searchParams.get('key');
      if (key) {
        const object = await env.AUDIO.get(key);
        if (!object) return new Response(null, { status: 404 });
        return new Response(object.body, {
          headers: {
            'Content-Length': String(object.size),
            'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
          },
        });
      }
      const { objects } = await env.AUDIO.list();
      return Response.json({ keys: objects.map((object) => object.key).sort() });
    }

    if (request.method === 'HEAD' && url.pathname === '/__e2e/audio') {
      const key = url.searchParams.get('key');
      if (!key) return new Response(null, { status: 400 });
      return new Response(null, { status: (await env.AUDIO.head(key)) ? 204 : 404 });
    }

    if (request.method === 'PUT' && url.pathname === '/__e2e/audio') {
      const key = url.searchParams.get('key');
      if (!key || !request.body) return new Response(null, { status: 400 });
      await env.AUDIO.put(key, await request.arrayBuffer(), {
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
      });
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname === '/__e2e/cleanup') {
      const nowMs = Number(url.searchParams.get('now'));
      if (!Number.isSafeInteger(nowMs)) return new Response(null, { status: 400 });
      const removed = await cleanupExpiredLocalAudio(env, nowMs);
      return Response.json({ removed });
    }

    if (request.method === 'POST' && url.pathname === '/__e2e/stale-ingestion') {
      const jobId = url.searchParams.get('job');
      if (!jobId) return new Response(null, { status: 400 });
      const staleLease = `ingesting:${Date.now() - 10 * 60 * 1000}:e2e-stale`;
      const result = await env.DB.prepare(
        "UPDATE jobs SET status = 'ingesting', error = ? WHERE id = ?"
      )
        .bind(staleLease, jobId)
        .run();
      return Response.json({ changed: result.meta.changes });
    }

    return new Response('Not found', { status: 404 });
  },
};
