import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { fingerprint, safeEventCode } from './ledger.ts';

export const CLIENT_USAGE_TYPES=['session_start','page_view','playback_start','playback_stop','seek','download_intent'] as const;
type ClientType=typeof CLIENT_USAGE_TYPES[number];
export interface ClientUse { id:string; type:ClientType; jobId?:string; durationMs?:number; positionBucket?:number; }
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(v);
export function parseClientUses(value:unknown):ClientUse[]|null {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='events'))return null;
  const events=(value as {events?:unknown}).events;
  if(!Array.isArray(events)||events.length<1||events.length>10)return null;
  for(const event of events) {
    if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).some(k=>!['id','type','jobId','durationMs','positionBucket'].includes(k)))return null;
    if(!identifier(event.id)||!CLIENT_USAGE_TYPES.includes(event.type))return null;
    if(event.jobId!==undefined&&(typeof event.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(event.jobId)))return null;
    if(['playback_start','playback_stop','seek','download_intent'].includes(event.type)&&!event.jobId)return null;
    if(event.durationMs!==undefined&&(!Number.isSafeInteger(event.durationMs)||event.durationMs<0||event.durationMs>86400000))return null;
    if(event.positionBucket!==undefined&&(!Number.isSafeInteger(event.positionBucket)||event.positionBucket<0||event.positionBucket>90))return null;
  }
  return events;
}
function actorClass(principal?:AppPrincipal) {
  return !principal?'anonymous':(principal as AppPrincipal&{quotaClass?:string}).quotaClass==='guest'?'guest':'member';
}
async function actorKey(principal:AppPrincipal|undefined,now:number) {
  // Rotating daily pseudonym bounds abusive logging without recording identity.
  return fingerprint(['usage-actor-v1',new Date(now).toISOString().slice(0,10),principal?.subject??'anonymous']);
}
interface Use {id:string;type:string;jobId?:string;source:'client'|'server';outcome:string;code?:string;status?:number;durationMs?:number;positionBucket?:number;}
async function persist(db:D1Database,principal:AppPrincipal|undefined,events:Use[],now=Date.now()) {
  const actor=await actorKey(principal,now),kind=actorClass(principal),day=Math.floor(now/86400000)*86400000;
  const statements=await Promise.all(events.map(async e=>db.prepare(`INSERT OR IGNORE INTO usage_events
    (event_id,actor_key,actor_class,event_type,source,job_id,outcome,code,http_status,duration_ms,position_bucket,at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE
    (?='server' OR (SELECT COUNT(*) FROM usage_events WHERE actor_key=? AND source='client' AND at>=?)<?)
    AND (SELECT COUNT(*) FROM usage_events WHERE at>=?)<25000`)
    .bind(await fingerprint(['usage-v1',principal?.subject??'anonymous',e.id,e.type]),actor,kind,e.type,e.source,e.jobId??null,e.outcome,
      safeEventCode(e.code),e.status??null,e.durationMs??null,e.positionBucket??null,now,e.source,actor,day,kind==='guest'?250:500,day)));
  await db.batch(statements);
}
export async function recordClientUses(db:D1Database,principal:AppPrincipal,events:ClientUse[]) {
  await persist(db,principal,events.map(e=>({...e,source:'client',outcome:'observed'})));
}
/** A diagnostic failure must not alter the response or expose private errors.
 * Critical lifecycle/attempt receipts instead use transactional SQL triggers. */
export async function recordServerUse(env:Env,request:Request,response:Response,principal:AppPrincipal|undefined,started:number) {
  if(env.AUTH_MODE!=='cail')return;
  const url=new URL(request.url),path=url.pathname;
  const split=path==='/api/jobs'&&request.method==='POST';
  const chat=/^\/api\/jobs\/[^/]+\/chat$/.test(path)&&request.method==='POST';
  const guide=/^\/api\/jobs\/[^/]+\/guide$/.test(path)&&request.method==='POST';
  const annotation=/^\/api\/jobs\/[^/]+\/annotations(?:\/[^/]+)?$/.test(path)&&!['GET','HEAD'].includes(request.method);
  const download=/^\/api\/(?:files\/stems\/|shared-jobs\/)/.test(path)&&url.searchParams.has('download')&&request.method==='GET';
  if(!(split||chat||guide||annotation||download))return;
  // Accepted operations already have a durable created event. Only request
  // rejection is added here; retries with the same operation key coalesce.
  if((split||chat||guide)&&response.status<400)return;
  const type=split?'split_request':chat?'chat_request':guide?'guide_request':annotation?(request.method==='DELETE'?'annotation_delete':'annotation_save'):'download';
  const supplied=request.headers.get('Idempotency-Key');
  const key=(identifier(supplied)?supplied:crypto.randomUUID())+':'+response.status;
  const job=/^\/api\/(?:jobs\/|files\/stems\/|shared-jobs\/)([a-zA-Z0-9_-]{1,80})(?:\/|$)/.exec(path)?.[1];
  try {
    let code:unknown;
    if(response.status>=400&&response.headers.get('content-type')?.includes('application/json')) {
      const data=await response.clone().json() as {code?:unknown;error?:{code?:unknown}};
      code=data.code??(typeof data.error==='object'?data.error?.code:undefined);
    }
    await persist(env.DB,principal,[{id:key,type,source:'server',jobId:principal?job:undefined,outcome:response.status<400?'accepted':'failed',
      code:safeEventCode(code)??(response.status>=400?'request_rejected':undefined),status:response.status,durationMs:Math.max(0,Math.min(86400000,Date.now()-started))}]);
  } catch {console.warn(JSON.stringify({event:'usage_record_failed',type}));}
}
export async function usageSummary(db:D1Database,days:number) {
  const since=Date.now()-days*86400000;
  const [uses,operations]=await Promise.all([
    db.prepare(`SELECT event_type,source,actor_class,outcome,code,http_status,COUNT(*) AS count,ROUND(AVG(duration_ms)) AS mean_duration_ms
      FROM usage_events WHERE at>=? GROUP BY event_type,source,actor_class,outcome,code,http_status ORDER BY count DESC LIMIT 250`).bind(since).all(),
    db.prepare(`SELECT event_type,kind,phase,state,code,model,fallback,quota_effect,COUNT(*) AS count,ROUND(AVG(duration_ms)) AS mean_duration_ms
      FROM operation_events WHERE at>=? GROUP BY event_type,kind,phase,state,code,model,fallback,quota_effect ORDER BY count DESC LIMIT 250`).bind(since).all(),
  ]);
  return {days,retentionDays:30,clientCapture:'best_effort',uses:uses.results??[],operations:operations.results??[]};
}
export async function recordPageUse(env:Env,response:Response) {
  if(env.AUTH_MODE!=='cail')return;
  try {await persist(env.DB,undefined,[{id:crypto.randomUUID(),type:'page_response',source:'server',outcome:response.ok?'accepted':'failed',status:response.status}]);}
  catch {console.warn(JSON.stringify({event:'usage_record_failed',type:'page_response'}));}
}
