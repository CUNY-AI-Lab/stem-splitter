import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import candidates from '../public/search-samples.json' with { type: 'json' };

test('public playlist suggestions verify before identity or account setup; arbitrary searches remain protected', async () => {
  const track=candidates[0], audio=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  const network=setupServer(
    http.get('https://archive.org/metadata/'+track.archiveId,()=>HttpResponse.json({metadata:{title:track.title,creator:track.artist,mediatype:'audio',subject:'Music'},files:[{name:track.archiveFile,title:track.title,size:String(audio.length),length:'2'}]})),
    http.get('https://archive.org/download/:id/:file',()=>new HttpResponse(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}})),
  );
  network.listen({onUnhandledRequest:'error'});
  const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url))}]});
  try {
    await server.listen();const worker=server.getWorker('stem-preview-contract-test');
    const query=new URLSearchParams({q:`${track.artist} ${track.title}`,sampleItem:track.archiveId,sampleFile:track.archiveFile});
    const response=await worker.fetch('/api/music/search?'+query);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'public, max-age=60');
    const data=await response.json() as {results:{archiveId:string;archiveFile:string}[]};
    assert.equal(data.results.length,1);assert.equal(data.results[0].archiveId,track.archiveId);
    const unauthorized=await worker.fetch('/api/music/search?q=arbitrary');
    assert.equal(unauthorized.status,401);
  }finally{await server.close();network.close();}
});
