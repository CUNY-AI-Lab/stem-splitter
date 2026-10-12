import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ArchiveError, fetchArchiveAudio, fetchArchiveItem, searchArchiveSongs } from '../src/archive.ts';
import { mp3FrameInfo } from '../src/reliability/media.ts';
const audio=new Uint8Array(readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url)));
const duration=mp3FrameInfo(audio.buffer)!.seconds;
const file=(extra:Record<string,unknown>={})=>({name:'song.mp3',title:'Song fixture',size:String(audio.length),length:String(duration),...extra});
const metadata=(extra:Record<string,unknown>={},files=[file()])=>Response.json({metadata:{title:'Song fixture',creator:'Artist',...extra},files});

test('search returns matching downloadable files and filters restricted, private, oversized and unavailable recordings',async t=>{
  const ids=['good','denied','html','restricted','private','large','unrelated'];
  const downloadRequests:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(init?.redirect,'manual');
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:ids.map(identifier=>({identifier}))}});
    const id=url.pathname.split('/')[2];
    if(url.pathname.startsWith('/metadata/')){
      if(id==='restricted')return metadata({'access-restricted-item':'true'});
      if(id==='private')return metadata({},[file({private:'true'})]);
      if(id==='large')return metadata({},[file({size:String(13*1024*1024)})]);
      if(id==='unrelated')return metadata({title:'Song fixture'},[file({title:'Another track'})]);
      return metadata();
    }
    downloadRequests.push(id);assert.equal(new Headers(init?.headers).get('range'),'bytes=0-65535');
    if(id==='denied')return new Response('',{status:403});
    if(id==='html')return new Response('<html>Unavailable</html>',{headers:{'content-type':'text/html','content-length':String(audio.length)}});
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  const result=await searchArchiveSongs('Artist Song fixture');
  assert.equal(result.results.length,1);assert.equal(result.results[0].archiveId,'good');
  assert.equal(result.results[0].archiveFile,'song.mp3');assert.equal(result.results[0].artist,'Artist');
  assert.deepEqual(downloadRequests.sort(),['denied','good','html']);
});

test('public Archive import accepts downloadable metadata, checks complete bytes and rejects partial audio',async t=>{
  let mode='full';let calls=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    calls++;
    if(String(input).includes('/metadata/'))return metadata({},[file(mode==='suffix'?{size:String(audio.length+2)}:{})]);
    if(mode==='suffix'){const exported=new Uint8Array(audio.length+2);exported.set(audio);exported.set([0x7b,0x7d],audio.length);return new Response(exported,{headers:{'content-type':'audio/mpeg'}});}
    if(mode==='partial')return new Response(audio.subarray(0,audio.length-100),{headers:{'content-type':'audio/mpeg'}});
    if(mode==='range')return new Response(audio,{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${audio.length-1}/${audio.length}`}});
    return new Response(audio,{headers:{'content-type':'audio/mpeg'}});
  });
  const load=()=>fetchArchiveAudio('good','song.mp3',{} as never,{publicAudio:true});
  const loaded=await load();assert.equal(loaded.data.byteLength,audio.length);assert.equal(loaded.durationSec,duration);
  assert.equal(loaded.attribution.creator,'Artist');assert.equal(loaded.attribution.licenseUrl,'');
  mode='suffix';assert.deepEqual(new Uint8Array((await load()).data),audio);
  mode='partial';await assert.rejects(load,(error:unknown)=>error instanceof ArchiveError&&error.code==='archive_source_changed');
  mode='range';await assert.rejects(load,(error:unknown)=>error instanceof ArchiveError&&error.code==='archive_download_unavailable');
  assert.equal(calls,8);
});

test('public download options preserve remix licensing and exclude private audio files',async t=>{
  t.mock.method(globalThis,'fetch',async()=>metadata({},[file({private:'true'}),file({name:'visible.mp3'})]));
  const item=await fetchArchiveItem('good',{publicAudio:true});assert.deepEqual(item.tracks.map(track=>track.name),['visible.mp3']);
  await assert.rejects(()=>fetchArchiveAudio('good','visible.mp3',{} as never,{publicAudio:true,remix:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='license_missing');
});
