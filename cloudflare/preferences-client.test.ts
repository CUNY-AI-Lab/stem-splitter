import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
const alice='cail-'+'a'.repeat(32),bob='cail-'+'b'.repeat(32),guest='guest-'+'c'.repeat(64);
const cache=(actor=alice)=>`stem-preferences:v1:${actor}`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await tick();}assert.ok(check());}
function fixture(initial:Record<string,string>={},handler?:any) {
 const storage=new Map(Object.entries(initial)),calls:any[]=[],remote:any={},timers=new Set<any>();
 const reply=(body:any,actor=alice,status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-Stem-Account':actor}});
 const fetch=async(path:string,options:any={})=>{
  const call={path,...options,body:options.body?JSON.parse(options.body):null};calls.push(call);
  if(handler)return handler(call,reply,remote);
  const actor=options.headers['X-Stem-Account'];
  if(options.method==='POST') { const accepted=[];for(const record of call.body.records){if(!remote[record.kind])remote[record.kind]={value:record.value,revision:1};accepted.push({kind:record.kind,outcome:'applied',revision:1});}return reply({accepted},actor); }
  if(options.method==='PUT') { remote[call.body.kind]={value:call.body.value,revision:call.body.baseRevision+1};return reply({kind:call.body.kind,outcome:'applied',revision:call.body.baseRevision+1},actor); }
  return reply({actor,preferences:remote},actor);
 };
 const context:any={crypto:webcrypto,TextEncoder,AbortController,AbortSignal,fetch,localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)},
 setTimeout:(fn:any,ms:number)=>{const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);return id;},clearTimeout:(id:any)=>{timers.delete(id);clearTimeout(id);}};
 context.window=context;context.StemFetch=fetch;vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/preferences.js',import.meta.url),'utf8'),context);
 return {api:context.StemPreferences,context,storage,calls,remote,reply,stop(){context.StemPreferences.stop();for(const id of timers)clearTimeout(id);}};
}
const pending=(value:any='htdemucs_ft',baseRevision=1)=>({requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseRevision,value});

test('five-family legacy seed excludes metadata; server clear wins over stale model',async()=>{
 const rotation={revision:2,seen:['album/a.mp3'],last:'album/a.mp3',pass:1,order:['album/a.mp3']};
 const f=fixture({'stem-split-choice-v1':'htdemucs_ft',benchTab:'remixer','stem-song-rotation-v1':JSON.stringify(rotation),[`stem-workspace-choice:v1:${alice}`]:'course-a',[`jobs:${alice}`]:JSON.stringify([{id:'one',collapsed:true,filename:'not uploaded',stems:['private']}])});f.remote.modelChoice={value:null,revision:4};
 try {await f.api.start(alice);assert.equal(f.api.get('modelChoice'),null);const records=f.calls.filter(c=>c.method==='POST').flatMap(c=>c.body.records);assert.deepEqual(records.map((r:any)=>r.kind).sort(),['benchTab','classChoice','rackLayout','sampleRotation']);assert.deepEqual(records.find((r:any)=>r.kind==='rackLayout').value,{entries:[{jobId:'one',collapsed:true,rank:0}],suppressedJobIds:[]});assert.equal(f.storage.get('benchTab'),'remixer');}finally{f.stop();}
});

test('explicit clear is journaled, acknowledged, and survives reload',async()=>{
 const f=fixture();f.remote.modelChoice={value:'htdemucs_ft',revision:2};
 try {await f.api.start(alice);f.api.set('modelChoice',null);assert.equal(f.api.get('modelChoice'),null);await f.api.flush();assert.equal(f.calls.find(c=>c.method==='PUT').body.baseRevision,2);await f.api.start(alice);assert.equal(f.api.get('modelChoice'),null);assert.deepEqual(JSON.parse(f.storage.get(cache())!).pending,{});}finally{f.stop();}
});

test('late read preserves new input and its captured revision',async()=>{
 let release:any;const blocked=new Promise(resolve=>release=resolve);let reads=0;
 const f=fixture({},async(call:any,reply:any)=>{if(!call.method&&++reads===1)return blocked;if(call.method==='PUT')return reply({kind:call.body.kind,outcome:'conflict',revision:5},alice,409);return reply({actor:alice,preferences:{modelChoice:{value:'remote',revision:5}}});});
 try {const start=f.api.start(alice);await until(()=>f.calls.length===1);f.api.set('modelChoice','local');release(f.reply({actor:alice,preferences:{modelChoice:{value:'remote',revision:5}}}));await start;assert.equal(f.api.get('modelChoice'),'local');await f.api.flush();assert.equal(f.calls.find(c=>c.method==='PUT').body.baseRevision,0);assert.equal(f.api.get('modelChoice'),'remote');}finally{f.stop();}
});

test('switched actor rejects old reads and never copies another namespace',async()=>{
 let release:any;const blocked=new Promise(resolve=>release=resolve);
 const f=fixture({[cache(alice)]:JSON.stringify({records:{classChoice:{value:'private-class',revision:1}},pending:{}})},async(call:any,reply:any)=>call.headers['X-Stem-Account']===alice?blocked:reply({actor:bob,preferences:{}},bob));
 try {const old=f.api.start(alice);await until(()=>f.calls.length===1);await f.api.start(bob);release(f.reply({actor:alice,preferences:{classChoice:{value:'private-class',revision:1}}}));await old;assert.equal(f.api.get('classChoice'),undefined);assert.ok(!f.calls.some(c=>c.headers['X-Stem-Account']===bob&&JSON.stringify(c.body).includes('private-class')));}finally{f.stop();}
});

for(const [status,body] of [[409,{error:{code:'preference_request_reused'}}],[200,null],[200,{kind:'benchTab',outcome:'applied',revision:2}],[200,{kind:'modelChoice',outcome:'applied',revision:-1}],[200,{kind:'modelChoice',outcome:'conflict',revision:2}],[409,{kind:'modelChoice',outcome:'applied',revision:2}]])test(`malformed acknowledgement ${status}/${JSON.stringify(body)} preserves journal`,async()=>{
 const original=JSON.stringify({records:{},pending:{modelChoice:pending()}}),f=fixture({[cache(guest)]:original},(call:any,reply:any)=>reply(body,guest,status as number));
 try {await f.api.seed(guest,{writeEndpoint:'/auth/guest-transfer/preferences/write'});assert.equal(f.storage.get(cache(guest)),original);}finally{f.stop();}
});

test('source clear uses exact guest context and never drains member pending state',async()=>{
 const f=fixture({[cache(guest)]:JSON.stringify({records:{},pending:{modelChoice:pending(null)}}),[cache(alice)]:JSON.stringify({records:{},pending:{classChoice:pending('member-course')}})},(call:any,reply:any)=>reply(call.path.endsWith('/write')?{kind:call.body.kind,outcome:'applied',revision:2}:{accepted:[]},guest));
 try {await f.api.seed(guest,{endpoint:'/auth/guest-transfer/preferences/seed',writeEndpoint:'/auth/guest-transfer/preferences/write'});assert.ok(f.calls.every(c=>c.headers['X-Stem-Account']===guest));assert.equal(f.calls[0].body.value,null);assert.deepEqual(JSON.parse(f.storage.get(cache(guest))!).pending,{});assert.ok(JSON.parse(f.storage.get(cache(alice))!).pending.classChoice);}finally{f.stop();}
});

test('aborted response never acknowledges source write',async()=>{
 const initial=JSON.stringify({records:{},pending:{modelChoice:pending()}}),controller=new AbortController();
 const f=fixture({[cache()]:initial},(call:any,reply:any)=>{controller.abort();return reply({kind:call.body.kind,outcome:'applied',revision:2},alice);});
 try {await f.api.seed(alice,{signal:controller.signal});assert.equal(f.storage.get(cache()),initial);}finally{f.stop();}
});

test('newer edit during a write follows only its proven acknowledged revision',async()=>{
 let release:any;const blocked=new Promise(resolve=>release=resolve);let writes=0;
 const f=fixture({},async(call:any,reply:any,remote:any)=>{if(call.method==='PUT'){if(++writes===1)return blocked;return reply({kind:call.body.kind,outcome:'applied',revision:call.body.baseRevision+1});}return reply({actor:alice,preferences:remote});});
 try {await f.api.start(alice);f.api.set('modelChoice','one');const first=f.api.flush();await until(()=>writes===1);f.api.set('modelChoice','two');release(f.reply({kind:'modelChoice',outcome:'applied',revision:1}));await first;assert.equal(f.api.get('modelChoice'),'two');await f.api.flush();assert.equal(f.calls.filter(c=>c.method==='PUT')[1].body.baseRevision,1);}finally{f.stop();}
});

test('blocked storage retains usable memory without inferring acknowledgement',async()=>{
 const f=fixture();f.context.localStorage.setItem=()=>{throw new Error('quota');};
 try {await f.api.start(alice);f.api.set('benchTab','remixer');await f.api.flush();assert.equal(f.api.get('benchTab'),'remixer');assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);}finally{f.stop();}
});

test('every shipped sample filename remains a valid rotation key',()=>{
 const f=fixture(),tracks=JSON.parse(readFileSync(new URL('../public/search-samples.json',import.meta.url),'utf8'));
 try {const order=tracks.map((track:any)=>`${track.archiveId}/${track.archiveFile}`);assert.equal(f.api.valid('sampleRotation',{revision:1,seen:order,last:order.at(-1),pass:1,order}),true);}finally{f.stop();}
});

test('another tab pending write is not erased by a stale acknowledgement',async()=>{
 let release:any;const blocked=new Promise(resolve=>release=resolve);
 const f=fixture({},(call:any,reply:any)=>call.method==='PUT'?blocked:reply({actor:alice,preferences:{}}));
 try {await f.api.start(alice);f.api.set('modelChoice','first');const saving=f.api.flush();await until(()=>f.calls.some(c=>c.method==='PUT'));
 const later={requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',baseRevision:0,value:'second'};f.storage.set(cache(),JSON.stringify({records:{},pending:{modelChoice:later,benchTab:pending('remixer',0)}}));
 release(f.reply({kind:'modelChoice',outcome:'applied',revision:1}));await saving;
 assert.deepEqual(JSON.parse(f.storage.get(cache())!).pending.modelChoice,later);assert.ok(JSON.parse(f.storage.get(cache())!).pending.benchTab);
 }finally{f.stop();}
});

test('oversized rotation cannot block smaller source preferences',async()=>{
 const order=Array.from({length:64},(_,i)=>`album/${String(i).padStart(2,'0')}${'x'.repeat(490)}.mp3`),rotation={revision:1,seen:order,last:order[0],pass:1,order};
 const f=fixture({'stem-song-rotation-v1':JSON.stringify(rotation),benchTab:'splitter','stem-split-choice-v1':'htdemucs_ft'});
 try {await f.api.seed(alice);const records=f.calls.filter(c=>c.method==='POST').flatMap(c=>c.body.records);assert.deepEqual(records.map((r:any)=>r.kind).sort(),['benchTab','modelChoice']);assert.equal(f.storage.get('stem-song-rotation-v1'),JSON.stringify(rotation));}finally{f.stop();}
});

test('stalled source slot does not prevent other pending slots being attempted',async()=>{
 let release:any;const blocked=new Promise(resolve=>release=resolve);
 const f=fixture({[cache()]:JSON.stringify({records:{},pending:{classChoice:pending('course',0),benchTab:pending('splitter',0)}})},(call:any,reply:any)=>call.body.kind==='classChoice'?blocked:reply(call.body.kind?{kind:call.body.kind,outcome:'applied',revision:1}:{accepted:[]}));
 try {const copying=f.api.seed(alice);await until(()=>f.calls.some(c=>c.body.kind==='benchTab'));release(f.reply({error:'outage'},alice,503));await copying;assert.ok(JSON.parse(f.storage.get(cache())!).pending.classChoice);assert.equal(JSON.parse(f.storage.get(cache())!).pending.benchTab,undefined);}finally{f.stop();}
});

test('exact claim flushes guest receipts under both identities and filters the later missing-only seed',async()=>{
 const original=JSON.stringify({records:{rackLayout:{value:{entries:[{jobId:'claimed',collapsed:true,rank:0},{jobId:'unclaimed',collapsed:false,rank:1}],suppressedJobIds:['another-unclaimed']},revision:1}},pending:{modelChoice:pending(null)}});
 const f=fixture({[cache(guest)]:original,'stem-split-choice-v1':'unattributed-global-choice'},(call:any,reply:any)=>{
  if(call.path.endsWith('/write'))return new Response(JSON.stringify({actor:guest,kind:call.body.kind,outcome:'applied',revision:2}),{headers:{'X-Stem-Account':alice,'X-Stem-Guest-Account':guest}});
  return reply({accepted:[]});
 });
 try {await f.api.claim(alice,guest,['claimed']);const write=f.calls[0];assert.equal(write.headers['X-Stem-Account'],guest);assert.equal(write.headers['X-Stem-Claim-Actor'],alice);assert.equal(write.body.value,null);
 const seeds=f.calls.filter(c=>c.path.endsWith('/seed'));assert.ok(seeds.every(c=>c.headers['X-Stem-Account']===alice));const records=seeds.flatMap(c=>c.body.records);assert.equal(records.find((r:any)=>r.kind==='modelChoice').value,null);assert.deepEqual(records.find((r:any)=>r.kind==='rackLayout').value,{entries:[{jobId:'claimed',collapsed:true,rank:0}],suppressedJobIds:[]});assert.ok(!JSON.stringify(records).includes('unattributed'));assert.deepEqual(JSON.parse(f.storage.get(cache(guest))!).pending,{});
 }finally{f.stop();}
});

for(const headers of [{'X-Stem-Account':alice},{'X-Stem-Account':bob,'X-Stem-Guest-Account':guest},{'X-Stem-Account':alice,'X-Stem-Guest-Account':'guest-'+'d'.repeat(64)}])test('claim acknowledgement requires both exact identities '+JSON.stringify(headers),async()=>{
 const original=JSON.stringify({records:{},pending:{modelChoice:pending(null)}}),f=fixture({[cache(guest)]:original},()=>new Response(JSON.stringify({actor:guest,kind:'modelChoice',outcome:'applied',revision:2}),{headers}));
 try {await f.api.claim(alice,guest,[]);assert.equal(f.storage.get(cache(guest)),original);assert.equal(f.calls.length,1);}finally{f.stop();}
});

test('member base0 pending choice is acknowledged before guest claim can install defaults',async()=>{
 const events:string[]=[],f=fixture({[cache()]:JSON.stringify({records:{},pending:{modelChoice:pending('member-choice',0)}})},(call:any,reply:any)=>{
  if(call.path==='/api/account/claim-guest'){events.push('claim');return reply({claimedJobIds:[],guestStorageKey:`jobs:${guest}`});}
  if(call.method==='PUT'){events.push('member-write');return reply({kind:'modelChoice',outcome:'applied',revision:1});}
  return reply({accepted:[]});
 });
 try {vm.runInContext(readFileSync(new URL('../public/guest-claim.js',import.meta.url),'utf8'),f.context);
 await f.context.StemGuestClaim.run({subject:alice,quotaClass:'member'});assert.deepEqual(events,['member-write','claim']);assert.deepEqual(JSON.parse(f.storage.get(cache())!).pending,{});
 }finally{f.stop();}
});

for(const value of [null,'retained-choice'])test(`expired server slot restarts retained ${value===null?'clear':'choice'} with a fresh create receipt`,async()=>{
 const original=pending(value,7),f=fixture({[cache()]:JSON.stringify({records:{modelChoice:{value:'old',revision:7}},pending:{modelChoice:original}})});
 try {await f.api.start(alice);const queued=JSON.parse(f.storage.get(cache())!).pending.modelChoice;
 assert.equal(queued.value,value);assert.equal(queued.baseRevision,0);assert.notEqual(queued.requestId,original.requestId);
 await f.api.flush();const sent=f.calls.find(c=>c.method==='PUT');assert.deepEqual(sent.body,{kind:'modelChoice',...queued});assert.deepEqual(f.remote.modelChoice,{value,revision:1});assert.deepEqual(JSON.parse(f.storage.get(cache())!).pending,{});
 }finally{f.stop();}
});

for(const invalid of ['wrong-header','wrong-body','malformed-slots'])test(`unverified absence ${invalid} cannot rebase an expired pending clear`,async()=>{
 const original=JSON.stringify({records:{modelChoice:{value:'old',revision:7}},pending:{modelChoice:pending(null,7)}});
 const f=fixture({[cache()]:original},(call:any,reply:any)=>reply({actor:invalid==='wrong-body'?bob:alice,preferences:invalid==='malformed-slots'?[]:{}},invalid==='wrong-header'?bob:alice));
 try {await f.api.start(alice);assert.equal(f.storage.get(cache()),original);}finally{f.stop();}
});

test('absence read preserves a newer local pending value instead of restoring its captured predecessor',async()=>{
 let release:any,reads=0;const blocked=new Promise(resolve=>release=resolve),original=pending('old-local',7);
 const f=fixture({[cache()]:JSON.stringify({records:{modelChoice:{value:'old-server',revision:7}},pending:{modelChoice:original}})},async(call:any,reply:any)=>{
  if(!call.method&&++reads===1)return blocked;
  if(call.method==='PUT')return reply({kind:call.body.kind,outcome:'applied',revision:call.body.baseRevision+1});
  return reply({actor:alice,preferences:{}});
 });
 try {const started=f.api.start(alice);await until(()=>f.calls.length===1);
 const newer={requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',baseRevision:7,value:'new-local'};
 f.storage.set(cache(),JSON.stringify({records:{},pending:{modelChoice:newer}}));release(f.reply({actor:alice,preferences:{}}));await started;
 assert.equal(f.api.get('modelChoice'),'new-local');await f.api.flush();assert.equal(f.calls.find(c=>c.method==='PUT').body.value,'new-local');assert.equal(f.calls.find(c=>c.method==='PUT').body.baseRevision,0);
 }finally{f.stop();}
});

test('a competing server create after verified absence still wins the rebased CAS conflict',async()=>{
 let remote:any={};
 const f=fixture({[cache()]:JSON.stringify({records:{},pending:{modelChoice:pending(null,7)}})},(call:any,reply:any)=>{
  if(call.method==='PUT')return reply({kind:call.body.kind,outcome:'conflict',revision:1},alice,409);
  return reply({actor:alice,preferences:remote});
 });
 try {await f.api.start(alice);remote={modelChoice:{value:'competing-choice',revision:1}};await f.api.flush();
 assert.equal(f.calls.find(c=>c.method==='PUT').body.baseRevision,0);assert.equal(f.api.get('modelChoice'),'competing-choice');assert.deepEqual(JSON.parse(f.storage.get(cache())!).pending,{});
 }finally{f.stop();}
});

test('an open session rechecks an exact missing-slot conflict and retries its clear only after verified absence',async()=>{
 let remote:any={modelChoice:{value:'old-choice',revision:7}};
 const f=fixture({},(call:any,reply:any)=>{
  if(call.method==='PUT') {
   if(call.body.baseRevision>0)return reply({kind:'modelChoice',outcome:'conflict',revision:null},alice,409);
   remote={modelChoice:{value:call.body.value,revision:1}};return reply({kind:'modelChoice',outcome:'applied',revision:1});
  }
  return reply({actor:alice,preferences:remote});
 });
 try {await f.api.start(alice);f.api.set('modelChoice',null);const before=JSON.parse(f.storage.get(cache())!).pending.modelChoice;remote={};
 await f.api.flush();const retained=JSON.parse(f.storage.get(cache())!).pending.modelChoice;
 assert.equal(retained.value,null);assert.equal(retained.baseRevision,0);assert.notEqual(retained.requestId,before.requestId);
 await new Promise(resolve=>setTimeout(resolve,350));await until(()=>f.calls.filter(c=>c.method==='PUT').length===2);
 assert.deepEqual(f.calls.filter(c=>c.method==='PUT').map(c=>c.body.baseRevision),[7,0]);assert.equal(remote.modelChoice.value,null);assert.deepEqual(JSON.parse(f.storage.get(cache())!).pending,{});
 }finally{f.stop();}
});
