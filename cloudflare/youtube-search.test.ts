import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeTracks } from '../src/youtube-search.ts';

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
