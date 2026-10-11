import test from 'node:test';
import assert from 'node:assert/strict';
import { CompositeBuffer, UmpWriter } from 'googlevideo/ump';
import { UMPPartId as P, FormatInitializationMetadata as F, MediaHeader as H } from 'googlevideo/protos';
import { acquireYouTubeAudio, sanitizeSourceTitle } from './youtube-acquisition.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const id='jNQXAC9IVRw';
// Synthetic UMP framing and clear Opus track initialization; no private source media.
const element=(hex,payload)=>Buffer.concat([Buffer.from(hex,'hex'),Buffer.from([128+payload.length]),payload]);
const init=Buffer.concat([element('1a45dfa3',element('4282',Buffer.from('webm'))),Buffer.from('18538067ff','hex'),
 element('1654ae6b',element('ae',Buffer.concat([element('83',Buffer.from([2])),element('86',Buffer.from('A_OPUS'))])))]);
const media=[Buffer.from('1f43b675880000000000000000','hex'),Buffer.from('1f43b675880000000000000001','hex')];
const audioKey={itag:251,lastModified:'123456',xtags:''};
const parts=[[P.FORMAT_INITIALIZATION_METADATA,F.encode({videoId:id,formatId:audioKey,mimeType:'audio/webm; codecs="opus"',
 endTimeMs:'19000',endSegmentNumber:'2',durationUnits:'19000',durationTimescale:'1000'}).finish()]];
for(const [sequence,data] of [init,...media].entries()){
 parts.push([P.MEDIA_HEADER,H.encode({headerId:0,videoId:id,formatId:audioKey,itag:251,lmt:'123456',xtags:'',isInitSeg:sequence===0,
  sequenceNumber:sequence,startMs:String(sequence===2?10000:0),durationMs:String(sequence===0?0:sequence===1?10000:9000),contentLength:String(data.length)}).finish()],
 [P.MEDIA,Buffer.concat([Buffer.from([0]),data])],[P.MEDIA_END,Buffer.from([0])]);
}
const body=new CompositeBuffer(),writer=new UmpWriter(body);
for(const [type,data] of parts)writer.write(type,data);
const bytes=Buffer.concat(body.chunks),expectedAudio=Buffer.concat([init,...media]);
const metadata={title:'  Original\u0000 title\u0085 \n '+ 'x'.repeat(350),videoId:id,durationSeconds:19,playability:'OK',live:false,bot:false,restricted:false,videoPresent:true,paused:true,readyState:4,mediaDuration:19,mediaErrorCode:null,adShowing:false};
const never=()=>new Promise(()=>{});
function fixture({hang,denial=false}={}){
 const handlers=new Map();let closes=0,bodyReads=0,evaluations=0;
 const cdp={on:(name,fn)=>handlers.set(name,fn),send:async name=>{
  if(name===hang)return never();
  if(name==='Network.getResponseBody'){bodyReads++;return{body:Buffer.from(bytes).toString('base64'),base64Encoded:true};}
 }};
 const emit=(name,data)=>handlers.get(name)?.(data);
 const page={createCDPSession:async()=>hang==='createCDPSession'?never():cdp,url:()=>`https://www.youtube.com/watch?v=${id}`,
  goto:async()=>{
   if(hang==='goto')return never();
   emit('Network.responseReceived',{requestId:'fixture',response:{url:'https://media.googlevideo.com/videoplayback',mimeType:denial?'text/html':'application/vnd.yt-ump',status:denial?403:200}});
   if(!denial){emit('Network.dataReceived',{requestId:'fixture',dataLength:bytes.length});emit('Network.loadingFinished',{requestId:'fixture'});}
   return{status:()=>200};
  },evaluate:async()=>{evaluations++;if(hang==='evaluate')return never();return metadata;}};
 const browser={newPage:async()=>hang==='newPage'?never():page,close:async()=>{closes++;}};
 return {browser,counts:()=>({closes,bodyReads,evaluations})};
}
const runtime=launch=>({launch,pause:ms=>pause(Math.min(ms,1))});

test('a hung launch returns at the deadline without starting page work',async()=>{
 const start=Date.now();await assert.rejects(acquireYouTubeAudio({}, {videoId:id,deadline:Date.now()+25},runtime(never)),error=>error.code==='source_timeout');
 assert.ok(Date.now()-start<500);
});
test('a browser acquired after timeout is closed as soon as it becomes available',async()=>{
 const f=fixture();let resolve;
 const task=acquireYouTubeAudio({}, {videoId:id,deadline:Date.now()+25},runtime(()=>new Promise(done=>{resolve=done;})));
 await assert.rejects(task,error=>error.code==='source_timeout');resolve(f.browser);await pause(5);assert.equal(f.counts().closes,1);
});
for(const stage of ['newPage','createCDPSession','Network.enable','goto','evaluate','Network.getResponseBody']){
 test(`deadline covers a hung ${stage} and closes the browser`,async()=>{
  const f=fixture({hang:stage}),start=Date.now();
  await assert.rejects(acquireYouTubeAudio({}, {videoId:id,deadline:Date.now()+30},runtime(async()=>f.browser)),error=>error.code==='source_timeout'&&error.receipt.browserClosed===true);
  assert.equal(f.counts().closes,1);assert.ok(Date.now()-start<500);
 });
}
test('successful passive acquisition preserves full audio and sanitizes source title',async()=>{
 const f=fixture();const result=await acquireYouTubeAudio({}, {videoId:id,deadline:Date.now()+1000},runtime(async()=>f.browser));
 assert.equal(result.audio.mimeType,'audio/webm');assert.equal(result.audio.data.length,expectedAudio.length);assert.deepEqual(Buffer.from(result.audio.data),expectedAudio);assert.equal(result.receipt.browserClosed,true);
 assert.equal(result.receipt.seeks,0);assert.equal(result.receipt.title.length,300);assert.ok(result.receipt.title.startsWith('Original title '));assert.doesNotMatch(result.receipt.title,/[\u0000-\u001f\u007f-\u009f]/);
 assert.equal(f.counts().bodyReads,1);assert.equal(f.counts().closes,1);
});
test('a non-UMP source denial stops before body capture or player manipulation',async()=>{
 const f=fixture({denial:true});
 await assert.rejects(acquireYouTubeAudio({}, {videoId:id,deadline:Date.now()+1000},runtime(async()=>f.browser)),error=>error.code==='source_access_refused'&&error.receipt.browserClosed===true);
 assert.equal(f.counts().bodyReads,0);assert.equal(f.counts().evaluations,0);assert.equal(f.counts().closes,1);
});
test('title sanitizer bounds controls and non-string inputs',()=>{
 assert.equal(sanitizeSourceTitle(null),'');assert.equal(sanitizeSourceTitle('\u0000a\tb\u009f'),'ab');assert.equal(sanitizeSourceTitle('x'.repeat(301)).length,300);
});
