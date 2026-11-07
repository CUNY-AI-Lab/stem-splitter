import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ArchiveError, creditMatchesQuery, genreQuery, fetchArchiveAudio, fetchArchiveItem, hiddenFromGenreLists, searchArchiveSongs, validateArchiveSongFrames, verifyArchiveSampleFile } from '../src/archive.ts';
import { HATE_MUSIC_NAMES, HATE_MUSIC_TAGS, SLURS } from '../src/genre-list-exclusions.ts';
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
  assert.equal(events.length,4);
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
  assert.deepEqual([...attempts.values()],[2,2,2,2]);
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
      catalogs++;assert.equal(url.searchParams.get('rows'),url.searchParams.get('q')?.includes(' OR creator:')?'32':'16');
      assert.equal(url.searchParams.get('sort[]'),'downloads desc');
      const docs=url.searchParams.get('q')?.includes(' OR creator:')
        ? [{identifier:'credited',title:'Midnight Motion',creator:'Signal Orchestra'}] : uncredited;
      return Response.json({response:{docs}});
    }
    if(url.pathname.startsWith('/metadata/')){inspected++;return url.pathname.endsWith('/credited')
      ? metadata({title:'Midnight Motion',creator:'Signal Orchestra'},[file({title:'Midnight Motion',artist:'Signal Orchestra'})])
      : metadata({creator:''},[file({title:'Signal Orchestra Midnight Motion'})]);}
    return new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
  });
  assert.deepEqual((await searchArchiveSongs('Signal Orchestra Midnight Motion')).results.map(song=>song.archiveId),['credited']);
  assert.equal(catalogs,4);assert.ok(inspected<=40);
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
  assert.equal(recovered.results[0]?.archiveId,'delivery-recovery');assert.equal(probes,5);assert.equal(searches,8);
});

test('verified duration limits partition search caches and apply at metadata and audio boundaries',async t=>{
  let seconds=900;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'student-boundary',title:'Extended classroom melody',creator:'Fixture Musician'}]}});
    if(url.pathname.startsWith('/metadata/'))return metadata({},[file({title:'Extended classroom melody',length:String(seconds)})]);
    return new Response(audio,{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${audio.length-1}/${audio.length}`}});
  });
  const student=await searchArchiveSongs('Extended classroom melody',undefined,900);
  assert.equal(student.results.length,1);
  assert.equal((await searchArchiveSongs('Extended classroom melody',undefined,300)).results.length,0,'a guest must not inherit the student cache');
  assert.equal((await searchArchiveSongs('Extended classroom melody',undefined,900)).results.length,1);
  for(const maximumSeconds of [300,900])for(const delta of [0,0.01]){
    seconds=maximumSeconds+delta;
    const item=await fetchArchiveItem('student-boundary',{publicAudio:true,maximumSeconds});
    assert.equal(item.tracks[0].importable,delta===0,`${maximumSeconds}s limit, ${seconds}s track`);
    if(delta)await assert.rejects(()=>fetchArchiveAudio('student-boundary','song.mp3',{} as never,{publicAudio:true,maximumSeconds}),e=>e instanceof ArchiveError&&e.code==='track_too_long');
    const frames=Math.floor(maximumSeconds*44100/1152)+(delta?1:0);
    const bytes=new Uint8Array(frames*417);
    for(let offset=0;offset<bytes.length;offset+=417)bytes.set([0xff,0xfb,0x90,0x64],offset);
    if(delta)assert.throws(()=>validateArchiveSongFrames(bytes.buffer,maximumSeconds,maximumSeconds),e=>e instanceof ArchiveError&&e.code==='track_too_long');
    else assert.doesNotThrow(()=>validateArchiveSongFrames(bytes.buffer,maximumSeconds,maximumSeconds));
  }
});

const partialAudio=()=>new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});

test('a bare artist name finds the band instead of books that share the word',async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      const q=url.searchParams.get('q')!;queries.push(q);
      return Response.json({response:{docs:q.includes('creator:"regina"')
        ?[{identifier:'band',title:'Greatest Hits',creator:'Regina'},{identifier:'shared',title:'Film score',creator:'Michael Kamen, Regina'},{identifier:'other',title:'Songs',creator:'Regina Spektor'}]
        :[{identifier:'book',title:'Regina of Scots',creator:'Jacob Abbott'}]}});
    }
    if(url.pathname==='/metadata/band')return metadata({title:'Greatest Hits',creator:'Regina'},[file({title:'Radio Song'})]);
    if(url.pathname==='/metadata/shared')return metadata({title:'Film score',creator:'Michael Kamen, Regina'},[file({title:'Princes'})]);
    if(url.pathname==='/metadata/other')return metadata({title:'Songs',creator:'Regina Spektor'},[file({title:'Samson'})]);
    if(url.pathname==='/metadata/book')return metadata({title:'Regina of Scots',creator:'Jacob Abbott',subject:'Librivox'},[file({title:'Regina of Scots part one'})]);
    return partialAudio();
  });
  const found=await searchArchiveSongs('regina');
  assert.deepEqual(found.results.map(song=>song.archiveId).sort(),['band','shared']);
  assert.equal(queries.length,4);
  assert.ok(queries.every(q=>q.includes('NOT collection:(librivoxaudio OR audio_bookspoetry)')),'spoken-word collections stay out of every query');
  assert.ok(queries.includes(queries.find(q=>q.endsWith('creator:"regina"'))!),'the whole name is searched as one credit');
});

test('a named artist outranks a title that merely contains the word, and file credits still win',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'mirror-word',title:'Mirrors song',creator:'Solo Player'},{identifier:'mirror-artist',title:'Album',creator:'The Mirrors'},{identifier:'mirror-compilation',title:'Sampler',creator:'Mirrors'}]}});
    if(url.pathname==='/metadata/mirror-word')return metadata({title:'Mirrors song',creator:'Solo Player'},[file({title:'Mirrors song'})]);
    if(url.pathname==='/metadata/mirror-artist')return metadata({title:'Album',creator:'The Mirrors'},[file({title:'First Light'})]);
    if(url.pathname==='/metadata/mirror-compilation')return metadata({title:'Sampler',creator:'Mirrors'},[file({title:'Guest Track',artist:'Someone Else'})]);
    return partialAudio();
  });
  assert.deepEqual((await searchArchiveSongs('mirrors')).results.map(song=>song.archiveId),['mirror-artist','mirror-word']);
});

test('credit matching handles articles and shared credits without partial names',()=>{
  assert.ok(creditMatchesQuery('The Beatles','beatles'));
  assert.ok(creditMatchesQuery('Beatles','the beatles'));
  assert.ok(creditMatchesQuery('Michael Kamen, Queen','queen'));
  assert.ok(creditMatchesQuery('Simon and Garfunkel','simon and garfunkel'));
  assert.ok(creditMatchesQuery('Bob Dylan feat. The Band','the band'));
  assert.ok(!creditMatchesQuery('Ellery Queen','queen'));
  assert.ok(!creditMatchesQuery('Queen Latifah','queen'));
  assert.ok(!creditMatchesQuery('','queen'));
});

test('search titles are readable when files carry encoded names or folder paths',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'paths',title:'Loose',creator:'Tidy Band'}]}});
    if(url.pathname==='/metadata/paths')return metadata({title:'Loose',creator:'Tidy Band'},[
      file({name:'Loose/Disc 1/04 Downer.mp3',title:'Loose/Disc 1/04 Downer'}),
      file({name:'1976-03-31 Show/Disc.1/02-Sweet Lady.mp3',title:'03-31 Show/Disc.1/02-Sweet Lady'}),
      file({name:'Tidy%20Song.mp3',title:'Tidy%20Song'}),
      file({name:'other.mp3',title:'AC/DC Tribute'}),
    ]);
    return partialAudio();
  });
  const titles=(await searchArchiveSongs('tidy band')).results.map(song=>song.title).sort();
  assert.deepEqual(titles,['02-Sweet Lady','04 Downer','AC/DC Tribute','Tidy Song']);
});

test('genres count at either end of a search and never inside a song title',()=>{
  const parse=(query:string)=>{const genre=genreQuery(query.split(' '));return genre&&[genre.label,genre.rest.join(' ')];};
  assert.deepEqual(parse('jazz'),['Jazz','']);
  assert.deepEqual(parse('the blues'),['Blues','']);
  assert.deepEqual(parse('jazz music'),['Jazz','']);
  assert.deepEqual(parse('hip hop'),['Hip hop','']);
  assert.deepEqual(parse('queen rock'),['Rock','queen']);
  assert.deepEqual(parse('rock queen'),['Rock','queen']);
  assert.deepEqual(parse('rhythm and blues'),['R&B','']);
  assert.equal(parse('we will rock you'),null);
  assert.equal(parse('queen'),null);
  assert.equal(parse('rocket man'),null);
});

test('a genre search finds tagged music with no genre word in its title or credit',async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      const q=url.searchParams.get('q')!;queries.push(q);
      return Response.json({response:{docs:q.includes('subject:("bluegrass")')?[{identifier:'genre-tagged',title:'Mountain Hours',creator:'Fiddle Trio'},{identifier:'genre-untagged',title:'Valley Hours',creator:'Other Trio'}]:[]}});
    }
    if(url.pathname==='/metadata/genre-tagged')return metadata({title:'Mountain Hours',creator:'Fiddle Trio',subject:['Music','Bluegrass; acoustic']},[file({title:'Sunrise Reel'})]);
    if(url.pathname==='/metadata/genre-untagged')return metadata({title:'Valley Hours',creator:'Other Trio',subject:'Music'},[file({title:'Evening Reel'})]);
    return partialAudio();
  });
  const found=await searchArchiveSongs('bluegrass');
  assert.deepEqual(found.results.map(song=>song.archiveId),['genre-tagged']);
  assert.equal(found.results[0].genre,'Bluegrass');
  assert.equal(queries.length,5);
});

test('an artist with a genre keeps the artist and uses the genre to choose among their work',async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      const q=url.searchParams.get('q')!;queries.push(q);
      return Response.json({response:{docs:[{identifier:'pair-match',title:'Studio',creator:'Lantern'},{identifier:'pair-other',title:'Studio Two',creator:'Lantern'},{identifier:'pair-stranger',title:'Elsewhere',creator:'Someone'}]}});
    }
    if(url.pathname==='/metadata/pair-match')return metadata({title:'Studio',creator:'Lantern',subject:'Music; disco'},[file({title:'Night Lights'})]);
    if(url.pathname==='/metadata/pair-other')return metadata({title:'Studio Two',creator:'Lantern',subject:'Music; folk'},[file({title:'Day Lights'})]);
    if(url.pathname==='/metadata/pair-stranger')return metadata({title:'Elsewhere',creator:'Someone',subject:'Music; disco'},[file({title:'Far Away'})]);
    return partialAudio();
  });
  assert.deepEqual((await searchArchiveSongs('lantern disco')).results.map(song=>song.archiveId),['pair-match']);
  assert.ok(queries.some(q=>q.includes('subject:("disco") AND (title:"lantern" OR creator:"lantern")')));
});

test('a song title containing a genre word adds no genre catalog request',async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){queries.push(url.searchParams.get('q')!);return Response.json({response:{docs:[]}});}
    return partialAudio();
  });
  await searchArchiveSongs('we will rock you');
  assert.equal(queries.length,4);
  assert.ok(queries.every(q=>!q.includes('subject:("rock")')));
});

test('the word query avoids the slow creator range and still prefers credited items',async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){queries.push(url.searchParams.get('q')!);return Response.json({response:{docs:[]}});}
    return partialAudio();
  });
  await searchArchiveSongs('range speed check');
  assert.ok(queries.length>0&&queries.every(q=>!q.includes('[* TO *]')),'a fresh creator range costs seconds on the Archive');
});

test('a stalled source cannot hold a search past its budget once enough results are verified',async t=>{
  const release:(()=>void)[]=[];
  t.after(()=>release.forEach(done=>done()));
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      if(url.searchParams.get('q')!.includes(' OR creator:'))await new Promise<void>(done=>release.push(done));
      return Response.json({response:{docs:[{identifier:'budget-song-a',title:'Budget melody',creator:'Budget Band'},{identifier:'budget-song-b',title:'Budget melody two',creator:'Budget Band'}]}});
    }
    if(url.pathname.startsWith('/metadata/budget-song'))return metadata({title:'Budget melody',creator:'Budget Band'},[file({name:'one.mp3',title:'Budget melody one'}),file({name:'two.mp3',title:'Budget melody two'})]);
    return partialAudio();
  });
  const started=Date.now();
  const found=await searchArchiveSongs('budget melody');
  assert.equal(found.results.length,4);
  assert.ok(Date.now()-started<6500,`took ${Date.now()-started}ms`);
});

test('a thin result list waits for the second limit, and abandoned work leaves the shared queue',async t=>{
  const release:(()=>void)[]=[];let probesAfterExpiry=0,expired=false;
  t.after(()=>release.forEach(done=>done()));
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      if(url.searchParams.get('q')!.includes(' OR creator:'))await new Promise<void>(done=>release.push(done));
      return Response.json({response:{docs:[{identifier:'thin-song',title:'Thin melody',creator:'Thin Band'}]}});
    }
    if(url.pathname==='/metadata/thin-song')return metadata({title:'Thin melody',creator:'Thin Band'},[file({title:'Thin melody'})]);
    if(expired)probesAfterExpiry++;
    return partialAudio();
  });
  const started=Date.now();
  const found=await searchArchiveSongs('thin melody');
  expired=true;
  const elapsed=Date.now()-started;
  assert.equal(found.results.length,1);
  assert.ok(elapsed>=7500&&elapsed<9000,`took ${elapsed}ms`);
  release.forEach(done=>done());
  await new Promise(done=>setTimeout(done,50));
  assert.equal(probesAfterExpiry,0);
});

test('a search with nothing verified gives up and reports the source as busy',async t=>{
  const release:(()=>void)[]=[];
  t.after(()=>release.forEach(done=>done()));
  t.mock.method(globalThis,'fetch',async()=>{await new Promise<void>(done=>release.push(done));return Response.json({response:{docs:[]}});});
  const started=Date.now();
  await assert.rejects(()=>searchArchiveSongs('stalled completely'),(error:unknown)=>error instanceof ArchiveError&&error.code==='archive_busy'&&error.retryable);
  assert.ok(Date.now()-started<9500,`took ${Date.now()-started}ms`);
});

test('at the time limit, matches still being checked are listed instead of an empty result',async t=>{
  const release:(()=>void)[]=[];
  t.after(()=>release.forEach(done=>done()));
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'slow-check-song',title:'Slowcheck melody',creator:'Slowcheck Band'}]}});
    if(url.pathname==='/metadata/slow-check-song')return metadata({title:'Slowcheck melody',creator:'Slowcheck Band'},[file({title:'Slowcheck melody'})]);
    await new Promise<void>(done=>release.push(done));
    return partialAudio();
  });
  const started=Date.now();
  const found=await searchArchiveSongs('slowcheck melody');
  assert.deepEqual(found.results.map(song=>song.archiveId),['slow-check-song']);
  assert.ok(Date.now()-started<9000,`took ${Date.now()-started}ms`);
});

test('work orphaned by an ended request does not block a later search',async t=>{
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  let orphan=true;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'orphan-song',title:'Orphan melody',creator:'Orphan Band'}]}});
    if(url.pathname==='/metadata/orphan-song'){
      if(orphan){orphan=false;return new Promise<Response>(()=>{});}
      return metadata({title:'Orphan melody',creator:'Orphan Band'},[file({title:'Orphan melody'})]);
    }
    return partialAudio();
  });
  await assert.rejects(()=>searchArchiveSongs('orphan melody'));
  now+=13000;
  const found=await searchArchiveSongs('orphan melody');
  assert.deepEqual(found.results.map(song=>song.archiveId),['orphan-song']);
});

const genreOnlySearch=(t:{mock:{method:(...args:never[])=>unknown}},catalog:string[],uploader:string[],records:Record<string,Response>)=>{
  (t.mock.method as (...args:unknown[])=>unknown)(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      const q=url.searchParams.get('q')!;
      const ids=q.includes('subject:("jazz")')?catalog:q.endsWith('creator:"jazz"')?uploader:[];
      return Response.json({response:{docs:ids.map((identifier,index)=>({identifier,title:identifier,creator:'Credited',downloads:1000-index}))}});
    }
    if(url.pathname.startsWith('/metadata/'))return records[url.pathname.split('/')[2]].clone();
    return partialAudio();
  });
};

test('two-word genres read as one genre, so neither word is taken for an artist',()=>{
  const parse=(query:string)=>{const genre=genreQuery(query.split(' '));return genre&&[genre.label,genre.rest.join(' ')];};
  assert.deepEqual(parse('punk rock'),['Punk','']);
  assert.deepEqual(parse('hard rock'),['Hard rock','']);
  assert.deepEqual(parse('smooth jazz'),['Smooth jazz','']);
  assert.deepEqual(parse('bossa nova'),['Bossa nova','']);
  assert.deepEqual(parse('queen rock'),['Rock','queen']);
  assert.deepEqual(parse('miles davis jazz'),['Jazz','miles davis']);
});

test('a genre search ranks tags, then titles naming the genre, then downloads, and never an uploader named after the genre',async t=>{
  genreOnlySearch(t as never,['popular','quieter','named'],['uploader'],{
    popular:metadata({title:'Standards',creator:'Ella Group',subject:'Jazz'},[file({title:'All Of You'})]),
    quieter:metadata({title:'Later',creator:'Quiet Trio',subject:'Jazz'},[file({title:'Night Train'})]),
    named:metadata({title:'Rare',creator:'Rare Trio',subject:'Jazz'},[file({title:'Jazz Hands'})]),
    uploader:metadata({title:'Uploads',creator:'Jazz',subject:'Music'},[file({title:'Elevator Noise'})]),
  });
  assert.deepEqual((await searchArchiveSongs('jazz')).results.map(song=>song.archiveId),['named','popular','quieter','uploader']);
});

test('a genre search gives each artist two places unless the list would otherwise be short',async t=>{
  genreOnlySearch(t as never,['prolific','second','third'],[],{
    prolific:metadata({title:'Box set',creator:'Prolific Band',subject:'Jazz'},['One','Two','Three','Four'].map(title=>file({name:`${title}.mp3`,title}))),
    second:metadata({title:'Album',creator:'Second Band',subject:'Jazz'},[file({title:'Fifth'})]),
    third:metadata({title:'Album',creator:'Third Band',subject:'Jazz'},[file({title:'Sixth'})]),
  });
  const listed=(await searchArchiveSongs('jazz music')).results.map(song=>song.itemCreator);
  assert.deepEqual(listed,['Prolific Band','Prolific Band','Second Band','Third Band','Prolific Band','Prolific Band']);
});

test('a genre search gives one upload two places though its tracks credit different artists',async t=>{
  genreOnlySearch(t as never,['many-composers','fourth-album'],[],{
    'many-composers':metadata({title:'Game themes',creator:'Uploader',subject:'Jazz'},['One','Two','Three'].map(title=>file({name:`${title}.mp3`,title,artist:`${title} Composer`}))),
    'fourth-album':metadata({title:'Album',creator:'Band',subject:'Jazz'},[file({title:'Fourth'})]),
  });
  const listed=(await searchArchiveSongs('jazz songs')).results.map(song=>song.title);
  assert.deepEqual(listed,['One','Three','Fourth','Two']);
});

test('a genre word lost among dozens of keywords is not a genre tag',async t=>{
  const keywords=Array.from({length:60},(_,index)=>`keyword${index}`);
  genreOnlySearch(t as never,['stuffed','stuffed-list','plain'],[],{
    stuffed:metadata({title:'Readings',creator:'Reader',subject:[...keywords,'jazz']},[file({title:'Reading one'})]),
    'stuffed-list':metadata({title:'Readings',creator:'Reader',subject:`${keywords.join(', ')}, jazz`},[file({title:'Reading two'})]),
    plain:metadata({title:'Album',creator:'Trio',subject:'prewar;jazz;guitar'},[file({title:'Night Train'})]),
  });
  assert.deepEqual((await searchArchiveSongs('jazz tracks')).results.map(song=>song.archiveId),['plain']);
});

test('a genre list leaves out a flagged upload from every batch, and naming it still finds it',async t=>{
  const [slur]=SLURS,[band]=HATE_MUSIC_NAMES,[tag]=HATE_MUSIC_TAGS;
  const records:Record<string,Response>={
    'hidden-slur-album':metadata({title:'Porch Songs',creator:'Porch Singer',subject:'gospel'},[file({name:'a.mp3',title:`${slur} song`}),file({name:'b.mp3',title:'Kind Song'})]),
    'hidden-band-album':metadata({title:'Marching',creator:band,subject:'gospel'},[file({title:'Band Song'})]),
    'hidden-file-credit':metadata({title:'Sampler',creator:'Compiler',subject:'gospel'},[file({name:'c.mp3',title:'Sampler Song',artist:band}),file({name:'d.mp3',title:'Fair Song',artist:'Fair Singer'})]),
    'hidden-tagged':metadata({title:'Anthems',creator:'Tagged Band',subject:`gospel; German ${tag}`},[file({title:'Tagged Song'})]),
    'hidden-stuffed':metadata({title:'Stuffed',creator:'Stuffed Band',subject:[...Array.from({length:60},(_,index)=>`keyword${index}`),tag]},[file({title:'Stuffed Song'})]),
    'hidden-plain':metadata({title:'Hymns',creator:'Choir',subject:'gospel'},[file({title:'Plain Song'})]),
  };
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:Object.keys(records).map(identifier=>({identifier,creator:'Credited'}))}});
    if(url.pathname.startsWith('/metadata/'))return records[url.pathname.split('/')[2]].clone();
    return partialAudio();
  });
  const seen:string[]=[];
  const {results}=await searchArchiveSongs('gospel',batch=>seen.push(...batch.results.map(song=>song.title)));
  assert.deepEqual(results.map(song=>song.title),['Plain Song']);
  assert.ok(seen.length&&seen.every(title=>title==='Plain Song'));
  assert.deepEqual((await searchArchiveSongs(band)).results.map(song=>song.title).sort(),['Band Song','Sampler Song']);
  assert.ok((await searchArchiveSongs(`${slur} song`)).results.some(song=>song.title===`${slur} song`));
});

test('only genre searches ask the catalog to leave out flagged uploads',async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    queries.push(new URL(String(input)).searchParams.get('q')!);
    return Response.json({response:{docs:[]}});
  });
  await searchArchiveSongs('bluegrass music');
  assert.ok(queries.length&&queries.every(q=>q.includes('NOT collection:(deemphasize OR fringe)')&&q.includes(`NOT creator:("${HATE_MUSIC_NAMES[0]}"`)));
  queries.length=0;
  await searchArchiveSongs('bluegrass harmony singers');
  await searchArchiveSongs(HATE_MUSIC_NAMES[0]);
  assert.ok(queries.length&&queries.every(q=>!q.includes('deemphasize')&&!q.includes('NOT creator:')));
});

test('exclusions match whole words and read tags apart from song names',()=>{
  for(const tag of HATE_MUSIC_TAGS)assert.ok(hiddenFromGenreLists('Any Song',`rock; ${tag.toLowerCase()}; live`),tag);
  for(const entry of [...HATE_MUSIC_NAMES,...SLURS]){
    assert.ok(hiddenFromGenreLists(`Best of ${entry.toUpperCase()} 1990`),entry);
    assert.ok(!entry.includes('"'),'an entry is quoted in the catalog query');
  }
  assert.ok(hiddenFromGenreLists('Die Lunikoff Verschwörung – Album'));
  // Music that only shares a word with the lists stays.
  for(const [text,tags] of [['Racing in the Street','racing; rock'],['In Stahlgewittern, read aloud','spoken'],['Ku Klux Klan Steel Pulse','reggae'],['White Power Station','rock'],
    ['No Remorse Metallica','metal'],['Funky Broadway Dyke and the Blazers','funk'],['Nazi Punks Fuck Off Dead Kennedys','punk']])assert.ok(!hiddenFromGenreLists(text,tags),text);
});

test('encodings of one file list once as the largest copy, though their lengths can disagree, and stay importable by name',async t=>{
  const sized=(size:number)=>{const body=new Uint8Array(size);body.set(audio);return new Response(body,{status:206,headers:{'content-type':'audio/mpeg','content-range':`bytes 0-${size-1}/${size}`}});};
  const small=audio.length,large=audio.length+1000;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'encodings',title:'Copies',creator:'Copy Band'}]}});
    if(url.pathname==='/metadata/encodings')return metadata({title:'Copies',creator:'Copy Band'},[
      {name:'Bossa_Nova_64kb.mp3',original:'Bossa_Nova.ogg',size:String(small),length:'170'},
      {name:'Bossa_Nova_vbr.mp3',original:'Bossa_Nova.ogg',size:String(large),length:'194'},
      {name:'Bossa_Nova.ogg',size:'400000',length:'199'},
    ] as never);
    return sized(decodeURIComponent(url.pathname).endsWith('_64kb.mp3')?small:large);
  });
  const {results}=await searchArchiveSongs('copy band');
  assert.deepEqual(results.map(song=>[song.title,song.archiveFile]),[['Bossa Nova','Bossa_Nova_vbr.mp3']]);
  assert.equal(Object.keys(results[0]).some(key=>/score|sourceKey|creditKey|labelKey/.test(key)),false);
  const direct=await verifyArchiveSampleFile('encodings','Bossa_Nova_64kb.mp3');
  assert.deepEqual(direct.results.map(song=>song.archiveFile),['Bossa_Nova_64kb.mp3']);
});

test('one upload repeating a track lists it once, while a different length and separate uploads stay',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'discography',title:'All albums',creator:'Repeat Band'},{identifier:'another-upload',title:'Other upload',creator:'Repeat Band'}]}});
    if(url.pathname==='/metadata/discography')return metadata({title:'All albums',creator:'Repeat Band'},[
      file({name:'Album A/7 Same.mp3',title:'Same',length:'153.80'}),
      file({name:'Album B/13 Same.mp3',title:'Same',length:'153.36'}),
      file({name:'Album C/2 Same.mp3',title:'Same',length:'180'}),
    ]);
    if(url.pathname==='/metadata/another-upload')return metadata({title:'Other upload',creator:'Repeat Band'},[file({name:'same.mp3',title:'Same',length:'153.80'})]);
    return partialAudio();
  });
  const {results}=await searchArchiveSongs('repeat band');
  assert.deepEqual(results.map(song=>[song.archiveId,Math.floor(song.durationSec)]).sort(),[['another-upload',153],['discography',153],['discography',180]]);
});

test('placeholder titles use the file name, or the item title when the item holds one recording',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'tagged-tmp',title:'Songbook',creator:'Tmp Band'},{identifier:'one-song',title:'country music is king',creator:'Tmp Band'}]}});
    if(url.pathname==='/metadata/tagged-tmp')return metadata({title:'Songbook',creator:'Tmp Band'},[
      file({name:'Songbook- All Of You.mp3',title:'tmp'}),file({name:'Songbook- Get Out Of Town.mp3',title:'tmp'}),
    ]);
    if(url.pathname==='/metadata/one-song')return metadata({title:'country music is king',creator:'Tmp Band'},[
      file({name:'song_1.mp3',original:'song_1.wav',title:'tmp'}),file({name:'song_1_64kb.mp3',original:'song_1.wav',title:'tmp'}),
    ]);
    return partialAudio();
  });
  const titles=(await searchArchiveSongs('tmp band')).results.map(song=>song.title).sort();
  assert.deepEqual(titles,['Songbook- All Of You','Songbook- Get Out Of Town','country music is king']);
});

test('titles spelled as file names read as titles, and real titles are left alone',async t=>{
  const names:Record<string,string>={
    'Johnny_Osbourne_-_Buddy_Bye_(reggae_classic)(128k)':'Johnny Osbourne - Buddy Bye (reggae classic)',
    'Irreplaceable(128k)':'Irreplaceable','Bossa_Nova_64kb':'Bossa Nova','Spider-Man_Theme_vbr':'Spider-Man Theme',
    "What's a Future Funk-279221631":"What's a Future Funk",'B-52':'B-52','Area 51':'Area 51','Song of 1999-2000':'Song of 1999-2000','Live 128':'Live 128',
  };
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'file-names',title:'Mixed',creator:'Neat Band'}]}});
    if(url.pathname==='/metadata/file-names')return metadata({title:'Mixed',creator:'Neat Band'},Object.keys(names).map((title,index)=>file({name:`track${index}.mp3`,title})));
    return partialAudio();
  });
  const {results}=await searchArchiveSongs('neat band');
  assert.equal(results.length,8);
  for(const song of results)assert.equal(song.title,names[Object.keys(names)[Number(song.archiveFile.match(/\d+/)![0])]]);
});

test('between equally good matches the most downloaded upload leads, and each upload takes two places first',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[
      {identifier:'cassette-tape',title:'Cassette tape',creator:'Loud Band',downloads:13438},
      {identifier:'real-album',title:'Real album',creator:'Loud Band',downloads:'52237'},
      {identifier:'word-match',title:'Loud Band tribute',creator:'Someone Else',downloads:900000},
    ]}});
    if(url.pathname==='/metadata/cassette-tape')return metadata({title:'Cassette tape',creator:'Loud Band'},['Sketch','Noise','Loop'].map(title=>file({name:`${title}.mp3`,title,artist:'Loud Band'})));
    if(url.pathname==='/metadata/real-album')return metadata({title:'Real album',creator:'Loud Band'},['Airbag','Lucky','Let Down'].map(title=>file({name:`${title}.mp3`,title})));
    if(url.pathname==='/metadata/word-match')return metadata({title:'Tribute',creator:'Someone Else'},[file({title:'Loud Band forever',artist:'Loud Band tribute players'})]);
    return partialAudio();
  });
  const listed=(await searchArchiveSongs('loud band')).results.map(song=>song.title);
  // The band's own tracks all outrank a looser match with far more downloads. Among them the real album leads.
  assert.deepEqual(listed,['Airbag','Lucky','Loop','Noise','Let Down','Sketch','Loud Band forever']);
});

test('downloads never lift a weaker match over a stronger one',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[
      {identifier:'named-rare',title:'Rare album',creator:'Pale Moon',downloads:3},
      {identifier:'loose-famous',title:'Pale Moon stories',creator:'Famous Narrator',downloads:5000000},
    ]}});
    if(url.pathname==='/metadata/named-rare')return metadata({title:'Rare album',creator:'Pale Moon'},[file({title:'First Song'})]);
    if(url.pathname==='/metadata/loose-famous')return metadata({title:'Stories',creator:'Famous Narrator'},[file({title:'Moon'})]);
    return partialAudio();
  });
  assert.deepEqual((await searchArchiveSongs('pale moon')).results.map(song=>song.archiveId),['named-rare']);
});

test('numbered placeholder titles list after real titles, and titles lose a file extension',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'numbered',title:'Tracks',creator:'Plain Band',downloads:10},{identifier:'titled',title:'Songs',creator:'Plain Band',downloads:1}]}});
    if(url.pathname==='/metadata/numbered')return metadata({title:'Tracks',creator:'Plain Band'},[file({name:'01.mp3',title:'01 Track 1'}),file({name:'02.mp3',title:'トラック02'})]);
    if(url.pathname==='/metadata/titled')return metadata({title:'Songs',creator:'Plain Band'},[file({name:'x.mp3',title:'Real Song.mp3'})]);
    return partialAudio();
  });
  const titles=(await searchArchiveSongs('plain band')).results.map(song=>song.title);
  assert.equal(titles[0],'Real Song');
  assert.deepEqual(titles.slice(1).sort(),['01 Track 1','トラック02']);
});

test('keyword-stuffed uploads do not take genre slots from music further down the catalog',async t=>{
  const stuffed=Array.from({length:20},(_,index)=>`stuffed-${index}`),inspected:string[]=[];
  const keywords=Array.from({length:60},(_,index)=>`keyword${index}`).join(', ');
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      if(!url.searchParams.get('q')!.includes('subject:("disco")'))return Response.json({response:{docs:[]}});
      assert.ok(url.searchParams.getAll('fl[]').includes('subject'));
      return Response.json({response:{docs:[...stuffed.map(identifier=>({identifier,title:identifier,creator:'Reader',subject:`${keywords}, disco`})),{identifier:'real-disco',title:'Album',creator:'Dance Band',subject:'disco'}]}});
    }
    if(url.pathname.startsWith('/metadata/')){inspected.push(url.pathname.split('/')[2]);return metadata({title:'Album',creator:'Dance Band',subject:'disco'},[file({title:'Night Fever Style'})]);}
    return partialAudio();
  });
  assert.deepEqual((await searchArchiveSongs('disco')).results.map(song=>song.archiveId),['real-disco']);
  assert.deepEqual(inspected,['real-disco']);
});

test('short clips list after full tracks in an artist search',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php')return Response.json({response:{docs:[{identifier:'stage',title:'Live set',creator:'Clip Band'}]}});
    if(url.pathname==='/metadata/stage')return metadata({title:'Live set',creator:'Clip Band'},[file({name:'a.mp3',title:'Clip Band talk',length:'12'}),file({name:'b.mp3',title:'First Song',length:'200'})]);
    return partialAudio();
  });
  assert.deepEqual((await searchArchiveSongs('clip band')).results.map(song=>song.title),['First Song','Clip Band talk']);
});
