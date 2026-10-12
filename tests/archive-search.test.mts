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
  const ids=['good','denied','html','disguised','restricted','private','large','unrelated'];
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
    if(id==='disguised'){
      const prefix=audio.slice(0,65536);prefix.set([0x4f,0x67,0x67,0x53]);
      return new Response(prefix,{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
    }
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  const result=await searchArchiveSongs('Artist Song fixture');
  assert.equal(result.results.length,1);assert.equal(result.results[0].archiveId,'good');
  assert.equal(result.results[0].archiveFile,'song.mp3');assert.equal(result.results[0].artist,'');
  assert.equal(result.results[0].itemCreator,'Artist');
  assert.deepEqual(downloadRequests.sort(),['denied','disguised','good','html']);
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
  assert.equal(loaded.attribution.creator,'');assert.equal(loaded.attribution.itemCreator,'Artist');assert.equal(loaded.attribution.licenseUrl,'');
  assert.equal(loaded.title,'Song fixture');
  mode='suffix';assert.deepEqual(new Uint8Array((await load()).data),audio);
  mode='partial';await assert.rejects(load,(error:unknown)=>error instanceof ArchiveError&&error.code==='archive_source_changed');
  mode='range';await assert.rejects(load,(error:unknown)=>error instanceof ArchiveError&&error.code==='archive_download_unavailable');
  assert.equal(calls,8);
});

test('Archive metadata keeps item creators separate from file credits and preserves distinct sources',async t=>{
  const records:Record<string,Response>={
    LostAndFound_929:metadata({title:'white rabbit',creator:'Jefferson Airplane',description:'<p>my best effort</p>'},[file({name:'1456.mp3',title:'white rabbit',artist:'Artist',creator:'Artist'})]),
    compilation:metadata({title:'Under The Influence Of Alice',creator:'Collection uploader'},[file({name:'01 White Rabbit.mp3',title:'white rabbit',artist:'Jefferson Airplane'})]),
    concert:metadata({title:'Live at the Fillmore',creator:'Jefferson Airplane',description:'Live concert recording'},[file({name:'white-rabbit-live.mp3',title:'white rabbit',artist:'Jefferson Airplane'})]),
    file_credit:metadata({title:'Another collection',creator:'Collection uploader',description:'gfgfkfj'},[file({name:'white-rabbit.mp3',title:'white rabbit',creator:'Jefferson Airplane'})]),
  };
  const requested:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:Object.keys(records).map(identifier=>({identifier}))}});
    if(url.pathname.startsWith('/metadata/'))return records[url.pathname.split('/')[2]].clone();
    requested.push(decodeURIComponent(url.pathname));
    return new Headers(init?.headers).has('range')
      ? new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}})
      : new Response(audio,{headers:{'content-type':'audio/mpeg'}});
  });
  const {results}=await searchArchiveSongs('Jefferson Airplane white rabbit');
  assert.equal(results.length,4);
  const personal=results.find(song=>song.archiveId==='LostAndFound_929')!;
  assert.equal(personal.artist,'');assert.equal(personal.fileCreator,'');
  assert.equal(personal.itemCreator,'Jefferson Airplane');assert.equal(personal.itemDescription,'my best effort');
  const compilation=results.find(song=>song.archiveId==='compilation')!;
  assert.equal(compilation.artist,'Jefferson Airplane');assert.equal(compilation.itemCreator,'Collection uploader');
  assert.equal(compilation.itemTitle,'Under The Influence Of Alice');
  assert.equal(results.find(song=>song.archiveId==='concert')?.itemTitle,'Live at the Fillmore');
  assert.equal(results.find(song=>song.archiveId==='file_credit')?.artist,'');
  assert.equal(results.find(song=>song.archiveId==='file_credit')?.fileCreator,'Jefferson Airplane');
  assert.equal(results.find(song=>song.archiveId==='file_credit')?.itemDescription,'');
  const loaded=await fetchArchiveAudio(personal.archiveId,personal.archiveFile,{} as never,{publicAudio:true});
  assert.equal(loaded.title,'white rabbit');assert.equal(loaded.attribution.creator,'');
  assert.equal(loaded.attribution.itemCreator,'Jefferson Airplane');assert.equal(loaded.attribution.fileName,'1456.mp3');
  assert.equal(requested.at(-1),'/download/LostAndFound_929/1456.mp3');
  const album=await fetchArchiveAudio(compilation.archiveId,compilation.archiveFile,{} as never,{publicAudio:true});
  assert.equal(album.title,'white rabbit - Archive item: Under The Influence Of Alice');
  assert.equal(album.attribution.creator,'Jefferson Airplane');assert.equal(album.attribution.itemCreator,'Collection uploader');
});

test('public download options preserve remix licensing and exclude private audio files',async t=>{
  t.mock.method(globalThis,'fetch',async()=>metadata({},[file({private:'true'}),file({name:'visible.mp3'})]));
  const item=await fetchArchiveItem('good',{publicAudio:true});assert.deepEqual(item.tracks.map(track=>track.name),['visible.mp3']);
  await assert.rejects(()=>fetchArchiveAudio('good','visible.mp3',{} as never,{publicAudio:true,remix:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='license_missing');
});

test('failed searches log only response diagnostics and preserve upstream retryability',async t=>{
  const events:unknown[][]=[];
  t.mock.method(console,'warn',(...values:unknown[])=>events.push(values));
  t.mock.method(globalThis,'fetch',async()=>new Response('upstream body must stay private',{status:503,headers:{'content-type':'text/html'}}));
  await assert.rejects(()=>searchArchiveSongs('private search retry fixture'),(error:unknown)=>error instanceof ArchiveError&&error.code==='archive_busy'&&error.retryable);
  assert.equal(events.length,3);
  for(const [name,details] of events){assert.equal(name,'archive_fetch_diagnostic');assert.deepEqual(details,{stage:'search',reason:'upstream_busy',status:503,contentType:'text/html'});}
  assert.doesNotMatch(JSON.stringify(events),/private|fixture|upstream body|https:/);
  events.length=0;
  t.mock.method(globalThis,'fetch',async()=>new Response('another private body',{headers:{'content-type':'text/plain'}}));
  await assert.rejects(()=>searchArchiveSongs('private search content type fixture'),(error:unknown)=>error instanceof ArchiveError&&!error.retryable);
  for(const [,details] of events)assert.deepEqual(details,{stage:'search',reason:'unexpected_content_type',status:200,contentType:'other'});
});

test('song-title queries prefer title matches while exact artist queries retain artist search',async t=>{
  const requests:URL[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      requests.push(url);
      return Response.json({response:{docs:[{identifier:'song',title:'white rabbit',creator:'Jefferson Airplane'},{identifier:'artist',title:'Moonlight',creator:'White Rabbit Project'},{identifier:'alternate',title:'white rabbit'}]}});
    }
    if(url.pathname==='/metadata/song')return metadata({title:'white rabbit',creator:'Jefferson Airplane'},[file({title:'white rabbit'})]);
    if(url.pathname==='/metadata/artist')return metadata({title:'Moonlight',creator:'White Rabbit Project'},[file({title:'Moonlight'})]);
    if(url.pathname==='/metadata/alternate')return metadata({title:'white rabbit',description:'December 17, 2015 cover version of the Jefferson Airplane song'},[file({title:'white rabbit'})]);
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  const titleSearch=await searchArchiveSongs('white rabbit');
  assert.deepEqual(titleSearch.results.map(song=>song.archiveId),['song']);
  assert.match(requests[0].searchParams.get('q')!,/title:"white" OR creator:"white"/);
  assert.match(requests[2].searchParams.get('q')!,/title:"white" AND title:"rabbit"/);
  assert.equal(requests[2].searchParams.get('sort[]'),'downloads desc');
  const artistSearch=await searchArchiveSongs('White Rabbit Project');
  assert.deepEqual(artistSearch.results.map(song=>song.archiveId),['artist']);
});

test('a catalog request that exhausts its first attempt still has time for a bounded retry',async t=>{
  let now=0;const attempts=new Map<string,number>();
  t.mock.method(Date,'now',()=>now);
  t.mock.method(console,'error',()=>{});
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      const count=(attempts.get(url.search)||0)+1;attempts.set(url.search,count);
      if(count===1){await Promise.resolve();now=10001;throw new DOMException('Fixture request timed out','TimeoutError');}
      return Response.json({response:{docs:[{identifier:'slow-catalog',title:'timed catalog recovery'}]}});
    }
    if(url.pathname.startsWith('/metadata/'))return metadata({title:'timed catalog recovery'},[file({title:'timed catalog recovery'})]);
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  const result=await searchArchiveSongs('timed catalog recovery');
  assert.equal(result.results[0]?.archiveId,'slow-catalog');
  assert.deepEqual([...attempts.values()],[2,2,2]);
});
