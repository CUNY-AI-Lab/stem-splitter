import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import app from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';

test('guest playback serves adaptive display stems and preserves ownership for every read method', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-guest-audio-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const audio = new FsR2Bucket(join(directory, 'audio'));
  const subject = 'guest-' + 'a'.repeat(64), other = 'guest-' + 'b'.repeat(64);
  const expiresAt = Date.now() + 60000, verifiedDay = new Date().toISOString().slice(0, 10);
  for (const guest of [subject, other]) await db.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
    .bind(guest, Date.now(), expiresAt, verifiedDay).run();
  await db.prepare("INSERT INTO jobs(id,filename,source_key,status) VALUES('adaptive-song','Guest song','uploads/source.mp3','done')").run();
  await db.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind('adaptive-song', subject).run();
  const bytes = readFileSync(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
  const env = { DB: db, AUDIO: audio, AUTH_MODE: 'cail', ROUTED_AUDIO: 'true', PUBLIC_BASE_URL: 'https://split.test',
    guestRuntimeReady: true, guestSession: { subject, expiresAt, verifiedDay } } as unknown as Env;
  const call = (path: string, method = 'GET', guest = subject, range?: string) => app.fetch(new Request('https://split.test' + path,
    { method, headers: { ...(range ? { Range: range } : {}) } }), { ...env, guestSession: { subject: guest, expiresAt, verifiedDay } });

  for (const suffix of ['vocals.mp3', 'attempt/vocals.mp3', 'attempt/display/vocals.mp3', 'attempt/display/drums.mp3', 'attempt/display/guitar.mp3', 'attempt/display/other.mp3']) {
    const key = 'stems/adaptive-song/' + suffix, path = '/api/files/' + key;
    await audio.put(key, bytes, { httpMetadata: { contentType: 'audio/mpeg' } });
    const full = await call(path);
    assert.equal(full.status, 200, path);
    assert.equal(full.headers.get('Content-Type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const head = await call(path, 'HEAD');
    assert.equal(head.status, 200, path);
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const partial = await call(path, 'GET', subject, 'bytes=0-31');
    assert.equal(partial.status, 206, path);
    assert.equal(partial.headers.get('Content-Range'), `bytes 0-31/${bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 32));
    for (const method of ['GET', 'HEAD']) assert.equal((await call(path, method, other)).status, 404, 'other guest: ' + path);
    assert.equal((await call(path, 'POST')).status, 403);
  }
  for (const path of ['/api/files/uploads/source.mp3', '/api/files/stems/adaptive-song/attempt/internal/vocals.mp3',
    '/api/files/stems/adaptive-song/attempt/display/extra/vocals.mp3', '/api/files/stems/adaptive-song/attempt%2Fdisplay/vocals.mp3']) {
    assert.ok([400, 403].includes((await call(path)).status), path);
  }
  await db.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(), subject).run();
  assert.equal((await call('/api/files/stems/adaptive-song/attempt/display/vocals.mp3')).status, 401);
});
