import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeBrowserLoader } from './youtube-browser.ts';
import { AcquisitionError } from './youtube-acquisition.mjs';

const binding = { fetch: async () => new Response() };
const url = 'https://youtu.be/jNQXAC9IVRw?t=1';
const result = () => ({ audio: { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm' as const, durationMs: 19021 },
  receipt: { browserClosed: true, title: 'Me at the zoo' } });

test('browser import requires the trusted Cloudflare binding', () => {
  for (const value of [undefined, null, {}, { quickAction() {} }, { fetch: 'fetch' }]) assert.equal(youtubeBrowserLoader(value), undefined);
});
test('loader canonicalizes video identity, preserves deadline and supplies WebM metadata', async () => {
  const fixture = result();
  fixture.audio.data = new Uint8Array([9, 1, 2, 3, 8]).subarray(1, 4);
  const loader = youtubeBrowserLoader(binding, async (env, options) => {
    assert.equal(env.BROWSER, binding); assert.deepEqual(options, { videoId: 'jNQXAC9IVRw', deadline: 123456 }); return fixture;
  })!;
  const audio = await loader(url, { deadline: 123456 });
  assert.deepEqual([...new Uint8Array(audio.data)], [1, 2, 3]);
  assert.equal(audio.fileName, 'source.webm'); assert.equal(audio.contentType, 'audio/webm');
  assert.equal(audio.title, 'Me at the zoo'); assert.equal(audio.durationSec, 19.021);
  fixture.audio.data.fill(0); assert.deepEqual([...new Uint8Array(audio.data)], [1, 2, 3]);
});
test('invalid source is rejected before browser acquisition', async () => {
  let calls = 0; const loader = youtubeBrowserLoader(binding, async () => { calls++; return result(); })!;
  for (const source of ['https://vimeo.com/12345', 'https://youtube.com.evil.example/watch?v=jNQXAC9IVRw', 'file:///tmp/audio']) {
    await assert.rejects(loader(source, { deadline: Date.now() + 1000 }), { code: 'invalid_youtube_url' });
  }
  assert.equal(calls, 0);
});
test('unclosed browser, incomplete metadata and oversized audio are rejected', async () => {
  for (const change of [
    (r: ReturnType<typeof result>) => { r.receipt.browserClosed = false; },
    (r: ReturnType<typeof result>) => { r.audio.durationMs = NaN; },
    (r: ReturnType<typeof result>) => { r.audio.durationMs = 900001; },
    (r: ReturnType<typeof result>) => { r.audio.data = new Uint8Array(); },
    (r: ReturnType<typeof result>) => { r.audio.data = new Uint8Array(12 * 1024 * 1024 + 1); },
  ]) {
    const fixture = result(); change(fixture);
    await assert.rejects(youtubeBrowserLoader(binding, async () => fixture)!(url, { deadline: 123 }), { code: 'invalid_audio_response' });
  }
});
test('source refusal is terminal and private error details remain internal', async () => {
  for (const [source, expected] of [['source_access_refused', 'youtube_source_restricted'], ['source_restricted', 'youtube_source_restricted'],
    ['source_security_refusal', 'youtube_source_restricted'], ['source_timeout', 'youtube_fetch_timeout'], ['audio_too_large', 'audio_too_large'],
    ['private-detail', 'youtube_fetch_unavailable']]) {
    let calls = 0;
    const loader = youtubeBrowserLoader(binding, async () => { calls++; throw new AcquisitionError(source); })!;
    await assert.rejects(loader(url, { deadline: 123 }), { code: expected, message: 'Video audio is unavailable.', retryable: false });
    assert.equal(calls, 1);
  }
});
test('title remains bounded and safe for the existing job label', async () => {
  const fixture = result(); fixture.receipt.title = '\x00\n /\\ ' + 'a'.repeat(400);
  const audio = await youtubeBrowserLoader(binding, async () => fixture)!(url, { deadline: 123 });
  assert.equal(audio.title, 'a'.repeat(200));
});
