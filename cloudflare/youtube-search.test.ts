import test from 'node:test';
import assert from 'node:assert/strict';
import { searchYouTube, youtubeTracks } from '../src/youtube-search.ts';

const video = (id: string, seconds: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: { text: `Song ${id}` }, author: { name: 'Fixture Channel' }, duration: { seconds }, ...extra });

test('search results become importable YouTube tracks', () => {
  const [track] = youtubeTracks([video('Yxep-gS-Btg', 258, { author: { name: 'Yellow Magic Orchestra - Topic' } })], 900);
  assert.deepEqual(track, {
    id: 'youtube:Yxep-gS-Btg', provider: 'youtube', videoUrl: 'https://www.youtube.com/watch?v=Yxep-gS-Btg',
    sourceUrl: 'https://www.youtube.com/watch?v=Yxep-gS-Btg', title: 'Song Yxep-gS-Btg',
    channel: 'Yellow Magic Orchestra - Topic', itemCreator: 'Yellow Magic Orchestra', durationSec: 258, providerName: 'YouTube',
  });
});

test('only videos that can be imported are listed', () => {
  const ids = youtubeTracks([
    video('aaaaaaaaaaa', 20), // a clip
    video('bbbbbbbbbbb', 400), // past the guest limit
    video('ccccccccccc', 200, { is_live: true }),
    video('ddddddddddd', 200, { is_upcoming: true }),
    video('not-an-id', 200),
    video('eeeeeeeeeee', Number.NaN),
    video('fffffffffff', 200, { title: { text: '   ' } }),
    video('ggggggggggg', 200),
    video('ggggggggggg', 200), // repeated
  ], 300).map(track => track.id);
  assert.deepEqual(ids, ['youtube:ggggggggggg']);
});

test('members keep fifteen-minute videos, and the list stays short', () => {
  const videos = Array.from({ length: 12 }, (_, i) => video(`v${String(i).padStart(10, '0')}`, 800));
  assert.equal(youtubeTracks(videos, 300).length, 0);
  assert.equal(youtubeTracks(videos, 900).length, 8);
});

test('titles and channels lose control characters and stay bounded', () => {
  const [track] = youtubeTracks([video('hhhhhhhhhhh', 100, { title: { text: `A\u0000B\n${'x'.repeat(300)}` }, author: { name: 'C\u0007D' } })], 900);
  assert.equal(track.title.startsWith('A B x'), true);
  assert.equal(track.title.length, 200);
  assert.equal(track.channel, 'C D');
});

const fetcher = { YOUTUBE_FETCHER_URL: 'https://fetcher.example', YOUTUBE_FETCHER_SECRET: 'f'.repeat(40) };
const fetcherAnswer = () => Response.json({ results: [{ id: 'Yxep-gS-Btg', title: 'Rydeen', channel: 'Fixture Channel', duration: 259, live: false }] });
async function withFetch<T>(handler: (request: Request) => Response, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("YouTube's own search answers without asking the fetcher", async () => {
  let calls = 0;
  const { results } = await withFetch(() => { calls++; return fetcherAnswer(); },
    () => searchYouTube(' rydeen ', { maximumSeconds: 900, fetcher }, async query => { assert.equal(query, 'rydeen'); return [video('aaaaaaaaaaa', 200)]; }));
  assert.deepEqual(results.map(track => track.id), ['youtube:aaaaaaaaaaa']);
  assert.equal(calls, 0);
});

test('a failed, empty or slow YouTube search falls back to the fetcher', async () => {
  for (const [reason, innertube] of [
    ['failed', async () => { throw new Error('bot check'); }],
    ['empty', async () => []],
    ['slow', () => new Promise<never>(() => {})],
  ] as const) {
    const seen: Request[] = [];
    const started = Date.now();
    const { results } = await withFetch(request => { seen.push(request); return fetcherAnswer(); },
      () => searchYouTube('rydeen', { maximumSeconds: 900, fetcher }, innertube as never));
    assert.deepEqual(results.map(track => [track.id, track.channel, track.durationSec]), [['youtube:Yxep-gS-Btg', 'Fixture Channel', 259]], reason);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://fetcher.example/search');
    assert.equal(seen[0].headers.get('authorization'), `Bearer ${'f'.repeat(40)}`);
    assert.deepEqual(await seen[0].json(), { query: 'rydeen' });
    if (reason === 'slow') assert.ok(Date.now() - started >= 3400 && Date.now() - started < 5000, 'waits 3.5 s, then asks the fetcher');
  }
});

test('without a fetcher a failed search fails, and an empty one is empty', async () => {
  await assert.rejects(searchYouTube('rydeen', { maximumSeconds: 900 }, async () => { throw new Error('bot check'); }), /bot check/);
  assert.deepEqual((await searchYouTube('rydeen', { maximumSeconds: 900 }, async () => [])).results, []);
});

test('a fetcher that cannot search makes the YouTube source unavailable, not empty', async () => {
  for (const answer of [() => Response.json({ code: 'fetcher_busy' }, { status: 429 }), () => Response.json({ nothing: true }), () => new Response('down', { status: 530 })]) {
    await withFetch(answer, () => assert.rejects(searchYouTube('rydeen', { maximumSeconds: 900, fetcher }, async () => { throw new Error('bot check'); })));
  }
});

test("the fetcher's results pass the same filters: live and too-long videos are dropped", async () => {
  const { results } = await withFetch(() => Response.json({ results: [
    { id: 'Yxep-gS-Btg', title: 'Rydeen', channel: 'C', duration: 259, live: false },
    { id: 'bbbbbbbbbbb', title: 'Live', channel: 'C', duration: null, live: true },
    { id: 'ccccccccccc', title: 'Long', channel: 'C', duration: 400, live: false },
  ] }), () => searchYouTube('rydeen', { maximumSeconds: 300, fetcher }, async () => []));
  assert.deepEqual(results.map(track => track.id), ['youtube:Yxep-gS-Btg']);
});
