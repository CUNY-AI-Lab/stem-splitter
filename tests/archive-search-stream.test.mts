import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { archiveSongSearchResponse } from '../src/archive-search-response.ts';
import { searchArchiveSongs } from '../src/archive.ts';
import { mp3FrameInfo } from '../src/reliability/media.ts';

const audio = new Uint8Array(readFileSync(new URL('./fixtures/audio/vocals.mp3', import.meta.url)));
const duration = mp3FrameInfo(audio.buffer)!.seconds;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const metadata = (title: string) => Response.json({metadata:{title,creator:'Fixture Musician',mediatype:'audio',subject:'Music'},
  files:[{name:'song.mp3',title,size:String(audio.length),length:String(duration)}]});
const probe = () => new Response(audio.subarray(0,65536),{status:206,headers:{'content-type':'audio/mpeg',
  'content-range':`bytes 0-${Math.min(65535,audio.length-1)}/${audio.length}`}});
const packet = (value: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(value));

test('verified songs stream before a slow catalog finishes, while concurrent searches share work', {timeout:5000}, async t => {
  const catalog = deferred(), download = deferred(), probeStarted = deferred();
  let calls = 0, checked = false;
  t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL) => {
    calls++;
    const url = new URL(String(input));
    if (url.pathname === '/advancedsearch.php') {
      if (url.searchParams.get('q')!.includes('creator:[* TO *]')) await catalog.promise;
      return Response.json({response:{docs:[{identifier:'rapid-melody',title:'Rapid melody',creator:'Fixture Musician'}]}});
    }
    if (url.pathname.startsWith('/metadata/')) return metadata('Rapid melody');
    probeStarted.resolve(); await download.promise; checked = true; return probe();
  });
  const response = await archiveSongSearchResponse('Rapid melody',true), reader = response.body!.getReader();
  assert.equal(response.headers.get('content-type'),'application/x-ndjson');
  assert.deepEqual(packet((await reader.read()).value),{results:[],done:false});
  let delivered = false;
  const first = reader.read().then(value => {delivered = true; return value;});
  try {
    await probeStarted.promise; await Promise.resolve();
    assert.equal(delivered,false,'a metadata match alone cannot enter the stream');
    download.resolve();
    const update = packet((await first).value);
    assert.equal(checked,true); assert.equal(update.done,false); assert.equal(update.results[0].archiveId,'rapid-melody');
    const updates: unknown[] = [];
    const joined = searchArchiveSongs('RAPID MELODY',value => updates.push(value));
    assert.equal(updates.length,1,'a joining subscriber immediately sees verified matches');
    catalog.resolve();
    let final;
    for (;;) {const value=await reader.read();if(value.done)break;const part=packet(value.value);if(part.done)final=part;}
    assert.equal(final.results.length,1); assert.equal((await joined).results.length,1);
    assert.equal(calls,5,'three catalogs, one metadata request and one audio probe are shared');
    const cached=await archiveSongSearchResponse('rapid melody',false);
    assert.equal(cached.status,200); assert.equal((await cached.json()).results.length,1); assert.equal(calls,5);
  } finally {catalog.resolve(); download.resolve(); await reader.cancel();}
});

test('canceling one streaming reader leaves another subscriber able to complete', {timeout:5000}, async t => {
  const gate=deferred();let calls=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    calls++;const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){await gate.promise;return Response.json({response:{docs:[{identifier:'cancel-melody'}]}});}
    if(url.pathname.startsWith('/metadata/'))return metadata('Cancel melody');
    return probe();
  });
  const abandoned=await archiveSongSearchResponse('Cancel melody',true);
  const active=archiveSongSearchResponse('Cancel melody',false);
  await abandoned.body!.cancel();gate.resolve();
  const response=await active;assert.equal(response.status,200);assert.equal((await response.json()).results.length,1);assert.equal(calls,5);
});

test('stream failures are explicit and failed searches can be retried through JSON',async t=>{
  let healthy=false;
  t.mock.method(globalThis,'fetch',async()=>healthy?Response.json({response:{docs:[]}}):new Response('private upstream content',{status:403}));
  const response=await archiveSongSearchResponse('Retry stream melody',true);
  const lines=(await response.text()).trim().split('\n').map(value=>JSON.parse(value));
  assert.equal(lines.at(-1).done,true);assert.match(lines.at(-1).error,/Internet Archive/);
  assert.doesNotMatch(JSON.stringify(lines),/private upstream content/);
  assert.equal((await archiveSongSearchResponse('Retry stream melody',false)).status,502);
  healthy=true;
  const recovered=await archiveSongSearchResponse('Retry stream melody',false);
  assert.equal(recovered.status,200);assert.deepEqual(await recovered.json(),{results:[]});
});

test('overlapping discovery stays bounded and the complete credited catalog remains eligible',async t=>{
  const metadataIds=new Set<string>(),probeIds=new Set<string>();let catalogs=0,activeMetadata=0,maxMetadata=0,activeProbes=0,maxProbes=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/advancedsearch.php'){
      const query=++catalogs;
      return Response.json({response:{docs:Array.from({length:16},(_,i)=>({identifier:`bounded-${query}-${i}`,title:'Bounded melody',creator:'Fixture Musician'}))}});
    }
    const id=url.pathname.split('/')[2];
    if(url.pathname.startsWith('/metadata/')){
      assert.equal(metadataIds.has(id),false);metadataIds.add(id);maxMetadata=Math.max(maxMetadata,++activeMetadata);
      await new Promise(resolve=>setTimeout(resolve,1));activeMetadata--;return metadata('Bounded melody');
    }
    assert.equal(probeIds.has(id),false);probeIds.add(id);maxProbes=Math.max(maxProbes,++activeProbes);
    await new Promise(resolve=>setTimeout(resolve,1));activeProbes--;return probe();
  });
  const result=await searchArchiveSongs('Bounded melody');
  assert.equal(result.results.length,8);assert.ok(metadataIds.size<=32);assert.ok(probeIds.size<=32);
  assert.ok(maxMetadata<=4);assert.ok(maxProbes<=2);
  // The music query sorts first; the early credited query also receives inspection.
  for(let i=0;i<16;i++)assert.ok(metadataIds.has(`bounded-2-${i}`));
  assert.ok(metadataIds.has('bounded-1-0'));
});
