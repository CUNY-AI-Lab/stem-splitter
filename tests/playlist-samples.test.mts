import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sourcePlaylists from '../docs/sound-station-source-playlists.json' with { type: 'json' };
import { archiveSongSearchKey, fetchArchiveItem, verifyArchiveSample, verifyArchiveSampleFile } from '../src/archive.ts';
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
      reads++; return Response.json({metadata:{title:track.title,creator:track.artist,mediatype:'audio',subject:'Music'},files:[{name:track.archiveFile,title:track.title,size:String(audio.length),length:'2'}]});
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
    assert.equal(importItem.tracks[0].importable,true);
  } finally {globalThis.fetch=original;}
});


test('the public sample allowlist stays within all six supplied playlists', () => {
  assert.equal(sourcePlaylists.length,83);
  assert.equal(new Set(sourcePlaylists.map(t=>t.playlist)).size,6);
  const supplied=new Set(sourcePlaylists.map(t=>archiveSongSearchKey(`${t.artist} ${t.title}`)));
  for(const candidate of candidates) assert.ok(supplied.has(archiveSongSearchKey(`${candidate.artist} ${candidate.title}`)) || candidate.artist==='Bill Evans' && supplied.has(archiveSongSearchKey(`Bill Evans Trio ${candidate.title}`)),candidate.title);
  assert.equal(new Set(candidates.map(t=>`${t.archiveId}/${t.archiveFile}`)).size,candidates.length);
});


test('an available recording beyond the example duration limit is never a public suggestion',async()=>{
 const t=candidates[1],original=globalThis.fetch,audio=readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url));
 globalThis.fetch=async input=>String(input).includes('/metadata/')?Response.json({metadata:{title:t.title,creator:t.artist,mediatype:'audio',subject:'Music'},files:[{name:t.archiveFile,title:t.title,size:String(audio.length),length:'620'}]}):new Response(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}});
 try{
  assert.equal((await verifyArchiveSample(`${t.artist} ${t.title}`,t.archiveId,t.archiveFile,'availability')).results.length,1);
  const request=new Request('https://split.test/api/music/search?'+new URLSearchParams({q:`${t.artist} ${t.title}`,sampleItem:t.archiveId,sampleFile:t.archiveFile}));
  const response=await playlistSampleResponse(request);assert.equal((await response.json()).results.length,0);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await fetchArchiveItem(t.archiveId,{publicAudio:true})).tracks[0].importable,false);
 }finally{globalThis.fetch=original;}
});

test('edited playlist labels retain exact source verification and Archive metadata, including cached responses',async t=>{
 const display={artist:'Class example',title:'Opening selection',archiveId:'renamed-playlist-fixture',archiveFile:'original.mp3'};
 const audio=readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url));let metadataReads=0;
 t.mock.method(globalThis,'fetch',async input=>{
  if(String(input).includes('/metadata/')){metadataReads++;return Response.json({metadata:{title:'Archive concert',creator:'Archive item creator',mediatype:'audio',subject:'Music'},files:[{name:display.archiveFile,title:'Original source title',artist:'Original source artist',size:String(audio.length),length:'2'}]});}
  return new Response(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}});
 });
 const request=(title:string)=>new Request('https://split.test/api/music/search?'+new URLSearchParams({q:`${display.artist} ${title}`,sampleItem:display.archiveId,sampleFile:display.archiveFile}));
 const first=await playlistSampleResponse(request(display.title),undefined,[display]);
 const result=(await first.json()).results[0];
 assert.equal(result.title,display.title);assert.equal(result.artist,display.artist);
 assert.equal(result.sourceTitle,'Original source title');assert.equal(result.sourceArtist,'Original source artist');
 assert.equal(result.itemTitle,'Archive concert');assert.equal(result.itemCreator,'Archive item creator');
 assert.equal(result.archiveId,display.archiveId);assert.equal(result.archiveFile,display.archiveFile);
 const updated={...display,title:display.title+'!'};
 const cached=await playlistSampleResponse(request(updated.title),undefined,[updated]);
 const current=(await cached.json()).results[0];
 assert.equal(current.title,updated.title);assert.equal(current.sourceTitle,'Original source title');assert.equal(metadataReads,1);
 const wrongFile=new Request(request(updated.title).url.replace('original.mp3','another.mp3'));
 assert.equal((await playlistSampleResponse(wrongFile,undefined,[updated])).status,400);
});

test('exact-file verification keeps duration, public music and delivery restrictions',async t=>{
 const audio=readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url));let mode='valid',downloads=0;
 t.mock.method(globalThis,'fetch',async input=>{
  if(String(input).includes('/metadata/'))return Response.json({metadata:{title:'Original session',creator:'Original performer',mediatype:'audio',subject:mode==='speech'?'Podcast':'Music'},files:[{name:'original.mp3',title:'Original source title',artist:'Original performer',size:String(audio.length),length:mode==='long'?'301':'2',...(mode==='private'?{private:'true'}:{})}]});
  downloads++;return mode==='html'?new Response('<html>Unavailable</html>',{headers:{'content-type':'text/html','content-length':String(audio.length)}}):new Response(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}});
 });
 assert.equal((await verifyArchiveSampleFile('exact-file-fixture','original.mp3')).results.length,1);
 assert.equal((await verifyArchiveSampleFile('exact-file-fixture','missing.mp3')).results.length,0);
 mode='long';assert.equal((await verifyArchiveSampleFile('exact-file-fixture','original.mp3')).results.length,0);
 mode='html';assert.equal((await verifyArchiveSampleFile('exact-file-fixture','original.mp3')).results.length,0);
 for(mode of ['private','speech'])await assert.rejects(()=>verifyArchiveSampleFile('exact-file-fixture','original.mp3'));
 assert.equal(downloads,2);
});
