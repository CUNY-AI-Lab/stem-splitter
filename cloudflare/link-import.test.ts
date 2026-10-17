import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import type { Env } from '../src/env.ts';
import type { AppPrincipal } from '../src/identity.ts';
import app from '../src/index.ts';
import { drainSplitQueue, submitSplit } from '../src/reliability/splits.ts';
import { readOperation } from '../src/reliability/ledger.ts';
import { courseFixture } from './course-fixture.ts';
import { flacDuration, handleLinkImportRequest, importLink, inspectAudio, resolveLink, shareDownloadUrl, wavDuration, youtubeSearchQuery } from '../src/link-import.ts';

const keyPrefix = 'uploads/00000000-0000-4000-8000-000000000000/source-1';
const source = 'https://media.example.org/music/Night%20Song.mp3';

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz frames: 417 bytes and 1152 samples each. */
function mp3(seconds: number) {
  const frames = Math.ceil(seconds * 44100 / 1152), bytes = new Uint8Array(frames * 417);
  for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([255, 251, 144, 100], offset);
  return bytes;
}
function wav(seconds: number, rate = 8000) {
  const dataSize = seconds * rate * 2, bytes = new Uint8Array(44 + dataSize), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, dataSize, true);
  return bytes;
}
function flac(seconds: number, sync = true) {
  const rate = 44100, total = seconds * rate, bytes = new Uint8Array(2048);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  bytes.set([rate >> 12, (rate >> 4) & 0xff, ((rate & 0xf) << 4) | (1 << 1), 0xf0 | Math.floor(total / 2 ** 32), (total >>> 24) & 0xff, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff], 18);
  if (sync) bytes.set([0xff, 0xf8], 42);
  return bytes;
}

function bucket(t: { after: (f: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-link-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new FsR2Bucket(join(directory, 'audio')) as unknown as R2Bucket;
}
const request = (url = source, maximumSeconds: 300 | 900 = 900) => ({ url, keyPrefix, maximumSeconds, deadline: Date.now() + 30_000 });

test('share links rewrite to direct downloads and reject folders', () => {
  assert.deepEqual(shareDownloadUrl('https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=k1&dl=0'),
    { provider: 'dropbox', url: 'https://www.dropbox.com/scl/fi/abc123/song.mp3?rlkey=k1&dl=1' });
  assert.throws(() => shareDownloadUrl('https://www.dropbox.com/sh/abc/folder?dl=0'), { code: 'share_link_unsupported' });
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const link of [`https://drive.google.com/file/d/${id}/view?usp=sharing`, `https://drive.google.com/open?id=${id}`]) {
    assert.equal(shareDownloadUrl(link)?.url, `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
  }
  assert.throws(() => shareDownloadUrl('https://drive.google.com/drive/folders/abc'), { code: 'share_link_unsupported' });
  assert.match(shareDownloadUrl('https://1drv.ms/u/s!AbCdEf')!.url, /^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u![A-Za-z0-9_-]+\/root\/content$/);
  assert.equal(new URL(shareDownloadUrl('https://cuny-my.sharepoint.com/:u:/g/personal/a/EaBc?e=x')!.url).searchParams.get('download'), '1');
  assert.equal(shareDownloadUrl(source), null);
});

test('headers prove WAV and FLAC durations only when the bytes are complete', () => {
  assert.equal(wavDuration(wav(2)), 2);
  assert.equal(wavDuration(wav(2).subarray(0, 20000)), null);
  const badRate = wav(1); new DataView(badRate.buffer).setUint32(28, 1234, true);
  assert.equal(wavDuration(badRate), null);
  assert.equal(flacDuration(flac(10)), 10);
  assert.equal(flacDuration(flac(10, false)), null);
  assert.equal(inspectAudio(mp3(10)).format, 'mp3');
  assert.ok(Math.abs(inspectAudio(mp3(10)).durationSec - 10) < 0.05);
  const ogg = new Uint8Array(4096); ogg.set([0x4f, 0x67, 0x67, 0x53]);
  assert.throws(() => inspectAudio(ogg), { code: 'format_not_native', hosted: true });
});

test('a direct MP3 is stored under the fenced key with its hash and title', async t => {
  const AUDIO = bucket(t), audio = mp3(30);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), source); assert.equal(init?.redirect, 'manual');
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.length) } });
  });
  const result = await importLink({ AUDIO }, request());
  assert.ok(result.ok);
  assert.equal(result.key, `${keyPrefix}.mp3`); assert.equal(result.title, 'Night Song'); assert.equal(result.bytes, audio.length);
  const stored = new Uint8Array(await new Response((await AUDIO.get(result.key))!.body).arrayBuffer());
  assert.deepEqual(stored, audio);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', audio)).toString('hex');
  assert.equal(result.sha256, digest);
});

test('redirects are re-checked at every hop', async t => {
  const AUDIO = bucket(t), audio = wav(1);
  const hops: Record<string, Response | (() => Response)> = {
    [source]: new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/file.wav' } }),
    'https://cdn.example.net/file.wav': () => new Response(audio, { headers: { 'content-type': 'audio/wav' } }),
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const next = hops[String(input)]; assert.ok(next, `unexpected fetch ${input}`);
    return typeof next === 'function' ? next() : next;
  });
  const followed = await importLink({ AUDIO }, request());
  assert.ok(followed.ok); assert.equal(followed.key, `${keyPrefix}.wav`);

  for (const location of ['https://127.0.0.1/x.mp3', 'http://cdn.example.net/x.mp3', 'https://stem-splitter.ailab-452.workers.dev/api/x',
    'https://stem-splitter.ailab-452.workers.dev./api/x', 'https://STEM-SPLITTER.AILAB-452.WORKERS.DEV/api/x']) {
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      assert.equal(String(input), source, 'a refused redirect target must never be requested');
      return new Response(null, { status: 301, headers: { location } });
    });
    const refused = await importLink({ AUDIO }, request());
    assert.ok(!refused.ok); assert.equal(refused.code, 'source_untrusted_redirect');
  }
});

test('a host check runs before every hop and fails closed', async t => {
  const AUDIO = bucket(t), checked: string[] = [];
  const isPublicHost = async (hostname: string) => { checked.push(hostname); return hostname !== 'internal.example.net'; };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.equal(String(input), source, 'the private redirect target must never be requested');
    return new Response(null, { status: 302, headers: { location: 'https://internal.example.net/x.mp3' } });
  });
  const refused = await importLink({ AUDIO, isPublicHost }, request());
  assert.ok(!refused.ok); assert.equal(refused.code, 'source_untrusted_redirect');
  assert.deepEqual(checked, ['media.example.org', 'internal.example.net']);
  const failing = await importLink({ AUDIO, isPublicHost: async () => { throw new Error('resolver down'); } }, request());
  assert.ok(!failing.ok); assert.equal(failing.code, 'invalid_source_url');
});

test('the Node host check rejects loopback names and address literals', async () => {
  const { isPublicHost } = await import('../server/public-host.ts');
  assert.equal(await isPublicHost('localhost'), false);
  assert.equal(await isPublicHost('127.0.0.1'), false);
  assert.equal(await isPublicHost('::1'), false);
});

test('pages and oversized files go to the hosted importer; private shares are refused', async t => {
  const AUDIO = bucket(t);
  const page = new TextEncoder().encode('<!doctype html><html><body>' + 'x'.repeat(2000) + '</body></html>');
  t.mock.method(globalThis, 'fetch', async () => new Response(page, { headers: { 'content-type': 'text/html' } }));
  const direct = await importLink({ AUDIO }, request('https://band.example.org/track/1'));
  assert.ok(!direct.ok); assert.equal(direct.hosted, true);
  const share = await importLink({ AUDIO }, request('https://www.dropbox.com/s/abc/song.mp3?dl=0'));
  assert.ok(!share.ok); assert.equal(share.code, 'share_link_not_public'); assert.equal(share.hosted, false);

  t.mock.restoreAll();
  let pulled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 }),
    { headers: { 'content-type': 'audio/wav', 'content-length': String(50 * 1024 * 1024) } }));
  const large = await importLink({ AUDIO }, request('https://media.example.org/long.wav'));
  assert.ok(!large.ok); assert.equal(large.hosted, true); assert.equal(pulled, false);
  assert.equal(await AUDIO.head(`${keyPrefix}.wav`), null);
});

test('limits, missing files and transient errors map to stable codes', async t => {
  const AUDIO = bucket(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(mp3(301), { headers: { 'content-type': 'audio/mpeg' } }));
  const long = await importLink({ AUDIO }, request(source, 300));
  assert.ok(!long.ok); assert.equal(long.code, 'source_too_long');
  assert.equal(await AUDIO.head(`${keyPrefix}.mp3`), null);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('gone', { status: 404 }));
  const missing = await importLink({ AUDIO }, request());
  assert.ok(!missing.ok); assert.equal(missing.code, 'source_not_found');

  t.mock.restoreAll();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
    : new Response(wav(1), { headers: { 'content-type': 'audio/wav' } }));
  const retried = await importLink({ AUDIO }, request());
  assert.ok(retried.ok); assert.equal(calls, 2);

  // archive.org mirrors fail with intermittent 500s; retries are bounded.
  t.mock.restoreAll();
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('mirror error', { status: 500 }); });
  const exhausted = await importLink({ AUDIO }, request());
  assert.ok(!exhausted.ok); assert.equal(exhausted.code, 'source_unavailable'); assert.equal(exhausted.retryable, true);
  assert.equal(calls, 3);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No network request is allowed for these inputs'));
  const forged = await importLink({ AUDIO }, { ...request(), keyPrefix: 'jobs/other/stems' });
  assert.ok(!forged.ok); assert.equal(forged.code, 'invalid_request');
  const video = await importLink({ AUDIO }, request('https://youtu.be/jNQXAC9IVRw'));
  assert.ok(!video.ok); assert.equal(video.hosted, true);
});

test('YouTube links resolve to metadata only; other links are classified without fetching', async t => {
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json({ title: 'Me at the zoo', author_name: 'jawed' });
  });
  const youtube = await resolveLink('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=4');
  assert.equal(youtube.kind, 'youtube');
  assert.ok(youtube.kind === 'youtube' && youtube.title === 'Me at the zoo' && youtube.query);
  assert.deepEqual(requested, ['https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw']);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
  const hidden = await resolveLink('https://youtu.be/jNQXAC9IVRw');
  assert.deepEqual(hidden, { kind: 'youtube', videoId: 'jNQXAC9IVRw', canonicalUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', title: null, author: null, query: null });

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Classification needs no request'));
  assert.deepEqual(await resolveLink('https://vimeo.com/160743502'), { kind: 'retired', provider: 'vimeo' });
  assert.deepEqual(await resolveLink('https://www.dropbox.com/s/abc/song.mp3?dl=0'), { kind: 'share', provider: 'dropbox' });
  assert.deepEqual(await resolveLink(source), { kind: 'direct' });
  assert.deepEqual(await resolveLink('http://media.example.org/a.mp3'), { kind: 'invalid' });
  assert.deepEqual(await resolveLink('https://drive.google.com/drive/folders/abc'), { kind: 'invalid' });
});

// Titles and channel names exactly as YouTube oEmbed returned them on 2026-10-17.
// Against the live Archive song search, the raw "channel title" text matched for
// 1 of these 13 videos and the cleaned queries for 9.
const REAL_TITLES: [title: string, author: string, query: string][] = [
  ['Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley', 'Rick Astley Never Gonna Give You Up'],
  ['Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen Official', 'Queen Bohemian Rhapsody'],
  ['Toto - Africa (Official HD Video)', 'TotoVEVO', 'Toto Africa'],
  ['Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars', 'MarkRonsonVEVO', 'Mark Ronson Uptown Funk'],
  ['Luis Fonsi - Despacito ft. Daddy Yankee', 'LuisFonsiVEVO', 'Luis Fonsi Despacito'],
  ['PSY - GANGNAM STYLE(강남스타일) M/V', 'officialpsy', 'PSY GANGNAM STYLE 강남스타일'],
  ['Adele - Hello (Official Music Video)', 'Adele', 'Adele Hello'],
  ['a-ha - Take On Me (Official Video) [4K]', 'a-ha', 'a-ha Take On Me'],
  ['Nirvana - Smells Like Teen Spirit (Official Music Video)', 'NirvanaVEVO', 'Nirvana Smells Like Teen Spirit'],
  ['Me at the zoo', 'jawed', 'jawed Me at the zoo'],
  ['The Sound of Silence (Original Version from 1964)', 'reptileman117', 'The Sound of Silence'],
  ["Guns N' Roses - Sweet Child O' Mine (Official Music Video)", 'GunsNRosesVEVO', "Guns N' Roses Sweet Child O' Mine"],
  ['Survivor - Eye Of The Tiger (Official HD Video)', 'SurvivorVEVO', 'Survivor Eye Of The Tiger'],
];

test('YouTube titles become short Archive queries', () => {
  for (const [title, author, query] of REAL_TITLES) assert.equal(youtubeSearchQuery(title, author), query, title);
});

test('channel conventions: Topic uploads, label words, run-together names and handles', () => {
  // Auto-generated "Artist - Topic" uploads carry a bare song title and release descriptors.
  assert.equal(youtubeSearchQuery('Bohemian Rhapsody (Remastered 2011)', 'Queen - Topic'), 'Queen Bohemian Rhapsody');
  assert.equal(youtubeSearchQuery('My Foolish Heart - Live At The Village Vanguard / 1961', 'Bill Evans Trio - Topic'), 'Bill Evans Trio My Foolish Heart');
  // Bracketed context that is not a video label stays.
  assert.equal(youtubeSearchQuery('Queen - Bohemian Rhapsody (Live Aid 1985)', 'Queen Official'), 'Queen Bohemian Rhapsody Live Aid 1985');
  // A dash title already names the artist; a label channel would only add noise.
  assert.equal(youtubeSearchQuery('The Doors - Light My Fire', 'Rhino'), 'The Doors Light My Fire');
  // Without a dash the channel supplies the artist, once.
  assert.equal(youtubeSearchQuery('Bohemian Rhapsody', 'Queen Official'), 'Queen Bohemian Rhapsody');
  assert.equal(youtubeSearchQuery('Queen Bohemian Rhapsody', 'Queen Official'), 'Queen Bohemian Rhapsody');
  assert.equal(youtubeSearchQuery('Africa', 'TotoVEVO'), 'Toto Africa');
  assert.equal(youtubeSearchQuery('Song Title | Official Audio', 'Some Artist'), 'Some Artist Song Title');
  assert.equal(youtubeSearchQuery('#shorts drum cover', 'drummer42'), 'drum cover');
});

test('empty or label-only titles give no query, and long ones end on a word', () => {
  assert.equal(youtubeSearchQuery(null, null), null);
  assert.equal(youtubeSearchQuery('(Official Video)', null), null);
  assert.equal(youtubeSearchQuery('', 'reptileman117'), null);
  const long = youtubeSearchQuery(`Artist - ${'Extraordinarily '.repeat(12)}Long Song`, 'Artist')!;
  assert.ok(long.length <= 120 && !long.endsWith(' ') && long.startsWith('Artist Extraordinarily'));
});

test('the import Worker exposes only its two POST paths', async t => {
  const AUDIO = bucket(t);
  assert.equal((await handleLinkImportRequest(new Request('https://link-import.internal/v1/import'), { AUDIO })).status, 404);
  assert.equal((await handleLinkImportRequest(new Request('https://link-import.internal/other', { method: 'POST', body: '{}' }), { AUDIO })).status, 404);
  const malformed = await handleLinkImportRequest(new Request('https://link-import.internal/v1/import', { method: 'POST', body: 'nope' }), { AUDIO });
  assert.equal(malformed.status, 400);
});

// --- splitter integration ----------------------------------------------------

const subject = 'cail-' + 'f'.repeat(32);
const principal: AppPrincipal = { subject, role: 'student', displayName: 'Fixture', course: null, courseId: null };
const importVersion = 'a'.repeat(64), splitVersion = 'b'.repeat(64);

async function splitter(t: { after: (f: () => void) => void }, options: { enabled?: boolean; binding?: 'worker' | 'broken' | 'none' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-link-split-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = new SqliteD1(join(directory, 'db'));
  local.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = local as unknown as D1Database;
  await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const AUDIO = new FsR2Bucket(join(directory, 'audio')) as unknown as R2Bucket;
  const calls: string[] = [];
  const binding = options.binding ?? 'worker';
  const LINK_IMPORT = binding === 'none' ? undefined : {
    fetch: async (request: Request) => {
      calls.push(new URL(request.url).pathname);
      if (binding === 'broken') throw new Error('service unavailable');
      return handleLinkImportRequest(request, { AUDIO });
    },
  };
  const env = { DB: db, AUDIO, AUTH_MODE: 'cail', SEPARATION_BACKEND: 'replicate', LOCAL_HOSTING: 'true', CLASS_CODE: 'link-fixture',
    PUBLIC_BASE_URL: 'https://split.test', WEBHOOK_SECRET: 'fixture-only', REPLICATE_API_TOKEN: 'fixture-replicate-token',
    REPLICATE_YT_MODEL: 'test/video-audio', REPLICATE_YT_MODEL_VERSION: importVersion, REPLICATE_MODEL_VERSION: splitVersion,
    ADMISSION_RESOLVER: { resolveCourseAccess: ({ subject, classId }: { subject: string; classId: string }) => courseFixture(subject, classId) },
    URL_IMPORT_ENABLED: 'true', ...(options.enabled === false ? {} : { LINK_IMPORT_ENABLED: 'true' }), LINK_IMPORT,
  } as unknown as Env;
  return { db, env, calls };
}

/** Source host answers with `body`; Replicate POSTs are recorded and accepted. */
function network(t: { mock: { method: Function } }, body: () => Response) {
  const posts: { version?: string; input?: Record<string, unknown> }[] = [];
  (t.mock.method as (o: object, m: string, f: Function) => void)(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.replicate.com/')) {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      return Response.json({ id: `prediction-${posts.length}`, status: 'starting' });
    }
    assert.ok(url.startsWith('https://media.example.org/'), `unexpected fetch ${url}`);
    return body();
  });
  return posts;
}

test('a direct link is imported natively and goes straight to separation', async t => {
  const { db, env, calls } = await splitter(t);
  const posts = network(t, () => new Response(mp3(20), { headers: { 'content-type': 'audio/mpeg' } }));
  const reservation = await submitSplit(env, principal, { sourceUrl: source }, 'native-direct-link-0001');
  await drainSplitQueue(env, async () => {});
  assert.deepEqual(calls, ['/v1/import']);
  assert.equal(posts.length, 1, 'only the separation start reaches Replicate');
  assert.equal(posts[0].version, splitVersion);
  assert.equal(posts[0].input?.general_url, undefined);
  const op = (await readOperation(db, reservation.operation.id))!;
  assert.equal(op.phase, 'split');
  const job = await db.prepare('SELECT source_key,source_hash,filename FROM jobs WHERE id=?').bind(op.job_id).first<{ source_key: string; source_hash: string; filename: string }>();
  assert.match(job!.source_key, new RegExp(`^uploads/${op.id}/source-\\d+\\.mp3$`));
  assert.match(job!.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(job!.filename, 'Night Song');
  assert.ok(await env.AUDIO.head(job!.source_key));
});

test('formats the native importer cannot prove fall back to the hosted importer once', async t => {
  const { env, calls } = await splitter(t);
  const ogg = new Uint8Array(4096); ogg.set([0x4f, 0x67, 0x67, 0x53]);
  const posts = network(t, () => new Response(ogg, { headers: { 'content-type': 'audio/ogg' } }));
  await submitSplit(env, principal, { sourceUrl: 'https://media.example.org/take.ogg' }, 'native-hosted-link-0001');
  await drainSplitQueue(env, async () => {});
  assert.deepEqual(calls, ['/v1/import']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].version, importVersion);
  assert.equal(posts[0].input?.general_url, true);
});

test('a native refusal fails the operation without any provider start', async t => {
  const { db, env } = await splitter(t);
  const posts = network(t, () => new Response('missing', { status: 404 }));
  const reservation = await submitSplit(env, principal, { sourceUrl: source }, 'native-missing-link-001');
  await drainSplitQueue(env, async () => {});
  assert.equal(posts.length, 0);
  const op = (await readOperation(db, reservation.operation.id))!;
  assert.equal(op.error_code, 'source_not_found');
  const job = await db.prepare('SELECT status,error FROM jobs WHERE id=?').bind(op.job_id).first<{ status: string; error: string }>();
  assert.equal(job!.status, 'failed'); assert.match(job!.error, /No allowance was used\.$/);
});

test('an unreachable import Worker fails closed; flag off keeps the hosted path', async t => {
  const broken = await splitter(t, { binding: 'broken' });
  const none = network(t, () => assert.fail('The source must not be fetched'));
  const reservation = await submitSplit(broken.env, principal, { sourceUrl: source }, 'native-broken-link-0001');
  await drainSplitQueue(broken.env, async () => {});
  assert.equal(none.length, 0);
  assert.equal((await readOperation(broken.db, reservation.operation.id))!.error_code, 'link_import_unavailable');

  t.mock.restoreAll();
  const off = await splitter(t, { enabled: false });
  const posts = network(t, () => assert.fail('The flag-off path must not fetch the source itself'));
  await submitSplit(off.env, principal, { sourceUrl: source }, 'native-flag-off-link-001');
  await drainSplitQueue(off.env, async () => {});
  assert.deepEqual(off.calls, []);
  assert.equal(posts.length, 1); assert.equal(posts[0].input?.general_url, true);
});

test('class-code jobs import direct links natively before creating the job row', async t => {
  const { db, env, calls } = await splitter(t);
  const posts = network(t, () => new Response(wav(2), { headers: { 'content-type': 'audio/wav' } }));
  const response = await app.fetch(new Request('https://split.test/api/jobs', { method: 'POST',
    headers: { 'x-class-code': 'link-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://media.example.org/take.wav' }) }),
    { ...env, AUTH_MODE: undefined });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(calls, ['/v1/import']);
  assert.ok(posts.every(post => post.input?.general_url === undefined), 'no hosted import');
  const job = await db.prepare('SELECT source_key,filename FROM jobs ORDER BY rowid DESC LIMIT 1').first<{ source_key: string; filename: string }>();
  assert.match(job!.source_key, /^uploads\/[0-9a-f-]{36}\/source-0\.wav$/);
  assert.equal(job!.filename, 'take');

  t.mock.restoreAll();
  network(t, () => new Response('nope', { status: 404 }));
  const missing = await app.fetch(new Request('https://split.test/api/jobs', { method: 'POST',
    headers: { 'x-class-code': 'link-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceUrl: source }) }),
    { ...env, AUTH_MODE: undefined });
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as { code: string }).code, 'source_not_found');
});

test('import options and link lookup follow the flag', async t => {
  const call = (env: Env, path: string, init: RequestInit = {}) => app.fetch(new Request('https://split.test' + path,
    { ...init, headers: { 'x-class-code': 'link-fixture', 'Content-Type': 'application/json' } }), { ...env, AUTH_MODE: undefined });
  const off = await splitter(t, { enabled: false });
  assert.deepEqual(await (await call(off.env, '/api/import-options')).json(), { urlImport: true, maxDurationSeconds: 900 });
  assert.equal((await call(off.env, '/api/link-info', { method: 'POST', body: JSON.stringify({ url: source }) })).status, 503);

  const on = await splitter(t);
  assert.equal(((await (await call(on.env, '/api/import-options')).json()) as { linkRouter?: boolean }).linkRouter, true);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('A direct link is classified without fetching'));
  const lookup = await call(on.env, '/api/link-info', { method: 'POST', body: JSON.stringify({ url: source }) });
  assert.equal(lookup.status, 200);
  assert.deepEqual(await lookup.json(), { kind: 'direct' });
  assert.deepEqual(on.calls, ['/v1/resolve']);
});
