// Explicit opt-in, free live source check. Never run by the normal test glob.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import { submitSplit, resumeOwnedSourceImport } from '../src/reliability/splits.ts';
import { courseFixture, membershipFixture } from './course-fixture.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';

if (process.env.STEM_LIVE_AUDIO !== '1') throw new Error('Set STEM_LIVE_AUDIO=1 for the bounded public source check.');
const directory = mkdtempSync(join(tmpdir(), 'stem-live-catalogs-'));
const originalFetch = globalThis.fetch, calls: { host: string; path: string; status: number }[] = [];
const receipt: any = { checkedAt: new Date().toISOString(), surface: 'Actual app search route and owned native import with local D1/R2; fixture identity only',
  paidProviderRequests: 0, splitQueueDrained: false, productionDeployed: false, results: [], calls };
globalThis.fetch = async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  assert.ok(['api.openverse.org', 'freesound.org', 'cdn.freesound.org', 'www.loc.gov', 'data.labs.loc.gov',
    'commons.wikimedia.org', 'upload.wikimedia.org', 'archive.org'].includes(url.hostname) || url.hostname.endsWith('.archive.org'), 'Unexpected outbound provider: ' + url.hostname);
  const response = await originalFetch(input, init); calls.push({ host: url.hostname, path: url.pathname, status: response.status }); return response;
};
try {
  const db = new SqliteD1(join(directory, 'db')); db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const bucket = new FsR2Bucket(join(directory, 'audio')), subject = 'cail-' + 'a'.repeat(32);
  await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const env = { DB: db, AUDIO: bucket, AUTH_MODE: 'cail', SEPARATION_BACKEND: 'replicate', ADMISSION_RESOLVER: {
    resolveMembership: async () => membershipFixture(), resolveCourseAccessV2: ({ subject, classId }: any) => courseFixture(subject, classId),
  } } as unknown as Env;
  const principal = { subject, role: 'member', quotaClass: 'member', courseId: null } as AppPrincipal;
  for (const [provider, query, fileId] of [['loc', 'jazz baby', '31920'], ['freesound', 'Sad heaven piano #3', '415186']]) {
    const response = await app.request('/api/music/search?q=' + encodeURIComponent(query), { headers: { 'x-class-code': 'fixture' } }, { DB: db, CLASS_CODE: 'fixture' } as any);
    const search: any = await response.json(); assert.equal(response.status, 200);
    const track = search.results.find((row: any) => row.openAudio?.provider === provider && (provider === 'loc' ? row.openAudio.itemId : row.openAudio.fileId) === fileId);
    assert.ok(track, JSON.stringify({ provider, providers: search.providers, results: search.results }));
    const reserved = await submitSplit(env, principal, { openAudio: track.openAudio, model: 'htdemucs_ft' }, `live-catalog-import-${provider}-20261104`);
    await resumeOwnedSourceImport(env, principal, reserved.operation);
    const operation = await db.prepare('SELECT phase,error_code FROM app_operations WHERE id=?').bind(reserved.operation.id).first<any>();
    assert.equal(operation.phase, 'split', JSON.stringify(operation));
    const job = await db.prepare('SELECT source_key,source_type FROM jobs WHERE id=?').bind(reserved.operation.job_id).first<any>();
    const stored = await bucket.get(job.source_key); assert.ok(stored);
    const bytes = Buffer.from(await new Response(stored.body).arrayBuffer()); assert.equal(bytes.length, track.bytes);
    const attribution = JSON.parse((await db.prepare('SELECT attribution FROM job_attributions WHERE job_id=?').bind(reserved.operation.job_id).first<any>()).attribution);
    assert.equal(attribution.provider, provider); assert.equal(job.source_type, provider);
    receipt.results.push({ provider, query, searchResultCount: search.results.length, track, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), attribution, phase: operation.phase });
    console.log(provider, track.title, bytes.length, 'bytes; verified source stored, ready for split');
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>()).n, 0);
  receipt.success = true;
} catch (error) { receipt.success = false; receipt.error = String(error); throw error; }
finally {
  globalThis.fetch = originalFetch;
  if (process.env.STEM_AUDIO_IMPORT_RECEIPT) writeFileSync(process.env.STEM_AUDIO_IMPORT_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  rmSync(directory, { recursive: true, force: true });
}
