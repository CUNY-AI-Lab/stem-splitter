import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mp3FrameInfo } from '../src/reliability/media.ts';
import { AudiusError, fetchAudiusAudio, searchAudius } from '../src/audius.ts';

const fixture=readFileSync(new URL('./fixtures/audio/vocals.mp3',import.meta.url));
const audio=()=>new Uint8Array(fixture);
const durationSec=Math.round(mp3FrameInfo(audio().buffer)!.seconds);
const record = (changes={}) => ({id:'4zxjE',title:'Song',user:{name:'Artist'},duration:durationSec,permalink:'/artist/song',
  license:'Attribution-NonCommercial-ShareAlike CC BY-NC-SA',is_available:true,is_streamable:true,is_stream_gated:false,
  access:{stream:true},stream:{url:'https://node.audius.co/full.mp3?temporary=public',mirrors:['https://mirror.audius.co/full.mp3']},...changes});
const run = () => fetchAudiusAudio('4zxjE',{deadline:Date.now()+5000});

test('song search filters inaccessible, partial-length and no-derivatives results and keeps attribution',async t=>{
  t.mock.method(globalThis,'fetch',async (input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.audius.co');assert.equal(url.pathname,'/v1/tracks/search');
    assert.equal(url.searchParams.get('query'),'Song Artist');assert.equal(init?.headers,undefined);
    return Response.json({data:[record(),record({is_stream_gated:true}),record({access:{stream:false}}),record({duration:0}),
      record({duration:901}),record({is_delete:true}),record({is_unlisted:true}),record({license:'CC BY-NC-ND'}),record({permalink:'/../song'})]});
  });
  assert.deepEqual(await searchAudius(' Song\n Artist '),{results:[{id:'4zxjE',title:'Song',artist:'Artist',durationSec,
    sourceUrl:'https://audius.co/artist/song',licenseUrl:'https://creativecommons.org/licenses/by-nc-sa/4.0/'}]});
});

test('short queries and malformed IDs stop before a provider request',async t=>{
  t.mock.method(globalThis,'fetch',async()=>assert.fail('Unexpected request'));
  assert.deepEqual(await searchAudius('a'),{results:[]});
  for(const id of ['../secret','https://private.local/song','','4zxjE?x=1'])await assert.rejects(()=>fetchAudiusAudio(id,{deadline:Date.now()+5000}),{code:'invalid_music_id'});
});

test('a fresh full-stream URL is fetched without account credentials and decoded before acceptance',async t=>{
  const urls=[];let validated=false;
  t.mock.method(globalThis,'fetch',async (input,init)=>{
    const url=String(input);urls.push(url);assert.equal(init?.headers,undefined);assert.equal(init?.redirect,'manual');
    return url.endsWith('/tracks/4zxjE')?Response.json({data:record()}):new Response(audio(),{headers:{'content-type':'audio/mpeg','content-length':String(fixture.length)}});
  });
  const result=await fetchAudiusAudio('4zxjE',{deadline:Date.now()+5000,validate:async data=>{validated=true;assert.deepEqual(new Uint8Array(data),audio());return true;}});
  assert.deepEqual(urls,['https://api.audius.co/v1/tracks/4zxjE','https://node.audius.co/full.mp3?temporary=public']);
  assert.equal(validated,true);assert.equal(result.fileName,'source.mp3');assert.equal(result.durationSec,durationSec);
  assert.equal(result.attribution.creator,'Artist');assert.equal(result.attribution.sourceUrl,'https://audius.co/artist/song');
});

test('gating or missing stream metadata stops before audio delivery',async t=>{
  for(const changes of [{is_stream_gated:true},{access:{stream:false}},{id:'other'},{stream:{}},{stream:{url:'https://127.0.0.1/audio'}},{stream:{url:'https://internal.local/audio'}}]){
    let calls=0;const mocked=t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({data:record(changes)});});
    await assert.rejects(run,AudiusError);assert.equal(calls,1);mocked.mock.restore();
  }
});

test('only redirects to content nodes supplied by the fresh metadata are followed',async t=>{
  for(const target of ['https://mirror.audius.co/full.mp3','https://validator.1234567890abcdef1234567890abcdef.r2.cloudflarestorage.com/full.mp3','https://another.example.org/audio','http://node.audius.co/audio','https://127.0.0.1/audio']){
    let calls=0;const mocked=t.mock.method(globalThis,'fetch',async()=>{
      calls++;return calls===1?Response.json({data:record()}):calls===2?new Response(null,{status:302,headers:{location:target}}):new Response(audio(),{headers:{'content-type':'audio/mpeg'}});
    });
    if(target.startsWith('https://mirror.')||target.includes('.r2.cloudflarestorage.com/')){await run();assert.equal(calls,3);}else{await assert.rejects(run,AudiusError);assert.equal(calls,2);}
    mocked.mock.restore();
  }
});

test('denied, partial, oversized, truncated and invalid media stop without another source request',async t=>{
  for(const response of [new Response(null,{status:403}),new Response(audio(),{status:206,headers:{'content-type':'audio/mpeg'}}),
    new Response(audio(),{headers:{'content-type':'audio/mpeg','content-range':'bytes 0-2047/4000'}}),
    new Response(audio(),{headers:{'content-type':'audio/mpeg','content-length':String(13*1024*1024)}}),
    new Response(audio(),{headers:{'content-type':'audio/mpeg','content-length':String(fixture.length+100)}}),
    new Response(new Uint8Array(2048),{headers:{'content-type':'audio/mpeg'}}),new Response('<html>Login</html>',{headers:{'content-type':'text/html'}})]){
    let calls=0;const mocked=t.mock.method(globalThis,'fetch',async()=>++calls===1?Response.json({data:record()}):response);
    await assert.rejects(run,AudiusError);assert.equal(calls,2);mocked.mock.restore();
  }
});

test('decoder rejection and malformed search responses fail closed',async t=>{
  const mocked=t.mock.method(globalThis,'fetch',async input=>String(input).endsWith('/tracks/4zxjE')?Response.json({data:record()}):new Response(audio(),{headers:{'content-type':'audio/mpeg'}}));
  await assert.rejects(()=>fetchAudiusAudio('4zxjE',{deadline:Date.now()+5000,validate:async()=>false}),AudiusError);mocked.mock.restore();
  t.mock.method(globalThis,'fetch',async()=>Response.json({data:{}}));await assert.rejects(()=>searchAudius('Song'),AudiusError);
});


test('a valid audio excerpt is rejected when the catalog reports a longer song',async t=>{
  t.mock.method(globalThis,'fetch',async input=>String(input).endsWith('/tracks/4zxjE')?Response.json({data:record({duration:durationSec+30})}):new Response(audio(),{headers:{'content-type':'audio/mpeg'}}));
  await assert.rejects(run,{code:'music_incomplete'});
});
