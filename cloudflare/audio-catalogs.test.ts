import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import { fetchOpenAudio, parseOpenAudioSelection, searchOpenAudio } from '../src/open-audio.ts';
import { submitSplit, resumeOwnedSourceImport } from '../src/reliability/splits.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';
import { courseFixture, membershipFixture } from './course-fixture.ts';

const uuid = '0046330f-daa1-4d39-8e0d-11172d151be8';
const audio = new Uint8Array(417 * 80); for (let i = 0; i < audio.length; i += 417) audio.set([255, 251, 144, 100], i);
const seconds = 80 * 1152 / 44100;
const license = 'https://creativecommons.org/licenses/by/4.0/';
const source = 'https://freesound.org/people/Artist/sounds/415186/';
const rendition = 'https://cdn.freesound.org/previews/415/415186_1658799-hq.mp3';
const selected = { freesound: { provider: 'freesound', itemId: uuid, fileId: '415186' }, loc: { provider: 'loc', itemId: '31920', fileId: '1' } } as const;
const freesound = () => ({ id: uuid, title: 'Fixture song', creator: 'Artist', foreign_landing_url: source,
  url: rendition, source: 'freesound', provider: 'freesound', filetype: 'mp3', filesize: audio.length, duration: seconds * 1000,
  license: 'by', license_version: '4.0', license_url: license });
const page = () => `<meta property="og:url" content="${source}"><meta property="og:audio:artist" content="Artist"><meta property="og:audio:title" content="Fixture song">
  <a title="Go to the full license text" href="${license}">Attribution 4.0</a><div id="share-link" data-static-file-url="${rendition}"></div>`;
const manifest = () => ({ cols: ['filename', 'item_id', 'md5', 'size', 'object_key'], rows: [
  ['jukebox-31920_1.mp3', 'http://www.loc.gov/item/jukebox-31920/', '30427eff83451a81d276935b19c7918f', audio.length, 'data.labs.loc.gov/jukebox/audio/jukebox-31920_1.mp3'],
] });
const loc = () => ({ item: { id: 'http://www.loc.gov/item/jukebox-31920/', title: 'Fixture song', date: '1919-04-18', profile: 'jukebox',
  access_restricted: false, location: ['united states'], item: { recording_repository: 'Recorded Sound Section, Library of Congress' },
  rights: ['All recordings published prior to 1923 will enter the public domain.'], contributor_names: ['Fixture performer'] },
  resources: [{ files: [[{ mediaType: 'A', canDownload: true, duration: seconds, rights_restricted: true }]] }] });

function setup(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-catalogs-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new SqliteD1(join(directory, 'db')); db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { db, maximumSeconds: 300, bucket: new FsR2Bucket(join(directory, 'audio')) };
}
function mock(t: any, change: (url: URL) => Response | undefined = () => undefined) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = new URL(String(input)); calls.push(url.href); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers); assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false);
    assert.match(headers.get('user-agent')!, /StemSplitter/);
    const changed = change(url); if (changed) return changed;
    if (url.hostname === 'api.openverse.org') return Response.json(url.pathname.includes(uuid) ? freesound() : { results: [freesound()] });
    if (url.hostname === 'freesound.org') return new Response(page(), { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname.endsWith('manifest.json')) return new Response(JSON.stringify(manifest()), { headers: { 'Content-Type': 'binary/octet-stream' } });
    if (url.hostname === 'www.loc.gov') return Response.json(url.pathname.startsWith('/item/') ? loc() : { results: [{ id: loc().item.id }] });
    return new Response(audio, { headers: { 'Content-Type': url.hostname === 'data.labs.loc.gov' ? 'binary/octet-stream' : 'audio/mpeg' } });
  });
  return calls;
}

test('additional source selections bind catalog IDs and file IDs without accepting URLs', () => {
  for (const selection of Object.values(selected)) assert.deepEqual(parseOpenAudioSelection(selection), selection);
  for (const value of [{ ...selected.freesound, itemId: '../123' }, { ...selected.freesound, fileId: '415187/1' },
    { ...selected.loc, fileId: '2' }, { ...selected.loc, url: rendition }, { ...selected.loc, itemId: uuid }]) assert.equal(parseOpenAudioSelection(value), null);
});

for (const provider of ['loc', 'freesound'] as const) {
  test(`${provider} search and owned import preserve exact bytes, rights and source identity before the paid queue`, async t => {
    const { db, bucket, maximumSeconds } = setup(t); const calls = mock(t);
    const result = await searchOpenAudio(provider, 'Fixture song', { db: db as any, maximumSeconds });
    assert.equal(result.results.length, 1); assert.deepEqual(result.results[0].openAudio, selected[provider]);
    assert.ok(!('downloadUrl' in result.results[0]));
    await db.prepare('DELETE FROM provider_cooldowns').run();
    const subject = 'cail-' + 'a'.repeat(32); await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
    const env = { DB: db, AUDIO: bucket, AUTH_MODE: 'cail', SEPARATION_BACKEND: 'replicate', ADMISSION_RESOLVER: {
      resolveMembership: async () => membershipFixture(), resolveCourseAccessV2: ({ subject, classId }: any) => courseFixture(subject, classId),
    } } as unknown as Env;
    const principal = { subject, role: 'member', quotaClass: 'member', courseId: null } as AppPrincipal;
    const reserved = await submitSplit(env, principal, { openAudio: selected[provider], model: 'htdemucs_ft' }, `catalog-import-${provider}-20261104`);
    await resumeOwnedSourceImport(env, principal, reserved.operation);
    const job = await db.prepare('SELECT * FROM jobs WHERE id=?').bind(reserved.operation.job_id).first<any>();
    assert.equal(job.source_type, provider); const stored = await bucket.get(job.source_key);
    assert.ok(stored, JSON.stringify(await db.prepare('SELECT error_code FROM app_operations WHERE id=?').bind(reserved.operation.id).first()));
    assert.deepEqual(new Uint8Array(await new Response(stored!.body).arrayBuffer()), audio);
    const attribution = JSON.parse((await db.prepare('SELECT attribution FROM job_attributions WHERE job_id=?').bind(job.id).first<any>())!.attribution);
    assert.equal(attribution.provider, provider); assert.equal(attribution.itemId, selected[provider].itemId);
    assert.match(attribution.attributionText, provider === 'loc' ? /Public domain \(United States\)/ : /CC BY 4.0/);
    if (provider === 'freesound') { assert.equal(attribution.fileDescription, 'MP3 preview'); assert.equal(attribution.rightsEvidence.sourceLicenseUrl, license); }
    else assert.equal(attribution.rightsEvidence.manifest, 'https://data.labs.loc.gov/jukebox/manifest.json');
    assert.equal((await db.prepare('SELECT phase FROM app_operations WHERE id=?').bind(reserved.operation.id).first<any>()).phase, 'split');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM operation_attempts').first<any>()).n, 0);
    assert.ok(calls.every(url => !url.includes('replicate')));
  });
}

test('Freesound rejects stale source licenses and substituted IDs or MP3s before downloading', async t => {
  const { db } = setup(t);
  for (const mode of ['license', 'identity', 'file', 'catalog-license', 'catalog-id']) {
    await db.prepare('DELETE FROM provider_cooldowns').run();
    const calls = mock(t, url => {
      if (url.hostname === 'freesound.org') return new Response(page().replace(
        mode === 'license' ? license : mode === 'identity' ? source : rendition,
        mode === 'license' ? 'https://creativecommons.org/licenses/by-nc/4.0/' : mode === 'identity' ? source.replace('415186', '415187') : mode === 'file' ? rendition.replace('415186', '415187') : rendition), { headers: { 'Content-Type': 'text/html' } });
      if (url.hostname === 'api.openverse.org' && mode.startsWith('catalog')) return Response.json({ ...freesound(),
        ...(mode === 'catalog-license' ? { license_url: 'https://creativecommons.org/licenses/by-nd/4.0/' } : { id: uuid.replace('0046330f', '00463300') }) });
    });
    await assert.rejects(fetchOpenAudio(selected.freesound, { db: db as any, maximumSeconds: 300 }), (e: any) => e.code === 'license_unverified');
    assert.ok(calls.every(url => !url.includes('cdn.freesound.org'))); t.mock.restoreAll();
  }
});

test('LoC imports require the exact published dataset file and a matching eligible recording', async t => {
  const { db } = setup(t);
  for (const mode of ['missing', 'host', 'date', 'item', 'download']) {
    await db.prepare('DELETE FROM provider_cooldowns').run();
    const calls = mock(t, url => {
      if (url.pathname.endsWith('manifest.json')) { const data = manifest();
        if (mode === 'missing') data.rows = []; if (mode === 'host') data.rows[0][4] = 'evil.test/music.mp3'; return Response.json(data); }
      if (url.hostname === 'www.loc.gov') { const data = loc();
        if (mode === 'date') data.item.date = '1923-01-01'; if (mode === 'item') data.item.id = data.item.id.replace('31920', '31921');
        if (mode === 'download') data.resources[0].files[0][0].canDownload = false; return Response.json(data); }
    });
    await assert.rejects(fetchOpenAudio(selected.loc, { db: db as any, maximumSeconds: 300 }), (e: any) => e.code === 'license_unverified');
    assert.ok(calls.every(url => !url.endsWith('.mp3'))); t.mock.restoreAll();
  }
});

test('Openverse quota responses stop new callers without disrupting independent sources', async t => {
  const { db } = setup(t); let calls = 0;
  mock(t, url => { if (url.hostname === 'api.openverse.org') { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }); } });
  for (const query of ['one song', 'another song']) await assert.rejects(searchOpenAudio('freesound', query, { db: db as any, maximumSeconds: 300 }), (e: any) => e.code === 'source_rate_limited');
  assert.equal(calls, 1);
  assert.equal((await searchOpenAudio('loc', 'song', { db: db as any, maximumSeconds: 300 })).results.length, 1);
});

test('shared Openverse pacing survives concurrent callers and cancelled waits never fetch', async t => {
  const { db } = setup(t), starts: number[] = [];
  mock(t, url => { if (url.hostname === 'api.openverse.org') starts.push(Date.now()); return undefined; });
  await Promise.all(['one song', 'two songs'].map(query => searchOpenAudio('freesound', query, { db: db as any, maximumSeconds: 300 })));
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 3000);
  const controller = new AbortController();
  const cancelled = searchOpenAudio('freesound', 'cancelled song', { db: db as any, maximumSeconds: 300, signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled); assert.equal(starts.length, 2);
});
