import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from '../src/index.ts';
import { SqliteD1 } from '../server/d1.ts';
import type { Env } from '../src/env.ts';
import { personalPrompt, savePersonalPrompt } from '../src/personal-prompts.ts';
import { cacheGuideIfPromptCurrent, getGuide, loadAmendmentState } from '../src/assistant/index.ts';
import { hashSystemPromptFingerprint } from '../src/assistant/prompt.ts';
import { saveCoursePrompt } from '../src/classroom/prompts.ts';
import { courseFixture } from './course-fixture.ts';

const alice='cail-'+'1'.repeat(32),bob='cail-'+'2'.repeat(32),admin='cail-'+'3'.repeat(32),course='personal-prompt-test-class';
async function fixture(t: {after(fn:()=>void):void}) {
  const db=new SqliteD1(':memory:');db.applySchema(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const systems:string[]=[];let admitted=true;
  const env={AUTH_MODE:'cail',PUBLIC_BASE_URL:'https://split.test',DB:db,CAIL_COURSE_IDS:course,
    verifyCailIdentity:async(token:string)=>[alice,bob,admin].includes(token)?{subject:token,name:'Fixture person'}:null,
    ADMISSION_RESOLVER:{resolveMembership:async({subject}:any)=>admitted?{ok:true,accessRole:subject===admin?'admin':'member',budgetScope:subject===admin?'admin':'person',revision:1,expiresAt:new Date(Date.now()+60000).toISOString()}:{ok:false,code:'not_admitted'},
      resolveCourseAccessV2:async({subject,classId}:any)=>courseFixture(subject,classId,subject===admin)},
    ASSISTANT_MODEL:'fixture',assistantTransport:async(_env:unknown,input:any,delta:(text:string)=>Promise<void>)=>{
      systems.push(input.messages[0].content);await delta('A synthetic response.');return {content:'A synthetic response.',model:'fixture',toolCalls:[],finishReason:'stop'};
    },
  } as unknown as Env;
  for(const subject of [alice,bob,admin])await db.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  const call=(path='/api/account/prompt',subject=alice,method='GET',body?:unknown,headers:Record<string,string>={})=>app.fetch(new Request('https://split.test'+path,{method,headers:{'x-cail-identity-jwt':subject,origin:'https://split.test','content-type':'application/json','X-Stem-Prompt-Actor':subject,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  const job=async(id:string,subject=alice,classId:string|null=null)=>{
    await db.prepare("INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES(?,?,?,'done','htdemucs_ft','[]')").bind(id,'Synthetic recording','uploads/'+id+'.wav').run();
    await db.prepare('INSERT INTO job_owners(job_id,subject) VALUES(?,?)').bind(id,subject).run();
    if(classId)await db.prepare("INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES(?,?,?,?,'course-work-v1')").bind(id,classId,(await courseFixture(subject,classId)).memberId,subject).run();
  };
  return {db,env,call,job,systems,revoke:()=>{admitted=false;}};
}
const edit=(amendment:string,expectedRevision=0)=>({amendment,expectedRevision,changeNote:'Synthetic instruction change'});

test('members save own instructions with notes, previews and immutable history',async t=>{
  const f=await fixture(t);
  const initial=await(await f.call()).json() as any;assert.equal(initial.revision,0);assert.equal(initial.scope,'personal');
  assert.equal((await f.call('/api/account/prompt',alice,'PUT',{amendment:'A personal goal',expectedRevision:0})).status,400);
  const saved=await f.call('/api/account/prompt',alice,'PUT',edit('A personal goal'));assert.equal(saved.status,200);
  const data=await saved.json() as any;assert.equal(data.revision,1);assert.equal(data.history.length,1);assert.equal(data.history[0].updatedBy,'You');
  assert.ok(!(JSON.stringify(data).includes(alice)));
  const preview=(await(await f.call('/api/account/prompt/preview')).json() as any).prompt;
  assert.match(preview,/A personal goal/);assert.match(preview,/ADDITIONAL LISTENING INSTRUCTIONS/);
  assert.doesNotMatch(preview,/YOUR INSTRUCTOR'S NOTES FOR THIS CLASS/);
  const audit=await f.db.prepare('SELECT subject,actor FROM personal_prompt_revisions').first<any>();assert.equal(audit.actor,alice);assert.equal(audit.subject,alice);
  await assert.rejects(f.db.prepare('DELETE FROM personal_prompt_revisions').run(),/immutable/);
  await assert.rejects(f.db.prepare("UPDATE personal_prompt_revisions SET amendment='altered'").run(),/immutable/);
  await assert.rejects(f.db.prepare('INSERT OR REPLACE INTO personal_prompt_revisions SELECT * FROM personal_prompt_revisions').run(),/immutable/);
});
test('personal policy never grants class or application instructor powers',async t=>{
  const f=await fixture(t);await f.call('/api/account/prompt',alice,'PUT',edit('Private Alice instructions'));
  for(const subject of [bob,admin]) {
    const body=await(await f.call('/api/account/prompt',subject)).json() as any;assert.equal(body.amendment,'');assert.deepEqual(body.history,[]);
    assert.doesNotMatch(JSON.stringify(body),/Private Alice/);
  }
  assert.equal((await f.call('/api/teacher/prompt')).status,403);
  assert.equal((await f.call('/api/classroom/courses/'+course+'/prompt')).status,403);
  assert.equal((await f.call('/api/admin/users')).status,403);
  assert.equal((await f.call('/api/account/prompt',bob,'PUT',{...edit('forged'),subject:alice})).status,400);
});
test('actor changes, sign-out, admission revocation and foreign origins block writes',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/account/prompt',bob,'PUT',edit('stale browser draft'),{'X-Stem-Prompt-Actor':alice})).status,409);
  assert.equal((await f.call('/api/account/prompt',alice,'PUT',edit('forged origin'),{origin:'https://attacker.test'})).status,403);
  assert.equal((await f.call('/api/account/prompt','')).status,401);
  f.revoke();assert.equal((await f.call('/api/account/prompt',alice,'PUT',edit('revoked'))).status,403);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM personal_prompt_revisions').first<any>()).n,0);
});
test('concurrent first writes have one winner and no-op/reset semantics retain history',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([savePersonalPrompt(f.env,alice,edit('one')),savePersonalPrompt(f.env,alice,edit('two'))]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const current=await personalPrompt(f.env,alice);
  assert.equal((await savePersonalPrompt(f.env,alice,{amendment:current.amendment,expectedRevision:1})).changed,false);
  assert.equal((await savePersonalPrompt(f.env,alice,edit('',1))).status,200);
  const history=(await(await f.call()).json() as any).history;assert.deepEqual(history.map((x:any)=>x.settingsRevision),[2,1]);assert.equal(history[0].amendment,'');
  assert.equal((await savePersonalPrompt(f.env,alice,edit('stale',1))).status,409);
});
test('history pagination is bounded to the same subject',async t=>{
  const f=await fixture(t);
  for(let i=0;i<43;i++)await savePersonalPrompt(f.env,alice,edit('Revision '+i,i));
  await savePersonalPrompt(f.env,bob,edit('Private Bob'));
  const first=await(await f.call()).json() as any;assert.equal(first.history.length,40);assert.equal(first.historyHasMore,true);
  const next=await(await f.call('/api/account/prompt/history?before='+first.historyNextBeforeId)).json() as any;
  assert.equal(next.history.length,3);assert.equal(next.historyHasMore,false);assert.doesNotMatch(JSON.stringify(next),/Private Bob/);
  for(const before of ['0','-1','NaN','1.1'])assert.equal((await f.call('/api/account/prompt/history?before='+before)).status,400);
});
test('personal guide caches do not cross accounts, classes, revisions or guests',async t=>{
  const f=await fixture(t);await f.job('personal');await f.job('class-work',alice,course);
  await savePersonalPrompt(f.env,alice,edit('Private Alice'));
  const env={...f.env,ASSISTANT_PERSONAL_SUBJECT:alice},hash=await hashSystemPromptFingerprint('Private Alice');
  const guide={jobId:'personal',text:'Alice personal guide',model:'fixture',createdAt:new Date().toISOString()};
  assert.equal(await cacheGuideIfPromptCurrent(env,guide,1,hash),true);
  assert.equal((await getGuide(env,'personal'))?.text,guide.text);
  assert.equal(await getGuide({...env,ASSISTANT_PERSONAL_SUBJECT:bob},'personal'),null);
  assert.equal(await getGuide({...env,ASSISTANT_PERSONAL_SUBJECT:null},'personal'),null);
  assert.equal(await cacheGuideIfPromptCurrent(env,{...guide,jobId:'class-work'},1,hash),false);
  await savePersonalPrompt(f.env,alice,edit('Updated personal',1));
  assert.equal(await getGuide(env,'personal'),null);assert.equal(await cacheGuideIfPromptCurrent(env,guide,1,hash),false);
  await saveCoursePrompt(f.env,course,admin,edit('Class only'));
  assert.equal((await loadAmendmentState({...env,ASSISTANT_COURSE_ID:course})).amendment,'Class only');
  assert.equal((await loadAmendmentState({...env,ASSISTANT_PERSONAL_SUBJECT:null})).amendment,'');
});
test('actual local guide and chat routes use only the active personal or class policy',async t=>{
  const f=await fixture(t);await f.job('alice-personal');await f.job('bob-personal',bob);await f.job('alice-class',alice,course);
  await savePersonalPrompt(f.env,alice,edit('ALICE_PRIVATE_POLICY'));await savePersonalPrompt(f.env,bob,edit('BOB_PRIVATE_POLICY'));
  await saveCoursePrompt(f.env,course,admin,edit('CLASS_POLICY'));
  await f.db.prepare("UPDATE assistant_settings SET amendment='LEGACY_GLOBAL_POLICY',revision=9 WHERE id=1").run();
  for(const [subject,id,text,excluded] of [[alice,'alice-personal','ALICE_PRIVATE_POLICY','BOB_PRIVATE_POLICY'],[bob,'bob-personal','BOB_PRIVATE_POLICY','ALICE_PRIVATE_POLICY'],[alice,'alice-class','CLASS_POLICY','ALICE_PRIVATE_POLICY']]) {
    const r=await f.call('/api/jobs/'+id+'/guide',subject,'POST',{messageId:'guide-fixture-'+id});assert.equal(r.status,200);assert.match(await r.text(),/"type":"done"/);
    const system=f.systems.at(-1)!;assert.ok(system.includes(text));assert.ok(!system.includes(excluded));assert.ok(!system.includes('LEGACY_GLOBAL_POLICY'));
    assert.match(system,/ADDITIONAL LISTENING INSTRUCTIONS/);assert.doesNotMatch(system,/YOUR INSTRUCTOR'S NOTES FOR THIS CLASS/);
  }
  const chat=await f.call('/api/jobs/alice-personal/chat',alice,'POST',{messages:[{role:'user',content:'Describe the texture.'}],messageId:'personal-chat-fixture-0001'});
  assert.equal(chat.status,200);assert.match(await chat.text(),/"type":"done"/);assert.match(f.systems.at(-1)!,/ALICE_PRIVATE_POLICY/);assert.doesNotMatch(f.systems.at(-1)!,/CLASS_POLICY|BOB_PRIVATE_POLICY|LEGACY_GLOBAL_POLICY/);
  const saved=await(await f.call('/api/jobs/alice-personal')).json() as any;assert.equal(saved.guide.text,'A synthetic response.');
  const otherView=await(await f.call('/api/jobs/alice-personal',admin)).json() as any;assert.equal(otherView.guide,null);
});
test('migration applies twice to the prior schema without altering existing instructions',async t=>{
  const db=new SqliteD1(':memory:');
  const sql=readFileSync(new URL('../schema.sql',import.meta.url),'utf8'),marker='-- Personal Listening Guy policy never grants';
  db.applySchema(sql.slice(0,sql.indexOf(marker)));await db.prepare("UPDATE assistant_settings SET amendment='Existing legacy history' WHERE id=1").run();
  const migration=readFileSync(new URL('../migrations/0033-personal-listening-instructions.sql',import.meta.url),'utf8');db.applySchema(migration);db.applySchema(migration);
  assert.equal((await db.prepare('SELECT amendment FROM assistant_settings WHERE id=1').first<any>()).amendment,'Existing legacy history');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM personal_prompt_settings').first<any>()).n,0);
});
