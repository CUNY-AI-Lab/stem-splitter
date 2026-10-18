import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTestHarness} from 'wrangler';
import {setupServer} from 'msw/node';
import {http,HttpResponse} from 'msw';
import {schemaStatements} from '../tests/e2e/schema-statements.mjs';
import {createMp3Decoder} from './audio-validator.ts';
import {validateMp3Pcm} from '../src/reliability/media.ts';
import {createHash} from 'node:crypto';
import {OUTPUT_KIND} from '../src/reliability/output.ts';
const names=['vocals','drums','bass','other','guitar','piano'];
// Fixture generation and both complete modes share this budget on slower CI runners;
// each individual output invocation still has the separate 120-second assertion below.
test('workerd: fifteen-minute four and Auto survive bounded stages, including five-source remainder',{timeout:600000},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'stem-long-output-'));
 const audio:Record<string,Buffer>={};const timings:{mode:string;steps:number[];totalMs:number}[]=[];
 for(let i=0;i<names.length;i++){
  const r=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`sine=frequency=${[500,1500,80,250,900,650][i]}:sample_rate=48000:duration=899.8`,
   '-af',`volume=${i===0?4:.0008}`,'-ac','2','-c:a','libmp3lame','-b:a','192k','-f','mp3','pipe:1'],{maxBuffer:24*1024*1024});
  assert.equal(r.status,0,String(r.stderr));audio[names[i]]=r.stdout;
 }
 const network=setupServer(http.get('https://long.replicate.delivery/:name.mp3',({params})=>new HttpResponse(audio[String(params.name)],{headers:{'content-type':'audio/mpeg'}})));
 network.listen({onUnhandledRequest:'error'});
 const harness=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url))}]});
 try {
  await harness.listen();const worker=harness.getWorker('stem-preview-contract-test');
  const sql=async(statements:string[])=>assert.equal((await worker.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(statements)})).status,200);
  await sql(schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8')));
  const subject='cail-'+'f'.repeat(32);await sql([`INSERT INTO app_users(subject) VALUES('${subject}')`]);
  for(const mode of [4,'auto'] as const){
   const id=crypto.randomUUID(),now=Date.now();
   const progress={kind:OUTPUT_KIND,model:'htdemucs_6s',requested:mode,sources:[],outputs:[],remote:names.map(name=>({name,url:`https://long.replicate.delivery/${name}.mp3`}))};
   await sql([`INSERT INTO app_operations(id,subject,quota_class,kind,idempotency_key,fingerprint,day,state,phase,job_id,result_json,provider_id,deadline,created_at,updated_at)
    VALUES('${id}','${subject}','member','split','${id}','${id}','2026-10-18','processing','split','${id}','${JSON.stringify(progress)}','already-paid',${now+86400000},${now},${now})`,
    `INSERT INTO jobs(id,filename,source_key,status,model) VALUES('${id}','Long fixture','uploads/fixture/audio.mp3','processing','htdemucs_6s')`]);
   const start=performance.now(),steps:number[]=[];let state:any;
   for(let i=0;i<24;i++){
    const begin=performance.now();const response=await worker.fetch(`/__fixture/output-step?id=${id}`,{headers:{'x-fixture':'local-only'}});
    assert.equal(response.status,200,await response.clone().text());state=await response.json();steps.push(performance.now()-begin);console.log(JSON.stringify({event:'long_output_step',mode,step:i,wallMs:steps.at(-1)}));
    if(state.done)break;
   }
   assert.equal(state.job.status,'done',JSON.stringify(state));assert.equal(state.progress.plan.parts,mode===4?4:2);
   assert.ok(Math.max(...steps)<120000,'Each invocation needs substantial headroom below the 300s CPU limit');
   assert.equal(state.progress.sources.length,6);assert.equal(state.progress.remote.length,0);
   assert.ok(state.progress.outputs.every((s:any)=>s.validated));
   const hashes:string[]=[],durations:number[]=[];
   for(const output of state.progress.outputs){
    const response=await worker.fetch('/__fixture/output-file?key='+encodeURIComponent(output.key),{headers:{'x-fixture':'local-only'}});
    assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());
    hashes.push(createHash('sha256').update(bytes).digest('hex'));
    const path=join(folder,String(mode)+'-'+output.name+'.mp3');await writeFile(path,bytes);
    const decode=spawnSync('ffmpeg',['-nostdin','-v','error','-xerror','-err_detect','explode','-i',path,'-f','null','-']);
    assert.equal(decode.status,0,String(decode.stderr));
    const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',path]);
    assert.equal(probe.status,0);durations.push(Number(String(probe.stdout).trim()));
   }
   assert.equal(new Set(hashes).size,state.progress.outputs.length);
   assert.ok(durations.every(seconds=>seconds>899.7&&seconds<900.1));
   assert.ok(Math.max(...durations)-Math.min(...durations)<.1);
   timings.push({mode:String(mode),steps,totalMs:performance.now()-start});
  }
  assert.equal(await validateMp3Pcm(audio.vocals.buffer.slice(audio.vocals.byteOffset,audio.vocals.byteOffset+audio.vocals.byteLength),createMp3Decoder),true);
  console.log(JSON.stringify({event:'long_output_benchmark',timings}));
  if(process.env.STEM_PERFORMANCE_RECEIPT)await writeFile(process.env.STEM_PERFORMANCE_RECEIPT,JSON.stringify(timings,null,2));
 } finally {await harness.close();network.close();await rm(folder,{recursive:true,force:true});}
});
