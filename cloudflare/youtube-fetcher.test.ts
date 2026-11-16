import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchViaYouTubeFetcher, youtubeFetcherConfigured } from '../src/youtube-fetcher.ts';
import type { Env } from '../src/env.ts';

const secret = 'f'.repeat(40);
const env = { YOUTUBE_FETCHER_URL: 'https://fetcher.example', YOUTUBE_FETCHER_SECRET: secret } as Env;
const options = { deadline: Date.now() + 120000, maximumDurationSeconds: 900 as const };
const audio = (headers: Record<string, string> = {}) => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
  headers: { 'Content-Type': 'audio/mp4', 'X-Audio-Duration': '258', 'X-Audio-Title': encodeURIComponent('Rydeen / “Live”'), ...headers },
});
async function withFetch<T>(handler: (request: Request) => Response | Promise<Response>, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('the fetcher needs an HTTPS address and a long secret', () => {
  assert.equal(youtubeFetcherConfigured(env), true);
  for (const partial of [{}, { YOUTUBE_FETCHER_URL: env.YOUTUBE_FETCHER_URL }, { ...env, YOUTUBE_FETCHER_SECRET: 'short' },
    { ...env, YOUTUBE_FETCHER_URL: 'http://fetcher.example' }, { ...env, YOUTUBE_FETCHER_URL: 'not a url' }]) {
    assert.equal(youtubeFetcherConfigured(partial as Env), false);
  }
});

test('a fetch sends only the video ID and limit, with the secret, and returns the audio', async () => {
  const seen: Request[] = [];
  const result = await withFetch(request => { seen.push(request); return audio(); },
    () => fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg?t=30', env, { ...options, maximumDurationSeconds: 300 }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://fetcher.example/audio');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.get('authorization'), `Bearer ${secret}`);
  assert.deepEqual(await seen[0].json(), { videoId: 'Yxep-gS-Btg', maxSeconds: 300 });
  assert.equal(result.contentType, 'audio/mp4');
  assert.equal(result.fileName, 'source.m4a');
  assert.equal(result.durationSec, 258);
  assert.equal(result.title, 'Rydeen “Live”');
  assert.equal(result.data.byteLength, 8);
});

test('with a fetcher service binding, the fetch goes through it and never over the network', async () => {
  const seen: Request[] = [];
  const service = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Request(input, init)); return audio(); } } as unknown as Fetcher;
  let networkCalls = 0;
  const result = await withFetch(() => { networkCalls++; return audio(); },
    () => fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', { ...env, YOUTUBE_FETCHER_SERVICE: service } as Env, options));
  assert.equal(networkCalls, 0);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, '/audio');
  assert.equal(seen[0].headers.get('authorization'), `Bearer ${secret}`);
  assert.deepEqual(await seen[0].json(), { videoId: 'Yxep-gS-Btg', maxSeconds: 900 });
  assert.equal(result.durationSec, 258);
});

test('links that are not YouTube never reach the fetcher', async () => {
  let calls = 0;
  await withFetch(() => { calls++; return audio(); }, async () => {
    for (const url of ['https://vimeo.com/12345', 'https://youtube.com.evil.example/watch?v=Yxep-gS-Btg', 'file:///tmp/a']) {
      await assert.rejects(fetchViaYouTubeFetcher(url, env, options), { code: 'invalid_youtube_url' });
    }
  });
  assert.equal(calls, 0);
});

test('final refusals are not retried; other failures are', async () => {
  for (const [code, status, expected] of [['source_too_long', 422, 'source_too_long'], ['live_stream', 422, 'live_stream'],
    ['source_denied_private', 422, 'youtube_source_restricted'], ['audio_too_large', 413, 'audio_too_large']] as const) {
    await withFetch(() => Response.json({ code }, { status }), () =>
      assert.rejects(fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', env, options), { code: expected, retryable: false }));
  }
  for (const response of [() => Response.json({ code: 'source_denied_bot_verification' }, { status: 503 }),
    () => Response.json({ code: 'extractor_failed' }, { status: 502 }), () => new Response('<html>', { status: 530 })]) {
    await withFetch(response, () =>
      assert.rejects(fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', env, options), { code: 'youtube_fetch_unavailable', retryable: true }));
  }
  await withFetch(() => { throw new TypeError('network'); }, () =>
    assert.rejects(fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', env, options), { code: 'youtube_fetch_unavailable', retryable: true }));
});

test('the answer must be audio within the limits', async () => {
  for (const response of [() => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    () => audio({ 'X-Audio-Duration': 'NaN' }), () => audio({ 'X-Audio-Duration': '901' }),
    () => new Response(new Uint8Array(), { headers: { 'Content-Type': 'audio/mp4', 'X-Audio-Duration': '10' } })]) {
    await withFetch(response, () =>
      assert.rejects(fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', env, options), { code: 'invalid_audio_response' }));
  }
  await withFetch(() => new Response(new Uint8Array(12 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'audio/mp4', 'X-Audio-Duration': '10' } }), () =>
    assert.rejects(fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', env, options), { code: 'audio_too_large' }));
});

test('a nearly spent deadline does not start a fetch', async () => {
  let calls = 0;
  await withFetch(() => { calls++; return audio(); }, () =>
    assert.rejects(fetchViaYouTubeFetcher('https://youtu.be/Yxep-gS-Btg', env, { ...options, deadline: Date.now() + 1000 }), { code: 'youtube_fetch_timeout' }));
  assert.equal(calls, 0);
});
