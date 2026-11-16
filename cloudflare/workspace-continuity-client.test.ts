import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const alice='cail-'+'a'.repeat(32),bob='cail-'+'b'.repeat(32),guest='guest-'+'c'.repeat(64);
const progress=(draft='')=>({draft,position:0,rate:1,muted:[],solo:null,loop:null,guideOpen:false});
const key=(who=alice,id='job')=>`stem-listening:${who}:${id}`;
const plain=(value:any)=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await tick();}assert.ok(check(),'condition settled');}
function fixture(initial:Record<string,string>={},handler?:any){
  const storage=new Map(Object.entries(initial)),calls:any[]=[],timers=new Set<any>();
  const localStorage={get length(){return storage.size;},key:(i:number)=>[...storage.keys()][i],getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)};
  const reply=(body:any,actor=alice,status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Stem-Account':actor}});
  const fetch=async(path:string,options:any={})=>{
    const call={path,...options,body:options.body?JSON.parse(options.body):null};calls.push(call);
    if(handler)return handler(call,reply);
    if(options.method==='POST')return reply({accepted:[]});
    if(options.method==='PUT')return reply({revision:call.body.baseRevision+1});
    return reply({actor:options.headers['X-Stem-Account'],jobId:'job',records:{}} ,options.headers['X-Stem-Account']);
  };
  const context:any={localStorage,crypto:webcrypto,TextEncoder,AbortController,AbortSignal,fetch,
    setTimeout:(fn:any,ms:number)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms===600?1:ms);timers.add(timer);return timer;},
    clearTimeout:(id:any)=>{timers.delete(id);clearTimeout(id);}};
  context.window=context;context.StemFetch=fetch;
  vm.createContext(context);
  for(const file of ['guest-claim.js','workspace-continuity.js'])vm.runInContext(readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8'),context);
  return {context,storage,calls,reply,stop(){context.StemUiState.stop();for(const timer of timers)clearTimeout(timer);}};
}

test('seed snapshots only the verified namespace, including jobs absent from rack; pending stays inert',async()=>{
  const original={...progress('draft'),pendingChat:{messageId:'1234567890abcdef',messages:[{role:'user',content:'unsent'}]}};
  const f=fixture({[key()]:JSON.stringify(original),[key(bob)]:JSON.stringify(progress('other')),'jobs:unscoped':'[]', [key(alice,'not/in-rack')]:JSON.stringify(progress('invalid'))});
  try{
    await f.context.StemUiState.seed(alice);
    const call=f.calls[0];assert.equal(call.headers['X-Stem-Account'],alice);
    assert.deepEqual(call.body.records.map((r:any)=>r.kind),['listeningDraft','listeningPlayer','pendingChat']);
    assert.ok(call.body.records.every((r:any)=>r.jobId==='job'));
    assert.match(call.body.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    await f.context.StemUiState.seed(alice);assert.equal(f.calls[1].body.requestId,call.body.requestId);
    assert.deepEqual(JSON.parse(f.storage.get(key())!),original);
  }finally{f.stop();}
});

test('seed chunks at64 records and retains denied or inaccessible local originals',async()=>{
  const initial=Object.fromEntries(Array.from({length:40},(_,i)=>[key(alice,`job-${i}`),JSON.stringify(progress(`draft ${i}`))]));
  const f=fixture(initial,(_:any,reply:any)=>reply({denied:['job-1']}));
  try{await f.context.StemUiState.seed(alice);assert.deepEqual(f.calls.map(c=>c.body.records.length),[64,16]);assert.equal(f.storage.size,40);}
  finally{f.stop();}
});

test('fresh browser hydrates draft and player but never pending server receipts',async()=>{
  const f=fixture({},(_:any,reply:any)=>reply({actor:alice,jobId:'job',records:{listeningDraft:{value:'saved',revision:3},listeningPlayer:{value:progress(),revision:2}},versions:[{recordKind:'pendingChat',value:{messageId:'do-not-replay'}}]}));
  const updates:any[]=[];
  try{f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',(value:any)=>updates.push(plain(value)));await until(()=>updates.length===1);assert.equal(updates[0].draft,'saved');assert.equal(updates[0].rate,1);assert.equal(updates[0].pendingChat,undefined);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);}
  finally{f.stop();}
});

test('late hydrate never replaces a locally edited field and uses base0 for its conflict check',async()=>{
  let release:any;const waiting=new Promise(resolve=>{release=resolve;});
  const f=fixture({},async(call:any,reply:any)=>call.method==='PUT'?reply({revision:1}):await waiting);
  const updates:any[]=[];
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',(v:any)=>updates.push(plain(v)));
    await until(()=>f.calls.length===1);
    f.context.StemListeningProgress.save(alice,'job',progress('new typing'));
    release(f.reply({actor:alice,jobId:'job',records:{listeningDraft:{value:'older',revision:9}}}));
    await until(()=>f.calls.some(c=>c.method==='PUT'));
    assert.equal(updates.length,0);
    assert.equal(f.calls.find(c=>c.method==='PUT').body.baseRevision,0);
    assert.equal(f.calls.find(c=>c.method==='PUT').body.value,'new typing');
  }finally{f.stop();}
});

test('account switch and disposed mixer reject stale read callbacks',async()=>{
  let release:any;const waiting=new Promise(resolve=>{release=resolve;});
  const f=fixture({},()=>waiting);const updates:any[]=[];
  try{
    f.context.StemUiState.start(alice);const stop=f.context.StemUiState.watch(alice,'job',(v:any)=>updates.push(v));
    await until(()=>f.calls.length===1);stop();f.context.StemUiState.start(bob);
    release(f.reply({actor:alice,jobId:'job',records:{listeningDraft:{value:'private',revision:1}}}));
    await tick();await tick();assert.equal(updates.length,0);
  }finally{f.stop();}
});

for (const remote of ['remote',null]) test(`draft rejected by view is not silently written back by a player save over ${remote===null?'a clear':'remote text'}`,async()=>{
  const f=fixture({[key()]:JSON.stringify(progress('current local'))},(call:any,reply:any)=>{
    if(call.method==='POST')return reply({accepted:[]});
    if(call.method==='PUT')return reply({revision:1});
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:remote,revision:2}}});
  });let loaded=false;
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{loaded=true;return {draft:false};});await until(()=>loaded);
    f.context.StemListeningProgress.save(alice,'job',{...progress('current local'),rate:.5});f.context.StemUiState.flush();
    await until(()=>f.calls.some(c=>c.method==='PUT'));
    assert.deepEqual(f.calls.filter(c=>c.method==='PUT').map(c=>c.body.kind),['listeningPlayer']);
  }finally{f.stop();}
});

test('an archived startup draft can yield to a remote clear without writing the old draft back',async()=>{
  const f=fixture({[key()]:JSON.stringify(progress('stale cache'))},(call:any,reply:any)=>{
    if(call.method==='POST')return reply({accepted:call.body.records.map((record:any)=>({...record,outcome:'conflict',revision:2}))});
    if(call.method==='PUT')return reply({revision:1});
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:null,revision:2}}});
  });let loaded=false;
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',(update:any,baseline:any)=>{
      assert.equal(update.draft,'');assert.equal(baseline.draftBaseline,'stale cache');assert.equal(baseline.draftPreserved,true);loaded=true;
    });await until(()=>loaded);
    f.context.StemListeningProgress.save(alice,'job',{...progress(),rate:.5});f.context.StemUiState.flush();
    await until(()=>f.calls.some(c=>c.method==='PUT'));
    assert.deepEqual(f.calls.filter(c=>c.method==='PUT').map(c=>c.body.kind),['listeningPlayer']);
  }finally{f.stop();}
});

test('an archival seed acknowledgement cannot rebase a new local edit onto the current server revision',async()=>{
  let release:any;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({[key()]:JSON.stringify(progress('cached'))},async(call:any,reply:any)=>{
    if(call.method==='POST'){await gate;return reply({accepted:call.body.records.map((record:any)=>({...record,outcome:'conflict',revision:5}))});}
    if(call.method==='PUT')return reply({revision:1});
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:'cached',revision:5}}});
  });
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{});await until(()=>f.calls.some(c=>c.method==='POST'));
    f.context.StemListeningProgress.save(alice,'job',progress('new local edit'));release();
    await until(()=>f.calls.some(c=>c.method==='PUT'));
    assert.equal(f.calls.find(c=>c.method==='PUT').body.baseRevision,0);
    assert.equal(f.calls.find(c=>c.method==='PUT').body.value,'new local edit');
  }finally{release();f.stop();}
});

test('explicit draft clear is revisioned null and a conflict is not automatically replayed',async()=>{
  let reads=0;
  const f=fixture({[key()]:JSON.stringify(progress('old'))},(call:any,reply:any)=>{
    if(call.method==='POST')return reply({accepted:[]});
    if(call.method==='PUT')return reply({error:'conflict'},alice,409);
    reads++;return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:'old',revision:reads===1?4:5}}});
  });let loaded=false;
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{loaded=true;});await until(()=>loaded);
    f.context.StemListeningProgress.save(alice,'job',progress());f.context.StemUiState.flush();await until(()=>reads===2);await tick();
    const puts=f.calls.filter(c=>c.method==='PUT');assert.equal(puts.length,1);assert.equal(puts[0].body.value,null);assert.equal(puts[0].body.baseRevision,4);
    assert.equal(JSON.parse(f.storage.get(key())!).draft,'');
  }finally{f.stop();}
});

test('lost acknowledgement retries the exact idempotent write and keeps local bytes',async()=>{
  let writes=0,loaded=false;
  const f=fixture({},(call:any,reply:any)=>{
    if(call.method==='PUT')return ++writes===1?Promise.reject(new Error('connection closed')):reply({revision:1});
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:null,revision:0}}});
  });
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{loaded=true;});await until(()=>loaded);
    f.context.StemListeningProgress.save(alice,'job',progress('keep'));f.context.StemUiState.flush();
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(writes,2);
    assert.deepEqual(f.calls.filter(c=>c.method==='PUT').map(c=>c.body)[0],f.calls.filter(c=>c.method==='PUT').map(c=>c.body)[1]);
    assert.equal(JSON.parse(f.storage.get(key())!).draft,'keep');
  }finally{f.stop();}
});

test('wrong actor responses cannot hydrate another person’s private state',async()=>{
  const f=fixture({},(_:any,reply:any)=>reply({actor:bob,jobId:'job',records:{listeningDraft:{value:'private',revision:1}}},bob));
  const updates:any[]=[];
  try{f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',(v:any)=>updates.push(v));await tick();await tick();assert.equal(updates.length,0);}
  finally{f.stop();}
});

test('clear during own initial seed rebases only against that confirmed unchanged baseline',async()=>{
  let release:any,record:any={value:'old draft',revision:1};
  const seedGate=new Promise(resolve=>{release=resolve;});
  const f=fixture({[key()]:JSON.stringify(progress('old draft'))},async(call:any,reply:any)=>{
    if(call.method==='POST'){await seedGate;return reply({accepted:call.body.records.map((r:any)=>({jobId:r.jobId,kind:r.kind,outcome:'applied',revision:1}))});}
    if(call.method==='PUT'){assert.equal(call.body.baseRevision,1);record={value:call.body.value,revision:2};return reply({revision:2});}
    return reply({actor:alice,jobId:'job',records:{listeningDraft:record}});
  });
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{});await until(()=>f.calls.some(c=>c.method==='POST'));
    f.context.StemListeningProgress.save(alice,'job',progress());release();
    await until(()=>record.value===null);await tick();
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
    assert.deepEqual(JSON.parse(f.storage.get(`stem-ui-journal:${alice}:job`)!),{pending:{},cleared:false});
  }finally{release();f.stop();}
});

test('unacknowledged clear survives reload and retries the original typed write without restoring old text',async()=>{
  let online=false,loaded=false;
  const f=fixture({[key()]:JSON.stringify(progress('old draft'))},(call:any,reply:any)=>{
    if(call.method==='POST')return reply({accepted:[]});
    if(call.method==='PUT')return online?reply({revision:6}):Promise.reject(new Error('offline'));
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:'old draft',revision:5}}});
  });
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{loaded=true;});await until(()=>loaded);
    f.context.StemListeningProgress.save(alice,'job',progress());f.context.StemUiState.flush();await until(()=>f.calls.some(c=>c.method==='PUT'));
    const original=f.calls.find(c=>c.method==='PUT').body;
    f.context.StemUiState.stop();online=true;
    const updates:any[]=[];f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',(v:any)=>updates.push(v));
    await until(()=>f.calls.filter(c=>c.method==='PUT').length===2);await tick();
    assert.deepEqual(f.calls.filter(c=>c.method==='PUT')[1].body,original);
    assert.ok(updates.every(v=>v.draft!=='old draft'));
    assert.equal(JSON.parse(f.storage.get(key())!).draft,'');
  }finally{f.stop();}
});

test('a delayed acknowledgement cannot clear a restarted mixer’s newer pending journal',async()=>{
  let release:any,loaded=0,puts=0;
  const body=new Promise(resolve=>{release=resolve;});
  const f=fixture({},(call:any,reply:any)=>{
    if(call.method==='POST')return reply({accepted:[]});
    if(call.method==='PUT')return ++puts===1?{ok:true,status:200,headers:new Headers({'X-Stem-Account':alice}),json:()=>body}:reply({},alice,503);
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:null,revision:0}}});
  });
  try{
    const watch=()=>f.context.StemUiState.watch(alice,'job',()=>{loaded++;return {draft:false};});
    f.context.StemUiState.start(alice);watch();await until(()=>loaded===1);
    f.context.StemListeningProgress.save(alice,'job',progress('first'));f.context.StemUiState.flush();await until(()=>puts===1);
    f.context.StemUiState.start(alice);watch();await until(()=>f.calls.filter(c=>!c.method).length===2);
    await tick();
    f.context.StemListeningProgress.save(alice,'job',progress('newer unsaved edit'));
    const before=f.storage.get(`stem-ui-journal:${alice}:job`);
    release({revision:1});await tick();await tick();
    assert.equal(f.storage.get(`stem-ui-journal:${alice}:job`),before);
  }finally{release({revision:1});f.stop();}
});

test('stopping during retry backoff prevents the old state from sending another write',async()=>{
  let loaded=false,puts=0;
  const f=fixture({},(call:any,reply:any)=>{
    if(call.method==='POST')return reply({accepted:[]});
    if(call.method==='PUT'){puts++;throw new Error('offline');}
    return reply({actor:alice,jobId:'job',records:{listeningDraft:{value:null,revision:0}}});
  });
  try{
    f.context.StemUiState.start(alice);f.context.StemUiState.watch(alice,'job',()=>{loaded=true;});await until(()=>loaded);
    f.context.StemListeningProgress.save(alice,'job',progress('first'));f.context.StemUiState.flush();await until(()=>puts===1);
    f.context.StemUiState.start(alice);
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(puts,1);
  }finally{f.stop();}
});

test('source handoff seeds member and guest independently and exits without rendering app',async()=>{
  const seeds:any[]=[],destinations:string[]=[],paths:string[]=[];
  const context:any={URL,AbortController,location:{origin:'https://original.test',replace:(url:string)=>destinations.push(url)},
    document:{getElementById:()=>({textContent:JSON.stringify({continueUrl:'/auth/guest-transfer/continue?state=nonce'})})},
    fetch:async(path:string)=>{paths.push(path);return new Response(JSON.stringify(path==='/api/account'?{account:{subject:alice}}:{guest:{subject:guest}}),{headers:{'X-Stem-Account':path==='/api/account'?alice:guest}});},
    StemUiState:{seed:async(subject:string,options:any)=>seeds.push({subject,endpoint:options.endpoint})},setTimeout,clearTimeout};context.window=context;
  vm.runInNewContext(readFileSync(new URL('../public/guest-transfer-source.js',import.meta.url),'utf8'),context);
  await until(()=>destinations.length===1);
  assert.deepEqual(seeds,[{subject:alice,endpoint:'/api/account/ui-state/seed'},{subject:guest,endpoint:'/auth/guest-transfer/seed'}]);
  assert.equal(destinations[0],'https://original.test/auth/guest-transfer/continue?state=nonce');
  assert.equal(paths.length,2);
});

for (const who of [alice,guest]) test(`source quietly finishes only typed pending state for ${who===guest?'guest':'member'}`,async()=>{
  const write={kind:'listeningDraft',value:null,baseRevision:5,requestId:'12345678-1234-4123-a123-123456789012'};
  const journalKey=`stem-ui-journal:${who}:job`;
  const f=fixture({[key(who)]:JSON.stringify(progress()),[journalKey]:JSON.stringify({pending:{listeningDraft:write,pendingChat:{messageId:'never-submit'}},cleared:true})},
    (call:any,reply:any)=>reply(call.path.endsWith('/seed')?{accepted:[]}:{revision:6},who));
  try{
    await f.context.StemUiState.seed(who,{flushJournal:true,...(who===guest?{endpoint:'/auth/guest-transfer/seed',writeEndpoint:'/auth/guest-transfer/write'}:{})});
    const saves=f.calls.filter(c=>!c.path.endsWith('/seed'));assert.equal(saves.length,1);
    assert.equal(saves[0].path,who===guest?'/auth/guest-transfer/write':'/api/jobs/job/ui-state');
    assert.deepEqual(saves[0].body,who===guest?{jobId:'job',...write}:write);
    assert.deepEqual(JSON.parse(f.storage.get(journalKey)!),{pending:{},cleared:false});
    assert.equal(JSON.parse(f.storage.get(key(who))!).draft,'');
  }finally{f.stop();}
});
