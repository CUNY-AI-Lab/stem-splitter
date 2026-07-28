import app from '../../src/index';
import { cleanupExpiredLocalAudio } from '../../src/r2';
import type { Env } from '../../src/env';

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
