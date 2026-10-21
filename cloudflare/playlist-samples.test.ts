import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { defaultSampleSettings } from '../src/song-sample-resource.ts';

test('public playlist suggestions verify before identity or account setup; arbitrary searches remain protected', async () => {
  const track=defaultSampleSettings().tracks[0], audio=await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url));
  const network=setupServer(
    http.get('https://archive.org/metadata/'+track.archiveId,()=>HttpResponse.json({metadata:{title:track.title,creator:track.artist,mediatype:'audio',subject:'Music'},files:[{name:track.archiveFile,title:track.title,size:String(audio.length),length:'2'}]})),
    http.get('https://archive.org/download/:id/:file',()=>new HttpResponse(audio,{headers:{'content-type':'audio/mpeg','content-length':String(audio.length)}})),
  );
  network.listen({onUnhandledRequest:'error'});
  const issuer=await createTestIdentityIssuer();
  const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson}}]});
  try {
    await server.listen();const worker=server.getWorker('stem-preview-contract-test');
    const schema=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schema)});
    const query=new URLSearchParams({q:`${track.artist} ${track.title}`,sampleItem:track.archiveId,sampleFile:track.archiveFile});
    const response=await worker.fetch('/api/music/search?'+query);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'public, max-age=60');
    const data=await response.json() as {results:{archiveId:string;archiveFile:string}[]};
    assert.equal(data.results.length,1);assert.equal(data.results[0].archiveId,track.archiveId);
    const edited=defaultSampleSettings();edited.tracks[0]={...edited.tracks[0],artist:'Class listening example',title:'Opening selection'};
    await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify([
      `UPDATE song_sample_settings SET revision=revision+1,settings='${JSON.stringify(edited).replaceAll("'","''")}' WHERE id=1`,
    ])});
    const renamedQuery=new URLSearchParams({q:'Class listening example Opening selection',sampleItem:track.archiveId,sampleFile:track.archiveFile});
    const renamed=await worker.fetch('/api/music/search?'+renamedQuery);
    assert.equal(renamed.status,200);
    const renamedData=await renamed.json() as {results:{title:string;artist:string;sourceTitle:string;itemTitle:string;archiveFile:string}[]};
    assert.equal(renamedData.results[0].title,'Opening selection');assert.equal(renamedData.results[0].artist,'Class listening example');
    assert.equal(renamedData.results[0].sourceTitle,track.title);assert.equal(renamedData.results[0].itemTitle,track.title);
    assert.equal(renamedData.results[0].archiveFile,track.archiveFile);
    assert.equal((await worker.fetch('/api/music/search?'+query)).status,401,'retired labels do not qualify for the public allowlist');
    const unauthorized=await worker.fetch('/api/music/search?q=arbitrary');
    assert.equal(unauthorized.status,401);
  }finally{await server.close();network.close();}
});
