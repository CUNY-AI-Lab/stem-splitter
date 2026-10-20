import {test,expect} from '@playwright/test';
import {createTestHarness} from 'wrangler';
import {createTestIdentityIssuer,TEST_SUBJECTS} from '@cuny-ai-lab/cail-identity/testing';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setupServer} from 'msw/node';
import {http,HttpResponse} from 'msw';
import {schemaStatements} from '../tests/e2e/schema-statements.mjs';
const names=['vocals','drums','bass','other','guitar','piano'];
function tone(i,dense){const levels=dense==='sparse'?[4,.0008,.0008,.0008,.0008,.0008]:dense?Array(6).fill(.8):[.8,.8,.0008,.8,4,.0008];const r=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`sine=frequency=${[500,1500,80,250,900,650][i]}:sample_rate=44100:duration=2`,'-af',`volume=${levels[i]}`,'-ac','2','-c:a','libmp3lame','-b:a','192k','-f','mp3','pipe:1']);if(r.status!==0)throw Error(String(r.stderr));return r.stdout;}
async function fixture(context,page,dense=false){
 const issuer=await createTestIdentityIssuer(),jwt=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});
 const audio=Object.fromEntries(names.map((name,i)=>[name,tone(i,dense)]));let starts=0;
 const network=setupServer(
  http.post('https://api.replicate.com/v1/predictions',async({request})=>{const b=await request.json();expect(b.input.model).toBe('htdemucs_6s');return HttpResponse.json({id:`browser-adaptive-${++starts}`,status:'starting'});}),
  http.get('https://api.replicate.com/v1/predictions/:id',({params})=>HttpResponse.json({id:params.id,status:'succeeded',output:Object.fromEntries(names.map(name=>[name,`https://adaptive.replicate.delivery/${name}.mp3`]))})),
  http.get('https://adaptive.replicate.delivery/:name.mp3',({params})=>new HttpResponse(audio[String(params.name)],{headers:{'content-type':'audio/mpeg'}})),
  http.get('https://archive.org/metadata/fixture-adaptive',()=>HttpResponse.json({metadata:{title:'Fixture recording',creator:'Fixture ensemble',mediatype:'audio',subject:'Music',licenseurl:'https://creativecommons.org/publicdomain/zero/1.0/'},files:[{name:'fixture.mp3',title:'Fixture song',artist:'Fixture ensemble',format:'VBR MP3',source:'original',length:'2',size:String(audio.vocals.length)}]})),
  http.get('https://archive.org/download/fixture-adaptive/fixture.mp3',()=>new HttpResponse(audio.vocals,{headers:{'content-type':'audio/mpeg','content-length':String(audio.vocals.length)}})),
 );
 network.listen({onUnhandledRequest(request,print){if(['127.0.0.1','localhost'].includes(new URL(request.url).hostname))return;print.error();}});
 const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,TEST_BROWSER:'true',ADAPTIVE_FOUR_ENABLED:'true'},secrets:{REPLICATE_API_TOKEN:'fixture-only',REPLICATE_MODEL_VERSION:'fixture-pin',WEBHOOK_SECRET:'fixture-webhook'}}]});
 const {url}=await harness.listen();await harness.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')))});
 await context.setExtraHTTPHeaders({'x-fixture-identity':jwt});
 await page.route('**/api/song-samples',route=>route.fulfill({json:{enabled:false,revision:0,tracks:[]}}));
 await page.goto(url.href);
 return {harness,url,starts:()=>starts,close:async()=>{network.close();await harness.close();}};
}

test('four-layer upload shows guitar instead of faint bass and plays the real encoded result',async({page,context})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const f=await fixture(context,page);
 try{
  await expect(page.getByRole('radio',{name:'4 splits: strongest musical layers, the rest',exact:true})).toBeChecked();
  await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../tests/fixtures/audio/source.wav',import.meta.url)));
  const console=page.locator('.console').first();await expect(console.getByText('READY',{exact:true})).toBeVisible({timeout:20000});
  await expect(console.locator('.ch-name')).toHaveText(['vocals','drums','guitar','other']);
  await expect(console.locator('.split-meta')).toContainText('4 SPLITS');
  await console.getByRole('button',{name:'Mute guitar',exact:true}).click();await expect(console.getByRole('button',{name:'Mute guitar',exact:true})).toHaveAttribute('aria-pressed','true');
  await console.getByRole('button',{name:'Mute guitar',exact:true}).click();
  await console.getByRole('button',{name:'Play all stems',exact:true}).click();
  await expect.poll(async()=>Number(await console.getByRole('slider',{name:'Seek',exact:true}).inputValue())).toBeGreaterThan(0);
  await console.getByRole('button',{name:'Play all stems',exact:true}).click();
  const download=page.waitForEvent('download');await console.getByTitle('Download guitar',{exact:true}).click();expect((await download).suggestedFilename()).toMatch(/guitar.*\.mp3$/);
  expect(f.starts()).toBe(1);expect(errors).toEqual([]);
 }finally{await f.close();}
});

test('Auto analyzes imported audio through the actual six-source path and keeps a dense six-layer result',async({page,context})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const f=await fixture(context,page,true),submitted=[];
 try{
  page.on('request',req=>{if(new URL(req.url()).pathname==='/api/jobs'&&req.method()==='POST')submitted.push(req.postDataJSON());});
  await page.route('**/api/music/search?*',route=>route.fulfill({json:{results:[{id:'fixture-adaptive/fixture.mp3',archiveId:'fixture-adaptive',archiveFile:'fixture.mp3',artist:'Fixture ensemble',title:'Fixture song',durationSec:2,bytes:50000,itemTitle:'Fixture recording'}]}}));
  await page.getByRole('radio',{name:'Auto: listen after import and choose 2, 4, or 6 splits',exact:true}).check();
  await page.getByRole('combobox',{name:'Song or link',exact:true}).fill('Fixture song');await page.getByRole('listbox',{name:'Songs',exact:true}).getByRole('option').click();await page.getByRole('button',{name:'FETCH',exact:true}).click();
  const console=page.locator('.console').first();await expect(console.getByText('READY',{exact:true})).toBeVisible({timeout:20000});
  expect(submitted[0]).toMatchObject({model:'auto',archiveId:'fixture-adaptive',archiveFile:'fixture.mp3'});
  await expect(console.locator('.ch-name')).toHaveText(['vocals','drums','bass','other','guitar','piano']);
  expect(f.starts()).toBe(1);expect(errors).toEqual([]);
 }finally{await f.close();}
});


test('Auto publishes and plays two real layers for a sparse source',async({page,context})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const f=await fixture(context,page,'sparse');
 try{
  await page.getByRole('radio',{name:'Auto: listen after import and choose 2, 4, or 6 splits',exact:true}).check();
  await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../tests/fixtures/audio/source.wav',import.meta.url)));
  const console=page.locator('.console').first();await expect(console.getByText('READY',{exact:true})).toBeVisible({timeout:20000});
  await expect(console.locator('.ch-name')).toHaveText(['vocals','other']);
  await expect(console.locator('.split-meta')).toContainText('2 SPLITS');
  await console.getByRole('button',{name:'Play all stems',exact:true}).click();
  await expect.poll(async()=>Number(await console.getByRole('slider',{name:'Seek',exact:true}).inputValue())).toBeGreaterThan(0);
  await console.getByRole('button',{name:'Play all stems',exact:true}).click();
  expect(f.starts()).toBe(1);expect(errors).toEqual([]);
 }finally{await f.close();}
});
