import { Buffer } from 'node:buffer';
import { createBrowserDeadline } from './youtube-deadline.mjs';
import puppeteer from '@cloudflare/puppeteer';
import { createCapturedUmpCollector } from './youtube-ump.mjs';

const BODY_LIMIT=8*1024*1024, TOTAL_LIMIT=96*1024*1024;
export const sanitizeSourceTitle=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').replace(/\s+/g,' ').trim().slice(0,300):'';
export class AcquisitionError extends Error {constructor(code){super(code);this.code=code;}}
function playerState(){
 const p=window.ytInitialPlayerResponse,v=document.querySelector('video');
 const status=p?.playabilityStatus?.status, rawDuration=p?.videoDetails?.lengthSeconds;
 const reason=JSON.stringify(p?.playabilityStatus||{}),text=(document.body?.innerText||'').slice(0,250000);
 return {title:typeof p?.videoDetails?.title==='string'?p.videoDetails.title.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').replace(/\s+/g,' ').trim().slice(0,300):'',videoId:typeof p?.videoDetails?.videoId==='string'?p.videoDetails.videoId:null,
  durationSeconds:typeof rawDuration==='string'&&/^\d+$/.test(rawDuration)?Number(rawDuration):null,
  playability:['OK','ERROR','UNPLAYABLE','LOGIN_REQUIRED','LIVE_STREAM_OFFLINE','CONTENT_CHECK_REQUIRED','AGE_CHECK_REQUIRED'].includes(status)?status:'UNKNOWN',
  live:Boolean(p?.videoDetails?.isLive||p?.videoDetails?.isUpcoming||p?.playabilityStatus?.liveStreamability),
  bot:/confirm you(?:'re| are|’re) not a bot|verify (?:that )?you(?:'re| are|’re) (?:a )?human|unusual traffic|complete (?:the |a )?captcha|access denied/i.test(text+' '+reason),
  restricted:['LOGIN_REQUIRED','AGE_CHECK_REQUIRED','CONTENT_CHECK_REQUIRED'].includes(status)||/sign in to (?:confirm|watch)|log in to (?:watch|view)|private video|video is (?:unavailable|restricted)/i.test(text+' '+reason),
  videoPresent:Boolean(v),paused:v?.paused??null,readyState:v?.readyState??0,
  mediaDuration:v&&Number.isFinite(v.duration)?v.duration:null,mediaErrorCode:v?.error?.code??null,
  adShowing:Boolean(document.querySelector('#movie_player.ad-showing'))};
}

/** One standard browser session; only normal pause/seek properties change playback. */
export async function acquireYouTubeAudio(env,{videoId,deadline=Date.now()+120000},runtime={}){
 const now=runtime.now||Date.now,setTimer=runtime.setTimer||setTimeout,clearTimer=runtime.clearTimer||clearTimeout;
 const pause=runtime.pause||(ms=>new Promise(resolve=>setTimer(resolve,ms)));
 const launch=runtime.launch||(binding=>puppeteer.launch(binding));
 if(typeof videoId!=='string'||!/^[A-Za-z0-9_-]{11}$/.test(videoId))throw new AcquisitionError('invalid_video_id');
 const until=Math.min(deadline,now()+120000);
 if(!Number.isFinite(until)||until<=now())throw new AcquisitionError('candidate_contract_invalid');
 let browser,page,cdp,closing,finished=false,failure,collector;
 let captureChain=Promise.resolve(),pendingCaptures=0,responseCount=0,receivedBytes=0,capturedBytes=0,bodyCount=0;
 let enableCapture;const metadataReady=new Promise(resolve=>{enableCapture=resolve;});
 const requests=new Map(),receipt={browserClosed:false,browserLaunched:false,pageStatus:null,seeks:0,metadataDurationSeconds:null};
 const close=()=>{if(!browser)return Promise.resolve();return closing??=browser.close().then(()=>{receipt.browserClosed=true;}).catch(()=>{});};
 const scope=createBrowserDeadline(until,{now,setTimer,clearTimer,onExpire:close});
 const time=()=>{if(scope.expired()||now()>=until)throw new AcquisitionError('source_timeout');};
 const awaited=(operation,onLate)=>scope.run(operation,onLate);
 const deny=code=>{failure??=new AcquisitionError(code);void close();};
 let output,terminalError;
 try{
  browser=await awaited(()=>launch(env.BROWSER),lateBrowser=>{browser=lateBrowser;receipt.browserLaunched=true;return close();});receipt.browserLaunched=true;time();
  page=await awaited(()=>browser.newPage());cdp=await awaited(()=>page.createCDPSession());await awaited(()=>cdp.send('Network.enable'));
  cdp.on('Network.responseReceived',event=>{
   if(finished)return;
   let host;try{host=new URL(event.response.url).hostname;}catch{return;}
   if(!(host==='googlevideo.com'||host.endsWith('.googlevideo.com')))return;
   if(event.response.status>=400){deny([401,403,451].includes(event.response.status)?'source_access_refused':'media_response_failed');return;}
   if(String(event.response.mimeType||'').split(';',1)[0].toLowerCase()!=='application/vnd.yt-ump')return;
   responseCount++;if(responseCount>256){deny('response_count_limit');return;}
   if(![200,206].includes(event.response.status)){deny([401,403,451].includes(event.response.status)?'source_access_refused':'media_response_failed');return;}
   requests.set(event.requestId,{bytes:0});
  });
  cdp.on('Network.dataReceived',event=>{
   if(finished)return;const record=requests.get(event.requestId);if(!record||!Number.isFinite(event.dataLength))return;
   record.bytes+=event.dataLength;receivedBytes+=event.dataLength;
   if(record.bytes>BODY_LIMIT||receivedBytes>TOTAL_LIMIT)deny('capture_limit_exceeded');
  });
  cdp.on('Network.loadingFinished',event=>{
   if(finished||failure||!requests.has(event.requestId))return;
   pendingCaptures++;
   // Serialize body retrieval and parsing, dropping each raw response after consume().
   captureChain=captureChain.then(async()=>{
    try{
     await awaited(()=>metadataReady);if(finished||failure||!collector)return;time();
     const body=await awaited(()=>cdp.send('Network.getResponseBody',{requestId:event.requestId}));
     if(typeof body.body!=='string'||body.body.length>11184812)throw new AcquisitionError('capture_limit_exceeded');
     if(body.base64Encoded?(body.body.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.body)):Buffer.byteLength(body.body,'utf8')>BODY_LIMIT)throw new AcquisitionError('capture_limit_exceeded');
     const bytes=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');
     if(!bytes.length||bytes.length>BODY_LIMIT||bytes.length>TOTAL_LIMIT-capturedBytes)throw new AcquisitionError('capture_limit_exceeded');
     capturedBytes+=bytes.length;bodyCount++;collector.consume(bytes);
    }catch(error){
     if(finished)return;
     const parserCode=typeof error?.code==='string'?error.code:'';
     if(/^[a-z_]{1,48}$/.test(parserCode))receipt.parserCode=parserCode;
     deny(scope.expired()||parserCode==='source_timeout'?'source_timeout':error instanceof AcquisitionError?error.code:parserCode==='audio_bound'?'audio_too_large':parserCode==='fixture_mismatch'?'source_fixture_mismatch':parserCode.startsWith('source_protection')||parserCode==='protected_or_video_track'?'source_restricted':'audio_invalid');
    }finally{pendingCaptures--;}
   });
  });
  const navigation=await awaited(()=>page.goto(`https://www.youtube.com/watch?v=${videoId}`,{waitUntil:'domcontentloaded',timeout:Math.min(20000,Math.max(1,until-now()))}));
  receipt.pageStatus=navigation?.status()??null;
  const location=new URL(page.url());
  if(location.hostname!=='www.youtube.com'||location.pathname!=='/watch'||location.searchParams.get('v')!==videoId)throw new AcquisitionError('unexpected_navigation');
  if([401,403,451].includes(receipt.pageStatus))throw new AcquisitionError('source_access_refused');
  if(receipt.pageStatus!==200)throw new AcquisitionError('source_http_failure');
  let lastProgressAt=now(),lastContiguous=0,lastSeekAt=0,lastSeekTarget=-1;
  while(now()<until){
   time();if(failure)throw failure;
   const state=await awaited(()=>page.evaluate(playerState));if(failure)throw failure;time();
   if(state.bot)throw new AcquisitionError('source_security_refusal');
   if(state.restricted)throw new AcquisitionError('source_restricted');
   if(state.live)throw new AcquisitionError('live_stream');
   if(state.playability!=='OK'&&state.playability!=='UNKNOWN')throw new AcquisitionError('source_unplayable');
   if(state.mediaErrorCode)throw new AcquisitionError('player_media_error');
   if(state.adShowing)throw new AcquisitionError('source_advertisement');
   if(state.playability==='OK'){
    if(state.videoId!==videoId)throw new AcquisitionError('source_fixture_mismatch');
    if(!Number.isSafeInteger(state.durationSeconds)||state.durationSeconds<=0||state.durationSeconds>900)throw new AcquisitionError('duration_invalid');
    if(!collector){
     receipt.metadataDurationSeconds=state.durationSeconds;receipt.title=sanitizeSourceTitle(state.title);
     if(!receipt.title)throw new AcquisitionError('player_metadata_unavailable');
     collector=createCapturedUmpCollector({videoId,durationMs:state.durationSeconds*1000,maximumAudioBytes:12*1024*1024});
     enableCapture();lastProgressAt=now();
    }else if(state.durationSeconds!==receipt.metadataDurationSeconds)throw new AcquisitionError('source_metadata_changed');
    if(state.videoPresent&&!state.paused)await awaited(()=>page.evaluate(()=>{document.querySelector('video')?.pause();}));
    const progress=collector.progress();
    receipt.contiguousDurationMs=progress.contiguousDurationMs;receipt.retainedAudioBytes=progress.retainedAudioBytes;
    if(progress.contiguousDurationMs>lastContiguous){lastContiguous=progress.contiguousDurationMs;lastProgressAt=now();}
    if(progress.complete){output=collector.result();if(output)break;}
    const stalled=now()-lastProgressAt;
    if(stalled>=10000)throw new AcquisitionError('buffering_stalled');
    if(state.videoPresent&&state.readyState>=1&&pendingCaptures===0&&stalled>=1500&&now()-lastSeekAt>=1000){
     const next=progress.nextMissingStartMs;
     if(!Number.isFinite(next)||next<0||next>=state.durationSeconds*1000)throw new AcquisitionError('audio_incomplete');
     const target=Math.min(next/1000+0.025,state.durationSeconds-0.05);
     if(Math.abs(target-lastSeekTarget)>0.001){
      if(receipt.seeks>=64)throw new AcquisitionError('seek_limit');
      if(failure)throw failure;time();
      const applied=await awaited(()=>page.evaluate(targetSeconds=>{const video=document.querySelector('video');if(!video||!Number.isFinite(video.duration)||targetSeconds<0||targetSeconds>=video.duration)return false;video.pause();video.currentTime=targetSeconds;return true;},target));
      if(!applied)throw new AcquisitionError('player_seek_unavailable');
      receipt.seeks++;lastSeekAt=now();lastSeekTarget=target;
     }
    }
   }else if(now()-lastProgressAt>=10000)throw new AcquisitionError('player_metadata_unavailable');
   await awaited(()=>pause(Math.min(500,Math.max(0,until-now()))));
  }
  time();if(!output)throw new AcquisitionError('audio_incomplete');
 }catch(error){terminalError=failure|| (error instanceof AcquisitionError?error:new AcquisitionError(scope.expired()||error?.code==='source_timeout'?'source_timeout':'browser_acquisition_failed'));}
 finally{
  finished=true;enableCapture();scope.dispose();
  await Promise.race([close(),pause(5000)]);
  receipt.umpResponseCount=responseCount;receipt.completedResponseCount=bodyCount;receipt.observedBytes=receivedBytes;receipt.capturedBytes=capturedBytes;
 }
 if(browser&&!receipt.browserClosed)terminalError=new AcquisitionError('browser_cleanup_unconfirmed');
 if(terminalError){terminalError.receipt=receipt;throw terminalError;}
 return {audio:output,receipt};
}
