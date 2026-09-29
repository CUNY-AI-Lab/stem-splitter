import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioRetentionDays, getRetainedAudio } from '../src/r2.ts';
import type { Env } from '../src/env';

test('Cloudflare retains uploads and stems until 90 days; legacy policy remains 30', async () => {
  assert.equal(audioRetentionDays({ AUTH_MODE: 'cail' }), 90);
  assert.equal(audioRetentionDays({}), 30);
  const now = Date.now();
  for (const key of ['uploads/fixture/source.mp3', 'stems/fixture/vocals.mp3']) {
    for (const days of [30, 60, 89, 90, 91]) {
      const removed: string[] = [];
      const object = { uploaded: new Date(now - days * 86400000) };
      const env = { AUTH_MODE: 'cail', ROUTED_AUDIO: 'true', AUDIO: {
        get: async () => object, delete: async (key: string) => { removed.push(key); },
      } } as unknown as Env;
      const result = await getRetainedAudio(env, key, now);
      assert.equal(result, days < 90 ? object : null);
      assert.deepEqual(removed, days < 90 ? [] : [key]);
    }
  }
});
