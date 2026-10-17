import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sourcePlaylists from '../docs/sound-station-source-playlists.json' with { type: 'json' };
import { archiveSongSearchKey, fetchArchiveItem } from '../src/archive.ts';
import { isPlaylistSample, playlistSampleResponse } from '../src/playlist-samples.ts';
import candidates from '../public/search-samples.json' with { type: 'json' };

const track = candidates[0];
const url = 'https://split.test/api/music/search?' + new URLSearchParams({q:`${track.artist} ${track.title}`,sampleItem:track.archiveId,sampleFile:track.archiveFile});
test('only exact public playlist candidates qualify for anonymous verification', async () => {
  assert.equal(isPlaylistSample(new Request(url)),true);
  for(const request of [new Request(url,{method:'POST'}),new Request(url.replace(track.archiveId,'other-item')),new Request(url.replace('sampleFile=','wrongFile=')),new Request('https://split.test/api/music/search?q=jazz')]) {
    assert.equal(isPlaylistSample(request),false);
    assert.equal((await playlistSampleResponse(request)).status,400);
  }
});

test('verified public samples coalesce cold reads and cache exact audio without account data', async () => {
  const original=globalThis.fetch;
  const audio=readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url));
  let reads=0;
  globalThis.fetch=async input=>{
    if(String(input).includes('/metadata/')) {
      reads++; return Response.json({metadata:{title:track.title,creator:track.artist,mediatype:'audio',subject:'Music'},files:[{name:track.archiveFile,title:track.title,size:String(audio.length),length:'620'}]});
    }
    return new Response(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}});
  };
  try {
    const responses=await Promise.all([playlistSampleResponse(new Request(url)),playlistSampleResponse(new Request(url))]);
    assert.equal(reads,1);
    for(const response of responses) {
      assert.equal(response.headers.get('cache-control'),'public, max-age=60');
      const data=await response.json();assert.equal(data.results.length,1);assert.equal(data.results[0].archiveFile,track.archiveFile);
    }
    await playlistSampleResponse(new Request(url+'&unused=ignored'));
    assert.equal(reads,1,'arbitrary query parameters cannot defeat the verified cache');
    const importItem=await fetchArchiveItem(track.archiveId,{publicAudio:true});
    assert.equal(importItem.tracks[0].importable,false,'long playlist hints do not widen the public split limit');
  } finally {globalThis.fetch=original;}
});


test('the public sample allowlist stays within all six supplied playlists', () => {
  assert.equal(sourcePlaylists.length,83);
  assert.equal(new Set(sourcePlaylists.map(t=>t.playlist)).size,6);
  const supplied=new Set(sourcePlaylists.map(t=>archiveSongSearchKey(`${t.artist} ${t.title}`)));
  for(const candidate of candidates) assert.ok(supplied.has(archiveSongSearchKey(`${candidate.artist} ${candidate.title}`)),candidate.title);
  assert.equal(new Set(candidates.map(t=>`${t.archiveId}/${t.archiveFile}`)).size,candidates.length);
});
