import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUrlAudio, UrlImportError } from '../src/url-import.ts';
import { YouTubeError } from '../src/youtube.ts';
import type { Env } from '../src/env.ts';
const source='https://www.youtube.com/watch?v=abcdefghijk';
const base={URL_IMPORT_ENABLED:'true',REPLICATE_API_TOKEN:'fixture-replicate-token',REPLICATE_YT_MODEL:'test/importer',REPLICATE_YT_MODEL_VERSION:'a'.repeat(64)};

test('native preview acquisition preserves WebM instead of labeling it M4A',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('A successful native import needs no hosted fallback'));
 const audio={data:new Uint8Array(2048).buffer,title:'Fixture',durationSec:393.8,fileName:'source.webm',contentType:'audio/webm' as const};
 const env={...base,fetchYouTubeBrowserAudio:async()=>audio} as unknown as Env;
 assert.equal((await fetchUrlAudio(source,env,900)).contentType,'audio/webm');
 await assert.rejects(fetchUrlAudio(source,env,300),e=>e instanceof UrlImportError&&e.code==='source_too_long');
});

test('a browser source denial stops without another hosted extraction',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('Access refusals must not cycle through providers'));
 const env={...base,fetchYouTubeBrowserAudio:async()=>{throw new YouTubeError('Source refused','youtube_source_restricted');}} as unknown as Env;
 await assert.rejects(fetchUrlAudio(source,env),e=>e instanceof UrlImportError&&e.code==='source_restricted'&&!e.retryable&&e.message.includes('locally'));
});

test('a temporary browser failure falls back once and reports a hosted denial accurately',async t=>{
 let posts=0;t.mock.method(console,'info',()=>{});
 t.mock.method(globalThis,'fetch',async(_input,init)=>{
  assert.equal(init?.method,'POST');posts++;
  return Response.json({id:'fallback-fixture',status:'failed',error:'Source blocked this import.'});
 });
 const env={...base,fetchYouTubeBrowserAudio:async()=>{throw new YouTubeError('Temporary outage','youtube_fetch_unavailable');}} as unknown as Env;
 await assert.rejects(fetchUrlAudio(source,env),e=>e instanceof UrlImportError&&e.code==='source_denied'&&!e.retryable);
 assert.equal(posts,1);
});
