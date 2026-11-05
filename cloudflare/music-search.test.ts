import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteD1 } from '../server/d1.ts';
import { searchRecordingReferences, getRecordingReference } from '../src/musicbrainz.ts';
import { musicSearchResponse } from '../src/music-search.ts';
import app from '../src/index.ts';

const studio = '12345678-1234-1234-1234-123456789012';
const live = '12345678-1234-1234-1234-123456789013';
const recording = (id = studio, disambiguation = 'studio version') => ({ id, title: 'Example song', disambiguation,
  'artist-credit': [{ name: 'Example artist' }], length: 120000, 'first-release-date': '2000-01-01' });
const audio = new Uint8Array(417 * 80); for (let i = 0; i < audio.length; i += 417) audio.set([255, 251, 144, 100], i);
const commons = () => ({ query: { pages: [{ ns: 6, pageid: 123, title: 'File:Example.mp3', imageinfo: [{
  mediatype: 'AUDIO', mime: 'audio/mpeg', size: audio.length, duration: 80 * 1152 / 44100,
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.mp3', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example.mp3',
  extmetadata: Object.fromEntries(Object.entries({ LicenseUrl: 'https://creativecommons.org/licenses/by/4.0/', License: 'cc-by-4.0',
    Artist: 'Example artist', Attribution: 'Example performer', ObjectName: 'Example song' }).map(([key, value]) => [key, { value }])),
}] }] } });
function setup(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-music-search-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new SqliteD1(join(directory, 'db')); db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { db: db as unknown as D1Database, maximumSeconds: 300 };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('MusicBrainz returns distinct recording IDs as metadata and quotes search text without credentials', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin, 'https://musicbrainz.org');
    assert.equal(url.searchParams.get('query'), '"Artist" AND "OR" AND "title"');
    assert.match(new Headers(init.headers).get('User-Agent')!, /StemSplitter.*github.com\/CUNY-AI-Lab\/stem-splitter/);
    assert.equal(new Headers(init.headers).has('Authorization'), false); assert.equal(new Headers(init.headers).has('Cookie'), false);
    assert.equal(init.redirect, 'manual');
    return Response.json({ recordings: [{ ...recording(), 'artist-credit': [{ name: 'Artist A', joinphrase: ' & ' }, { name: 'Artist B' }] }, recording(live, 'live, 2004'), recording(studio), { id: 'bad', title: 'Bad' }] });
  });
  const results = await searchRecordingReferences('Artist OR title:*', context);
  assert.equal(calls, 1); assert.deepEqual(results.map(row => row.id), [studio, live]);
  assert.equal(results[0].artist, 'Artist A & Artist B');
  assert.equal(results[1].disambiguation, 'live, 2004');
  for (const result of results) { assert.equal(result.kind, 'metadata'); assert.ok(!('openAudio' in result)); assert.ok(!('downloadUrl' in result)); }
});

test('recording relations are informational HTTPS pages and mismatched IDs cannot identify another recording', async t => {
  const context = setup(t);
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    assert.equal(new URL(String(input)).searchParams.get('inc'), 'artist-credits url-rels');
    return Response.json({ ...recording(), relations: [
      { 'target-type': 'url', type: 'free download', url: { resource: 'https://archive.org/details/example' } },
      { 'target-type': 'url', type: 'streaming', url: { resource: 'javascript:alert(1)' } },
      { 'target-type': 'url', type: 'other database', url: { resource: 'https://user:password@example.org/' } },
    ] });
  });
  const result = await getRecordingReference(studio, context);
  assert.deepEqual(result.relations, [{ label: 'free download · archive.org', url: 'https://archive.org/details/example' }]);
  assert.equal(result.kind, 'metadata'); assert.ok(!('licenseUrl' in result));
  await assert.rejects(getRecordingReference('../unsafe', context), (e: any) => e.code === 'invalid_reference');
  await context.db.prepare('DELETE FROM provider_cooldowns').run();
  await assert.rejects(getRecordingReference(live, context), (e: any) => e.code === 'metadata_unavailable');
});

test('public metadata cache avoids upstream requests and the shared D1 gate spaces independent callers', async t => {
  const context = setup(t), entries = new Map<string, Response>(), starts: number[] = [];
  const cache = { origin: 'https://stem.test', storage: {
    match: async (key: Request) => entries.get(key.url)?.clone(), put: async (key: Request, value: Response) => { entries.set(key.url, value.clone()); },
  } } as any;
  t.mock.method(globalThis, 'fetch', async () => { starts.push(Date.now()); return Response.json({ recordings: [recording()] }); });
  await searchRecordingReferences('cache melody', { ...context, cache });
  await searchRecordingReferences('CACHE MELODY', { ...context, cache }); assert.equal(starts.length, 1);
  await Promise.all([searchRecordingReferences('second melody', context), searchRecordingReferences('third melody', { ...context })]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 1000); assert.ok(starts[2] - starts[1] >= 1000);
});

test('provider cooldown survives callers, cancelled waits do not fetch, and oversized metadata fails closed', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 503, headers: { 'Retry-After': '120' } }); });
  await assert.rejects(searchRecordingReferences('busy melody', context));
  await assert.rejects(searchRecordingReferences('another melody', { ...context })); assert.equal(calls, 1);
  await context.db.prepare('DELETE FROM provider_cooldowns').run();
  await context.db.prepare('INSERT INTO provider_cooldowns(provider, until_ms) VALUES(?,?)').bind('musicbrainz', Date.now() + 1100).run();
  const controller = new AbortController();
  const pending = searchRecordingReferences('cancelled melody', { ...context, signal: controller.signal }); controller.abort();
  await assert.rejects(pending); assert.equal(calls, 1);
  await context.db.prepare('DELETE FROM provider_cooldowns').run();
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(searchRecordingReferences('oversized melody', context), (e: any) => e.code === 'metadata_unavailable');
});

test('delayed D1 reservations cannot dispatch MusicBrainz requests inside the shared spacing window', async t => {
  const context = setup(t), starts: number[] = [], reserved = deferred(); let delayed = false;
  const db = { prepare(sql: string) {
    const statement = context.db.prepare(sql);
    return { bind(...values: any[]) {
      const bound = statement.bind(...values);
      if (!sql.startsWith('INSERT')) return bound;
      return { first: async () => {
        const value = await bound.first();
        if (value && !delayed) { delayed = true; reserved.resolve(); await new Promise(resolve => setTimeout(resolve, 1250)); }
        return value;
      } };
    } };
  } } as unknown as D1Database;
  t.mock.method(globalThis, 'fetch', async () => { starts.push(Date.now()); return Response.json({ recordings: [recording()] }); });
  const first = searchRecordingReferences('delayed reservation', { ...context, db });
  await reserved.promise; await new Promise(resolve => setTimeout(resolve, 1120));
  const second = searchRecordingReferences('later reservation', { ...context, db });
  await Promise.all([first, second]);
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 1000, String(starts));
});

test('audio search never calls MusicBrainz and returns usable audio without metadata', async t => {
  const context = setup(t); let metadataCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname === 'musicbrainz.org') metadataCalls++;
    if (url.hostname === 'commons.wikimedia.org') return Response.json(commons());
    if (url.hostname === 'api.openverse.org') return Response.json({ results: [] });
    return Response.json({ response: { docs: [] } });
  });
  const response = await app.request('/api/music/search?q=route%20audio%20melody', { headers: { 'x-class-code': 'fixture' } }, { DB: context.db, CLASS_CODE: 'fixture' } as any);
  const result: any = await response.json(); assert.equal(response.status, 200);
  assert.equal(result.results.length, 1); assert.deepEqual(result.references, []); assert.equal(metadataCalls, 0);
  assert.ok(!('musicbrainz' in result.providers));
  assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM jobs').first<any>()).count, 0);
});

test('metadata retries remain bounded, refuse redirects and permission failures, and stop on cancellation', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 503, headers: { 'Retry-After': '0' } }); });
  await assert.rejects(searchRecordingReferences('persistent outage', context)); assert.equal(calls, 2);
  for (const status of [403, 302]) {
    await context.db.prepare('DELETE FROM provider_cooldowns').run(); calls = 0;
    t.mock.method(globalThis, 'fetch', async (_input: any, init: any) => {
      calls++; assert.equal(init.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://unexpected.example/' } });
    });
    await assert.rejects(searchRecordingReferences('refused response ' + status, context)); assert.equal(calls, 1);
  }
  await context.db.prepare('DELETE FROM provider_cooldowns').run(); calls = 0;
  const first = deferred(), controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { calls++; first.resolve(); return new Response(null, { status: 429, headers: { 'Retry-After': '0' } }); });
  const pending = searchRecordingReferences('cancelled retry', { ...context, signal: controller.signal });
  await first.promise; controller.abort(); await assert.rejects(pending); assert.equal(calls, 1);
});

test('unified search streams audio before a slow additional catalog and retains existing sources', async t => {
  const context = setup(t), metadata = deferred(); let metadataStarted = false;
  t.after(metadata.resolve);
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.openverse.org') { metadataStarted = true; await metadata.promise; return Response.json({ results: [] }); }
    if (url.hostname === 'data.labs.loc.gov' || url.hostname === 'www.loc.gov') return new Response(null, { status: 503, headers: { 'Retry-After': '120' } });
    if (url.hostname === 'commons.wikimedia.org') return Response.json(commons());
    if (url.pathname === '/advancedsearch.php') return Response.json({ response: { docs: [{ identifier: 'unified-melody', title: 'Unified melody' }] } });
    if (url.pathname.startsWith('/metadata/')) return Response.json({ metadata: { title: 'Unified melody', creator: 'Example artist', mediatype: 'audio', subject: 'Music' }, files: [{ name: 'song.mp3', title: 'Unified melody', length: String(80 * 1152 / 44100), size: String(audio.length) }] });
    return new Response(audio, { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes 0-${audio.length - 1}/${audio.length}` } });
  });
  const response = await musicSearchResponse('Unified melody', true, context), reader = response.body!.getReader();
  let beforeMetadata: any;
  for (let i = 0; i < 10; i++) { const chunk = await reader.read(); const value = JSON.parse(new TextDecoder().decode(chunk.value)); if (value.results?.length === 2) { beforeMetadata = value; break; } }
  assert.ok(metadataStarted); assert.equal(beforeMetadata.done, false); assert.deepEqual(beforeMetadata.references, []);
  assert.deepEqual(new Set(beforeMetadata.results.map((row: any) => row.providerName)), new Set(['Internet Archive', 'Wikimedia Commons']));
  metadata.resolve(); let final: any;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; const value = JSON.parse(new TextDecoder().decode(chunk.value)); if (value.done) final = value; }
  assert.equal(final.results.length, 2); assert.equal(final.references.length, 0); assert.deepEqual(final.providers, { archive: 'ready', commons: 'ready', freesound: 'ready', loc: 'unavailable' });
});

test('partial provider failures preserve eligible files and ccMixter remains disabled', async t => {
  const context = setup(t);
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname === 'commons.wikimedia.org') return Response.json(commons());
    if (url.hostname === 'musicbrainz.org') return new Response(null, { status: 503 });
    return new Response(null, { status: 403 });
  });
  const response = await musicSearchResponse('partial music', false, context); const result: any = await response.json();
  assert.equal(response.status, 200); assert.equal(result.results.length, 1); assert.equal(result.results[0].openAudio.provider, 'commons');
  assert.equal(result.providers.freesound, 'unavailable'); assert.equal(result.providers.loc, 'unavailable'); assert.equal(result.providers.archive, 'unavailable'); assert.deepEqual(result.references, []);
  const disabled = await app.request('/api/music/search?q=music&provider=ccmixter', { headers: { 'x-class-code': 'fixture' } }, { DB: context.db, CLASS_CODE: 'fixture' } as any);
  assert.equal(disabled.status, 503);
  assert.equal((await app.request(`/api/music/recordings/${studio}`, {}, { DB: context.db, CLASS_CODE: 'fixture' } as any)).status, 401);
});

test('rolling Archive rankings reserve space for every late audio catalog', async t => {
  const context = setup(t), probes = new Set<string>();
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input));
    if (['api.openverse.org','data.labs.loc.gov','www.loc.gov'].includes(url.hostname)) return new Response(null, { status: 403 });
    if (url.hostname === 'commons.wikimedia.org') { await new Promise(resolve => setTimeout(resolve, 150)); return Response.json(commons()); }
    if (url.pathname === '/advancedsearch.php') return Response.json({ response: { docs: Array.from({ length: 16 }, (_, i) => ({ identifier: `capacity-melody-${i}`, title: 'Capacity melody', creator: 'Example artist' })) } });
    if (url.pathname.startsWith('/metadata/')) {
      const i = Number(url.pathname.split('-').at(-1));
      if (i >= 8) await new Promise(resolve => setTimeout(resolve, 40));
      return Response.json({ metadata: { title: 'Capacity melody', creator: 'Example artist', mediatype: 'audio', subject: 'Music' }, files: [{ name: 'song.mp3', title: i < 8 ? 'Capacity melody live' : 'Capacity melody', length: String(80 * 1152 / 44100), size: String(audio.length) }] });
    }
    probes.add(url.pathname);
    return new Response(audio, { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes 0-${audio.length - 1}/${audio.length}` } });
  });
  const result: any = await (await musicSearchResponse('Capacity melody', false, context)).json();
  assert.ok(probes.size > 8, 'fixture must produce replacement Archive rankings');
  assert.equal(result.results.filter((track: any) => track.providerName === 'Internet Archive').length, 4);
  assert.equal(result.results.filter((track: any) => track.providerName === 'Wikimedia Commons').length, 1);
  assert.equal(result.results.length, 5);
});

test('cancelled streams stop independent metadata calls and a new search can finish', async t => {
  const context = setup(t), started = deferred(); let aborted = 0;
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    if (new URL(String(input)).pathname === '/advancedsearch.php') return Response.json({ response: { docs: [] } });
    return new Promise<Response>((_, reject) => {
      const stop = () => { aborted++; reject(new Error('cancelled')); };
      init.signal.addEventListener('abort', stop, { once: true });
      if (init.signal.aborted) stop(); started.resolve();
    });
  });
  const response = await musicSearchResponse('cancel sources', true, context); await started.promise;
  await response.body!.cancel(); await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(aborted > 0);
  await context.db.prepare('DELETE FROM provider_cooldowns').run();
  t.mock.method(globalThis, 'fetch', async (input: any) => new URL(String(input)).hostname === 'musicbrainz.org'
    ? Response.json({ recordings: [recording()] }) : Response.json({ response: { docs: [] }, query: { pages: [] } }));
  const retried: any = await (await musicSearchResponse('retry sources', false, context)).json(); assert.deepEqual(retried.references, []); assert.equal(retried.providers.commons, 'ready');
});
