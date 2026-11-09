import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteD1 } from '../server/d1.ts';
import { fetcherSearchAllowed, searchAllowed, searcherKey } from '../src/search-limits.ts';
import { containsYouTubeLink } from '../src/video-source.ts';
import { searchYouTube, YouTubeSearchLimited } from '../src/youtube-search.ts';
import { musicSearchResponse } from '../src/music-search.ts';
import app from '../src/index.ts';

// Behaves like a Workers rate-limit binding: so many requests per key, then refused.
const binding = (allowed: number) => {
  const counts = new Map<string, number>();
  return { counts, limit: async ({ key }: { key: string }) => {
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count); return { success: count <= allowed };
  } };
};
const broken = { limit: async () => { throw new Error('limiter unavailable'); } };
const fetcher = { YOUTUBE_FETCHER_URL: 'https://fetcher.example', YOUTUBE_FETCHER_SECRET: 'f'.repeat(40) };
function database(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'stem-search-limits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new SqliteD1(join(directory, 'db')); db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return db as unknown as D1Database;
}

test('each person is counted on their own: account or guest session, else the connection', () => {
  assert.equal(searcherKey('guest-abc', '192.0.2.1'), 'account:guest-abc');
  assert.equal(searcherKey(undefined, '192.0.2.1'), 'address:192.0.2.1');
  assert.equal(searcherKey(undefined, undefined), 'address:unknown');
});

test('a person may search 120 times a minute; others are unaffected; a broken limiter does not stop search', async () => {
  const SEARCH_LIMIT = binding(120);
  for (let i = 0; i < 120; i++) assert.equal(await searchAllowed({ SEARCH_LIMIT }, 'account:a'), true);
  assert.equal(await searchAllowed({ SEARCH_LIMIT }, 'account:a'), false);
  assert.equal(await searchAllowed({ SEARCH_LIMIT }, 'account:b'), true);
  assert.equal(await searchAllowed({}, 'account:a'), true);
  assert.equal(await searchAllowed({ SEARCH_LIMIT: broken }, 'account:a'), true);
});

test('a person may send 10 searches a minute to the fetcher; a broken limiter leaves YouTube out', async () => {
  const FETCHER_SEARCH_LIMIT = binding(10);
  for (let i = 0; i < 10; i++) assert.equal(await fetcherSearchAllowed({ FETCHER_SEARCH_LIMIT }, 'account:a'), true);
  assert.equal(await fetcherSearchAllowed({ FETCHER_SEARCH_LIMIT }, 'account:a'), false);
  assert.equal(await fetcherSearchAllowed({ FETCHER_SEARCH_LIMIT }, 'account:b'), true);
  assert.deepEqual([...FETCHER_SEARCH_LIMIT.counts.keys()], ['fetcher-search:account:a', 'fetcher-search:account:b']);
  assert.equal(await fetcherSearchAllowed({ FETCHER_SEARCH_LIMIT: broken }, 'account:a'), false);
});

test('YouTube links are recognised with or without https:// and inside shared text, song names are not', () => {
  for (const link of ['https://www.youtube.com/watch?v=Yxep-gS-Btg', 'youtu.be/Yxep-gS-Btg', 'www.youtube.com/watch?v=Yxep-gS-Btg',
    'Watch this: https://youtu.be/Yxep-gS-Btg?si=x', 'music.youtube.com/watch?v=Yxep-gS-Btg', 'm.youtube.com/shorts/Yxep-gS-Btg',
    'HTTP://YOUTU.BE/Yxep-gS-Btg', 'rydeen (youtube.com/watch?v=Yxep-gS-Btg)']) assert.equal(containsYouTubeLink(link), true, link);
  for (const words of ['rydeen', 'youtube.com rewind', 'youtube music playlist', 'notyoutube.com/x', 'the youtube.comedy hour', 'youtu be'])
    assert.equal(containsYouTubeLink(words), false, words);
});

test('the fetcher is asked only when YouTube did not answer, and not past the limit', async t => {
  let asked = 0, consulted = 0;
  t.mock.method(globalThis, 'fetch', async () => { asked++; return Response.json({ results: [{ id: 'Yxep-gS-Btg', title: 'Rydeen', channel: 'C', duration: 259 }] }); });
  const video = { id: 'aaaaaaaaaaa', title: { text: 'Song' }, author: { name: 'C' }, duration: { seconds: 200 } };
  const answered = await searchYouTube('rydeen', { maximumSeconds: 900, fetcher, fallbackAllowed: async () => { consulted++; return false; } }, async () => [video] as never);
  assert.equal(answered.results.length, 1); assert.equal(consulted, 0, 'a search YouTube answered is not counted');
  await assert.rejects(searchYouTube('rydeen', { maximumSeconds: 900, fetcher, fallbackAllowed: async () => { consulted++; return false; } },
    async () => { throw new Error('bot check'); }), YouTubeSearchLimited);
  assert.equal(asked, 0); assert.equal(consulted, 1);
  const allowed = await searchYouTube('rydeen', { maximumSeconds: 900, fetcher, fallbackAllowed: async () => true }, async () => []);
  assert.equal(allowed.results[0].id, 'youtube:Yxep-gS-Btg'); assert.equal(asked, 1);
});

test('YouTube left out by the limit is unavailable for that search and not kept in the shared cache', async t => {
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname.endsWith('youtube.com')) throw new Error('bot check');
    if (url.hostname === 'fetcher.example') throw new Error('the fetcher must not be asked');
    if (url.hostname === 'api.openverse.org') return Response.json({ results: [] });
    if (url.hostname === 'commons.wikimedia.org') return Response.json({ query: { pages: [] } });
    return Response.json({ response: { docs: [] } });
  });
  const stored: string[] = [];
  const storage = { match: async () => undefined, put: async (key: Request) => { stored.push(key.url); } } as unknown as Cache;
  const response = await musicSearchResponse('rydeen', false, { db: database(t), maximumSeconds: 300, youtube: fetcher,
    youtubeFallbackAllowed: async () => false, cache: { storage, origin: 'https://stem.example' } });
  const result: any = await response.json();
  assert.equal(result.providers.youtube, 'unavailable');
  assert.equal(stored.some(url => url.includes('/youtube?')), false);
});

test('the search route refuses a person past the limit, and never searches for a YouTube link', async t => {
  const db = database(t); let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; return Response.json({ response: { docs: [] } }); });
  const request = (query: string, env: Record<string, unknown>) =>
    app.request('/api/music/search?q=' + encodeURIComponent(query), { headers: { 'x-class-code': 'fixture' } }, { DB: db, CLASS_CODE: 'fixture', ...env } as any);
  const limited = await request('rydeen', { SEARCH_LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '15');
  assert.equal(((await limited.json()) as any).error.code, 'search_rate_limited');
  for (const link of ['youtu.be/Yxep-gS-Btg', 'https://www.youtube.com/watch?v=Yxep-gS-Btg', 'Watch this: https://youtu.be/Yxep-gS-Btg']) {
    const refused = await request(link, {});
    assert.equal(refused.status, 400, link); assert.equal(((await refused.json()) as any).error.code, 'youtube_link_not_search');
  }
  assert.equal(outbound, 0, 'no source was asked');
});
