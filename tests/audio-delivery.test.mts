import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsR2Bucket } from '../server/r2.ts';
import { serveStemAudio } from '../src/r2.ts';
import type { Env } from '../src/env.ts';

test('audio delivery streams exact ranges, downloads and HEAD without losing retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stem-range-'));
  try {
    const bucket = new FsR2Bucket(directory);
    const key = 'stems/test/vocals.mp3';
    await bucket.put(key, '0123456789', { httpMetadata: { contentType: 'audio/mpeg' } });
    const env = { AUDIO: bucket, AUTH_MODE: 'cail', ROUTED_AUDIO: 'true' } as unknown as Env;
    const get = (range?: string, extra = {}) => serveStemAudio(env, key, new Request('https://test/audio?download', {
      headers: { ...(range ? { Range: range } : {}), ...extra },
    }));
    for (const [range, expected, contentRange] of [
      ['bytes=0-0', '0', 'bytes 0-0/10'], ['bytes=3-5', '345', 'bytes 3-5/10'],
      ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=8-999', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10'],
    ]) {
      const response = await get(range);
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(response.headers.get('content-length'), String(expected.length));
      assert.equal(response.headers.get('content-type'), 'audio/mpeg');
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="vocals.mp3"');
      assert.equal(await response.text(), expected);
    }
    for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0']) {
      const response = await get(range);
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), 'bytes */10');
      assert.equal(await response.text(), '');
    }
    for (const range of [undefined, 'bytes=wat', 'bytes=0-1,4-5', 'items=0-1']) {
      const response = await get(range);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '0123456789');
    }
    const stale = await get('bytes=0-0', { 'If-Range': '"old"' });
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), '0123456789');
    const head = await serveStemAudio(env, key, new Request('https://test/audio', { method: 'HEAD', headers: { Range: 'bytes=0-0' } }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
    const originalHead = bucket.head.bind(bucket);
    bucket.head = async key => {
      const result = await originalHead(key);
      if (result) result.uploaded.setTime(Date.now() - 91 * 86400000);
      return result;
    };
    assert.equal((await get('bytes=0-0')).status, 404);
    assert.equal(await originalHead(key), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
