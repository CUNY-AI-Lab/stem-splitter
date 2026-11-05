import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteD1 } from '../server/d1.ts';
import { resolveReferenceAudio } from '../src/music-reference-audio.ts';

const id = '12345678-1234-1234-1234-123456789012';
const reference = { id, title: 'Fixture song', artist: 'Fixture artist', disambiguation: '', durationSec: 30,
  firstReleaseDate: '', sourceUrl: `https://musicbrainz.org/recording/${id}`, kind: 'metadata' as const, providerName: 'MusicBrainz' as const };
function setup(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-reference-audio-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new SqliteD1(join(directory, 'db')); db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { db: db as unknown as D1Database, maximumSeconds: 300 };
}
const metadata = () => ({ query: { pages: [{ ns: 6, pageid: 123, title: 'File:Fixture.mp3', imageinfo: [{
  mediatype: 'AUDIO', mime: 'audio/mpeg', size: 10000, duration: 30,
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Fixture.mp3', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Fixture.mp3',
  extmetadata: Object.fromEntries(Object.entries({ Artist: 'Fixture artist', Attribution: 'Fixture recording credit', ObjectName: 'Fixture song',
    LicenseUrl: 'https://creativecommons.org/licenses/by/4.0/', License: 'cc-by-4.0' }).map(([key, value]) => [key, { value }])),
}] }] } });
const recording = (urls: string[], recordingId = id) => ({ id: recordingId, title: 'Fixture song', 'artist-credit': [{ name: 'Fixture artist' }],
  relations: urls.map(resource => ({ 'target-type': 'url', type: 'free download', url: { resource } })) });

test('recording links resolve through Commons identity and license checks without exposing arbitrary download URLs', async t => {
  const context = setup(t), calls: string[] = [], results: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input)); calls.push(url.href);
    if (url.hostname === 'musicbrainz.org') return Response.json(recording([
      'https://archive.org.evil.test/details/file', 'https://ccmixter.org/files/example/1',
      'https://commons.wikimedia.org/wiki/File:Fixture.mp3',
    ]));
    assert.equal(url.origin, 'https://commons.wikimedia.org'); assert.equal(url.searchParams.get('titles'), 'File:Fixture.mp3');
    return Response.json(metadata());
  });
  await resolveReferenceAudio([reference], context, (provider, tracks) => results.push({ provider, tracks }));
  assert.equal(calls.length, 2); assert.equal(results.length, 1); assert.equal(results[0].provider, 'commons');
  assert.deepEqual(results[0].tracks[0].openAudio, { provider: 'commons', itemId: '123', fileId: 'original' });
  assert.equal(results[0].tracks[0].licenseName, 'CC BY 4.0');
  assert.ok(!results[0].tracks[0].downloadUrl); assert.ok(!results[0].tracks[0].musicbrainzId, 'source identity is not inferred from a catalog title');
});

test('catalog links cannot override recording rights, file identity or duration limits', async t => {
  const context = setup(t);
  for (const change of [
    (info: any) => { info.extmetadata.LicenseUrl.value = 'https://creativecommons.org/licenses/by-nd/4.0/'; },
    (info: any) => { info.descriptionurl = 'https://commons.wikimedia.org/wiki/File:Another.mp3'; },
    (info: any) => { info.duration = 301; },
  ]) {
    await context.db.prepare('DELETE FROM provider_cooldowns').run(); const results: any[] = []; const value = metadata(); change(value.query.pages[0].imageinfo[0]);
    t.mock.method(globalThis, 'fetch', async (input: any) => new URL(String(input)).hostname === 'musicbrainz.org'
      ? Response.json(recording(['https://commons.wikimedia.org/wiki/File:Fixture.mp3'])) : Response.json(value));
    await resolveReferenceAudio([reference], context, (_provider, tracks) => results.push(...tracks));
    assert.deepEqual(results, []);
  }
});

test('fallback bounds metadata lookups and stops before dispatch when cancelled', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    calls++; const url = new URL(String(input)); assert.equal(url.hostname, 'musicbrainz.org');
    return Response.json(recording(['https://example.org/recording'], url.pathname.split('/').at(-1)));
  });
  const references = [reference, ...[3, 4, 5].map(n => ({ ...reference, id: id.slice(0, -1) + n }))];
  await resolveReferenceAudio(references, context, () => assert.fail('No eligible repository link')); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await resolveReferenceAudio(references, { ...context, signal: controller.signal }, () => assert.fail('Cancelled')); assert.equal(calls, 2);
});

const audio = readFileSync(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
const archiveMetadata = (files: string[]) => ({ metadata: { title: 'Fixture album', creator: 'Fixture artist', mediatype: 'audio',
  subject: 'Music', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }, files: files.map(name => ({ name,
  title: 'Fixture song', artist: 'Fixture artist', format: 'VBR MP3', source: 'original', length: '30', size: String(audio.length) })) });

test('explicit nested Archive links preserve the exact file and never substitute another item track', async t => {
  const context = setup(t); const requested: string[] = []; let available = true;
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input));
    if (url.hostname === 'musicbrainz.org') return Response.json(recording(['https://archive.org/download/fixture/disc1/Fixture%20song.mp3']));
    if (url.pathname.startsWith('/metadata/')) return Response.json(archiveMetadata(available
      ? ['other.mp3', 'disc1/Fixture song.mp3'] : ['other.mp3']));
    requested.push(decodeURIComponent(url.pathname));
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) } });
  });
  const results: any[] = [];
  await resolveReferenceAudio([reference], context, (_provider, tracks) => results.push(...tracks));
  assert.equal(results.length, 1); assert.equal(results[0].archiveFile, 'disc1/Fixture song.mp3');
  assert.deepEqual(requested, ['/download/fixture/disc1/Fixture song.mp3']);
  available = false; results.length = 0; requested.length = 0;
  await context.db.prepare('DELETE FROM provider_cooldowns').run();
  await resolveReferenceAudio([reference], context, (_provider, tracks) => results.push(...tracks));
  assert.deepEqual(results, []); assert.deepEqual(requested, []);
});

for (const stage of ['metadata', 'audio']) for (const reason of ['cancel', 'deadline']) {
  test(`Archive ${stage} stops on ${reason} without dispatching a later file probe`, { timeout: 2000 }, async t => {
    const context = setup(t), controller = new AbortController(); const calls: string[] = [];
    const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
    if (reason === 'deadline') t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 18000 ? controller.signal : actualTimeout(ms));
    let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      if (url.hostname === 'musicbrainz.org') return Response.json(recording(['https://archive.org/details/fixture']));
      if (url.pathname.startsWith('/metadata/')) {
        if (stage === 'metadata') return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => { cancelled = true; reject(init!.signal!.reason); }, { once: true }); reached();
        });
        return Response.json(archiveMetadata(['first.mp3', 'second.mp3']));
      }
      return new Response(new ReadableStream({ pull() { reached(); }, cancel() { cancelled = true; } }),
        { headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) } });
    });
    const pending = resolveReferenceAudio([reference], { ...context, ...(reason === 'cancel' ? { signal: controller.signal } : {}) },
      () => assert.fail('Cancelled/deadline-expired search must not publish audio'));
    await started; controller.abort(new DOMException('Stopped', reason === 'deadline' ? 'TimeoutError' : 'AbortError'));
    await pending; assert.equal(cancelled, true);
    assert.deepEqual(calls, ['/ws/2/recording/' + id, '/metadata/fixture', ...(stage === 'audio' ? ['/download/fixture/first.mp3'] : [])]);
  });
}
