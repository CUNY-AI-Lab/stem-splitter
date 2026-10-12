import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ArchiveError, fetchArchiveAudio, fetchArchiveItem, searchArchiveSongs, validateArchiveSongFrames } from '../src/archive.ts';
import { mp3FrameInfo } from '../src/reliability/media.ts';
const audio=new Uint8Array(readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url)));
const duration=mp3FrameInfo(audio.buffer)!.seconds;
const file=(extra:Record<string,unknown>={})=>({name:'song.mp3',title:'Song fixture',size:String(audio.length),length:String(duration),...extra});
const metadata=(extra:Record<string,unknown>={},files=[file()])=>Response.json({metadata:{title:'Song fixture',creator:'Fixture Musician',mediatype:'audio',subject:'Music',...extra},files});

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
  const result=await searchArchiveSongs('Fixture Musician Song fixture');
  assert.equal(result.results.length,1);assert.equal(result.results[0].archiveId,'good');
  assert.equal(result.results[0].archiveFile,'song.mp3');assert.equal(result.results[0].artist,'');
  assert.equal(result.results[0].itemCreator,'Fixture Musician');
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
  assert.equal(loaded.attribution.creator,'');assert.equal(loaded.attribution.itemCreator,'Fixture Musician');assert.equal(loaded.attribution.licenseUrl,'');
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
  assert.equal(results.length,3);
  assert.equal(results.some(song=>song.archiveId==='LostAndFound_929'),false);
  const compilation=results.find(song=>song.archiveId==='compilation')!;
  assert.equal(compilation.artist,'Jefferson Airplane');assert.equal(compilation.itemCreator,'Collection uploader');
  assert.equal(compilation.itemTitle,'Under The Influence Of Alice');
  assert.equal(results.find(song=>song.archiveId==='concert')?.itemTitle,'Live at the Fillmore');
  assert.equal(results.find(song=>song.archiveId==='file_credit')?.artist,'');
  assert.equal(results.find(song=>song.archiveId==='file_credit')?.fileCreator,'Jefferson Airplane');
  assert.equal(results.find(song=>song.archiveId==='file_credit')?.itemDescription,'');
  await assert.rejects(()=>fetchArchiveAudio('LostAndFound_929','1456.mp3',{} as never,{publicAudio:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='no_audio_files');
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

test('song index requires affirmative music metadata and per-file duration of at most five minutes',async t=>{
  const records:Record<string,Response>={
    boundary:metadata({title:'Boundary melody'},[file({name:'exact-track.mp3',title:'Boundary melody',length:'300'})]),
    over:metadata({title:'Boundary melody'},[file({length:'300.01',title:'Boundary melody'})]),
    unknown:metadata({title:'Boundary melody',runtime:'2:00'},[file({length:undefined,title:'Boundary melody'})]),
    speech:metadata({title:'Boundary melody',subject:['Music','Interview'],description:'A podcast about jazz'},[file({title:'Boundary melody'})]),
    collection:metadata({title:'Boundary melody',mediatype:'collection'},[file({title:'Boundary melody'})]),
    album:metadata({title:'Boundary melody'},[file({title:'Boundary melody Full Album'})]),
    unclassified:metadata({title:'Boundary melody',subject:'',collection:'opensource_audio'},[file({title:'Boundary melody'})]),
  };
  const downloads:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:Object.keys(records).map(identifier=>({identifier}))}});
    if(url.pathname.startsWith('/metadata/'))return records[url.pathname.split('/')[2]].clone();
    downloads.push(decodeURIComponent(url.pathname));
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  const {results}=await searchArchiveSongs('Boundary melody');
  assert.deepEqual(results.map(song=>[song.archiveId,song.archiveFile,song.durationSec]),[['boundary','exact-track.mp3',300]]);
  assert.deepEqual(downloads,['/download/boundary/exact-track.mp3']);
  records.boundary=metadata({},[file({name:'exact-track.mp3',length:'301'})]);
  await assert.rejects(()=>fetchArchiveAudio('boundary','exact-track.mp3',{} as never,{publicAudio:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='track_too_long');
  records.boundary=metadata({subject:['Music','Spoken word']},[file({name:'exact-track.mp3'})]);
  await assert.rejects(()=>fetchArchiveAudio('boundary','exact-track.mp3',{} as never,{publicAudio:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='no_audio_files');
  assert.equal(downloads.length,1,'fresh import metadata is checked before any complete download');
});

test('duration uses complete finite file values and never falls back to item runtime',async t=>{
  const lengths:[unknown,boolean][]=[['300',true],['05:00',true],['0:05:00',true],['300.01',false],['301',false],
    [undefined,false],['',false],['0',false],['-1',false],['Infinity',false],['NaN',false],['120junk',false],['2:60',false],['1:00:00:00',false]];
  let length:unknown;
  t.mock.method(globalThis,'fetch',async()=>metadata({runtime:'180'},[file({length})]));
  for(const [value,importable] of lengths){length=value;const item=await fetchArchiveItem('duration-case',{publicAudio:true});
    assert.equal(item.tracks[0].importable,importable,String(value));}
});

test('music collections, genre tags and album track credits qualify while speech and whole-recording files stay excluded',async t=>{
  const cases:[Record<string,unknown>,Record<string,unknown>,boolean][]=[
    [{subject:'',collection:'audio_music'},{},false],
    [{subject:'',collection:'78rpm'},{title:'The White Easter Rabbit Part 1'},false],
    [{subject:'',collection:'opensource_audio'},{genre:'Alt Rock'},true],
    [{subject:''},{album:'A real album',artist:'Musician',track:'01'},true],
    [{subject:''},{album:'Album',artist:'Artist',track:'01'},false],
    [{subject:'Music',collection:'librivoxaudio'},{},false],
    [{subject:['Music','News']},{},false],
    [{subject:'Music'},{title:'Artist Interview'},true],
    [{subject:'Music'},{title:'Spoken Introduction',comment:'Spoken introduction and stage announcements'},false],
    [{subject:'Music'},{title:'Full Concert'},false],
    [{subject:'Music'},{title:'Collection'},false],
    [{subject:'Music',title:'Full Album'},{title:'Individual song'},true],
  ];
  let current=cases[0];
  t.mock.method(globalThis,'fetch',async()=>metadata(current[0],[file(current[1])]));
  for(const scenario of cases){current=scenario;
    if(scenario[2])assert.equal((await fetchArchiveItem('music-case',{publicAudio:true})).tracks[0].importable,true);
    else await assert.rejects(()=>fetchArchiveItem('music-case',{publicAudio:true}),(error:unknown)=>error instanceof ArchiveError&&error.code==='no_audio_files');
  }
});

test('complete audio duration also enforces five minutes when file metadata rounds down',async t=>{
  const frameLength=417,frameCount=Math.ceil(300*44100/1152),bytes=new Uint8Array(frameCount*frameLength);
  for(let offset=0;offset<bytes.length;offset+=frameLength)bytes.set([0xff,0xfb,0x90,0xc0],offset);
  assert.ok(mp3FrameInfo(bytes.buffer)!.seconds>300);
  assert.throws(()=>validateArchiveSongFrames(bytes.buffer,300),(error:unknown)=>error instanceof ArchiveError&&error.code==='track_too_long');
  const shorter=bytes.slice(0,-frameLength);validateArchiveSongFrames(shorter.buffer,300);
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>String(input).includes('/metadata/')
    ? metadata({},[file({size:String(bytes.length),length:'300'})])
    : new Response(bytes,{headers:{'content-type':'audio/mpeg'}}));
  await assert.rejects(()=>fetchArchiveAudio('rounded-song','song.mp3',{} as never,{publicAudio:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='track_too_long');
});

test('cover exclusions inspect complete metadata arrays and apply even when the query requests covers',async t=>{
  const records:Record<string,Response>={
    original:metadata({title:'Original melody'},[file({title:'Original melody'})]),
    cover:metadata({title:'Original melody cover',description:'A cover version of another song'},[file({title:'Original melody cover'})]),
    late:metadata({title:'Original melody',description:['Album notes '.repeat(2000),'A cover of the original recording']},[file({title:'Original melody'})]),
    rendition:metadata({title:'Original melody',description:'Originally recorded by another performer'},[file({title:'Original melody'})]),
    file_note:metadata({title:'Original melody'},[file({title:'Original melody',comment:'My cover version'})]),
    encoded:metadata({title:'Original melody',description:'<p>A cover&nbsp;version of another recording</p>'},[file({title:'Original melody'})]),
    numeric:metadata({title:'Original melody',description:'<p>A cover&#32;version of another recording</p>'},[file({title:'Original melody'})]),
    speech_array:metadata({title:'Original melody',subject:['Music','Background '.repeat(2000),'Spoken word']},[file({title:'Original melody'})]),
  };
  const downloads:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:Object.keys(records).map(identifier=>({identifier}))}});
    if(url.pathname.startsWith('/metadata/'))return records[url.pathname.split('/')[2]].clone();
    downloads.push(url.pathname);
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  assert.deepEqual((await searchArchiveSongs('Original melody')).results.map(song=>song.archiveId),['original']);
  assert.deepEqual((await searchArchiveSongs('Original melody cover')).results,[]);
  for(const id of ['cover','late','rendition','file_note','speech_array','encoded','numeric'])await assert.rejects(
    ()=>fetchArchiveAudio(id,'song.mp3',{} as never,{publicAudio:true}),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='no_audio_files');
  assert.deepEqual(downloads,['/download/original/song.mp3']);
});

test('contextual filtering retains song titles, artists, instrumentals and remixes with music evidence',async t=>{
  const titles=['Cover Me','Cover','Tribute','Original Instrumental','Interview','Speech','Original melody (Remix)'];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'real-songs'}]}});
    if(url.pathname.startsWith('/metadata/'))return metadata({creator:'Cover Drive',subject:'Rock'},titles.map((title,index)=>file({name:`${index}.mp3`,title,artist:'Cover Drive'})));
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  const {results}=await searchArchiveSongs('Cover Drive');
  assert.deepEqual(results.map(song=>song.title).sort(),titles.sort());
});

test('direct licensed Archive imports retain content checks when the search marker is absent',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return metadata({licenseurl:'https://creativecommons.org/licenses/by/4.0/',subject:['Music','Speech'],description:'A podcast and cover version'});});
  await assert.rejects(()=>fetchArchiveAudio('direct-song','song.mp3',{} as never),
    (error:unknown)=>error instanceof ArchiveError&&error.code==='no_audio_files');
  assert.equal(calls,1);
});

test('artist-qualified discovery retains credited songs among many filenames containing the whole query',async t=>{
  const uncredited=Array.from({length:16},(_,index)=>({identifier:`uncredited-${index}`,title:'Signal Orchestra Midnight Motion'}));
  let catalogs=0,inspected=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      catalogs++;assert.equal(url.searchParams.get('rows'),'16');
      assert.equal(url.searchParams.get('sort[]'),'downloads desc');
      const docs=url.searchParams.get('q')?.includes('creator:[* TO *]')
        ? [{identifier:'credited',title:'Midnight Motion',creator:'Signal Orchestra'}] : uncredited;
      return Response.json({response:{docs}});
    }
    if(url.pathname.startsWith('/metadata/')){inspected++;return url.pathname.endsWith('/credited')
      ? metadata({title:'Midnight Motion',creator:'Signal Orchestra'},[file({title:'Midnight Motion',artist:'Signal Orchestra'})])
      : metadata({creator:''},[file({title:'Signal Orchestra Midnight Motion'})]);}
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  assert.deepEqual((await searchArchiveSongs('Signal Orchestra Midnight Motion')).results.map(song=>song.archiveId),['credited']);
  assert.equal(catalogs,3);assert.equal(inspected,16);
});

test('temporary delivery failures retry with the same byte range and never cache a false empty result',async t=>{
  let available=false,probes=0,searches=0;
  t.mock.method(console,'warn',()=>{});
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){searches++;return Response.json({response:{docs:[{identifier:'delivery-recovery'}]}});}
    if(url.pathname.startsWith('/metadata/'))return metadata({title:'Delivery recovery melody'},[file({title:'Delivery recovery melody'})]);
    probes++;assert.equal(new Headers(init?.headers).get('range'),'bytes=0-65535');
    if(!available || probes===4)return new Response('upstream busy',{status:503});
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  await assert.rejects(()=>searchArchiveSongs('Delivery recovery melody'),(error:unknown)=>error instanceof ArchiveError&&error.retryable);
  assert.equal(probes,3);available=true;
  const recovered=await searchArchiveSongs('Delivery recovery melody');
  assert.equal(recovered.results[0]?.archiveId,'delivery-recovery');assert.equal(probes,5);assert.equal(searches,6);
});
