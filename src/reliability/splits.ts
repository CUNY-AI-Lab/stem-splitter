import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { archiveContentType, ArchiveError, fetchArchiveAudio, fetchArchiveItem, parseArchiveIdentifier } from '../archive.ts';
import { parseYouTubeVideoId, pollYouTubeImport, startYouTubeImport, replicateConfiguration, CAIL_IMPORT_BYTES, YouTubeError } from '../youtube.ts';
import { getBackend, type SeparationResult } from '../separation/index.ts';
import { getSeparationOptions, modelIsAllowed, getReplicateRunner, replicateVersion } from '../separation/options.ts';
import { presignDownload, presignAnalysisDownload } from '../r2.ts';
import { serverAutoCapability, configuredAudioAnalysisProvider, resolveAutoRoutingWithSource, audioAnalysisTimeoutMs, AUTO_ROUTING_REQUEST, prepareAuthoritativeAutoSource } from '../analysis/index.ts';
import { parseBrowserAutoSummary } from '../analysis/contract.ts';
import { processingFeatureFlags } from '../features.ts';
import { authorizeStoredCourseWork, courseAssignmentStatement } from '../classroom/access.ts';
import { beginAttempt, finishAttempt, fingerprint, OperationError, readOperation, reserveOperation, TERMINAL, type Operation } from './ledger.ts';
import { claimNext, recoverExpired, transition, WORK_LEASE_MS } from './queue.ts';
import { cooldown, setCooldown, UpstreamError } from './retry.ts';

const MAX_BYTES=100*1024*1024;
interface SplitInput {
  sourceType: 'upload'|'youtube'|'archive'; key?: string; filename: string; youtubeUrl?: string;
  archiveId?: string; archiveFile?: string; model: string; auto: boolean; browserAnalysis?: unknown;
}
type Complete = (env: Env, jobId: string, result: SeparationResult) => Promise<void>;
const title=(value: unknown) => typeof value==='string' ? value.replace(/[\x00-\x1f\x7f/\\]/g,' ').trim().slice(0,200) : '';
export const operationWebhook=(env: Env,id: string,phase: 'fetch'|'split') => `${env.PUBLIC_BASE_URL}/api/webhooks/separation?job=${id}&phase=${phase}&token=${env.WEBHOOK_SECRET}`;

export async function submitSplit(env: Env, principal: AppPrincipal, body: unknown, key: string | undefined) {
  if (env.SPLIT_STARTS_DISABLED==='true') throw new OperationError('splits_paused',503,'New splits are temporarily paused. Saved audio still plays.');
  if (!body || typeof body!=='object'||Array.isArray(body)) throw new OperationError('invalid_input',400,'Choose an audio file or a supported source.');
  const value=body as Record<string,unknown>;
  const courseId=principal.courseId ?? null;
  if (courseId && value.coursePolicy!=='course-work-v1') throw new OperationError('course_policy_required',400,'Review the course sharing notice before submitting.');
  const options=getSeparationOptions(env.SEPARATION_BACKEND), submitted=value.model ?? options.defaultModel;
  const capability=serverAutoCapability(env);
  const auto=Boolean(capability&&(submitted===AUTO_ROUTING_REQUEST||value.routingRequest===AUTO_ROUTING_REQUEST));
  if (typeof submitted!=='string'||(submitted===AUTO_ROUTING_REQUEST ? !auto||capability?.mode!=='authoritative' : !modelIsAllowed(env.SEPARATION_BACKEND,submitted))) throw new OperationError('invalid_model',400,'Choose an available split model.');
  const input: SplitInput={sourceType:'upload',filename:'Audio',model:submitted===AUTO_ROUTING_REQUEST?options.defaultModel:submitted,auto};
  if (auto) input.browserAnalysis=parseBrowserAutoSummary(value.browserAnalysis,options.models);
  if ([value.youtubeUrl,value.archiveId,value.key].filter(v=>v!==undefined).length!==1) throw new OperationError('invalid_input',400,'Choose exactly one audio source.');
  if (value.youtubeUrl!==undefined) {
    const id=parseYouTubeVideoId(value.youtubeUrl as string);
    if (!id) throw new OperationError('invalid_youtube_url',400,'Paste a full YouTube video link.');
    if(!replicateConfiguration(env))throw new OperationError('youtube_unconfigured',503,'YouTube import is temporarily unavailable. Upload an original or licensed audio file.');
    input.sourceType='youtube'; input.youtubeUrl=`https://www.youtube.com/watch?v=${id}`; input.filename='YouTube audio';
  } else if (value.archiveId!==undefined) {
    const id=typeof value.archiveId==='string'&&parseArchiveIdentifier(value.archiveId);
    if (!id||value.archiveFile!==undefined&&(typeof value.archiveFile!=='string'||value.archiveFile.length>1024)) throw new OperationError('invalid_archive_id',400,'Choose an available Archive audio file.');
    input.sourceType='archive';input.archiveId=id;input.archiveFile=value.archiveFile as string|undefined;input.filename='Archive audio';
  } else {
    if (typeof value.key!=='string'||!/^uploads\/[a-zA-Z0-9-]+\/[^/]+$/.test(value.key)||!title(value.filename)) throw new OperationError('invalid_upload',400,'Choose and upload an audio file.');
    const owned=await env.DB.prepare("SELECT 1 FROM upload_owners WHERE object_key=? AND subject=? AND state='ready' AND expires_at>?")
      .bind(value.key,principal.subject,new Date().toISOString()).first();
    const source=owned&&await env.AUDIO.head(value.key);
    if (!source) throw new OperationError('upload_not_found',404,'The upload is unavailable. Upload it again.');
    if (source.size<=0||source.size>MAX_BYTES) throw new OperationError('invalid_upload',400,'The upload is empty or too large. Upload it again.');
    input.key=value.key;input.filename=title(value.filename);
  }
  const id=crypto.randomUUID();
  return reserveOperation(env.DB,{subject:principal.subject,courseId,kind:'split',key:key ?? '',fingerprint:await fingerprint(input),phase:input.sourceType==='upload'?'split':'fetch',jobId:id,request:input,
    statements: opId=>{
      const statements=[env.DB.prepare(`INSERT INTO jobs(id,filename,source_key,status,model,source_type)
        SELECT id,?,?,'queued',?,? FROM app_operations WHERE id=?`)
        .bind(input.filename,input.key ?? `uploads/${id}/source.m4a`,input.model,input.sourceType,opId),
        env.DB.prepare('INSERT INTO job_owners(job_id,subject) SELECT id,subject FROM app_operations WHERE id=?').bind(opId)];
      const course=courseAssignmentStatement(env,id,principal);
      if (course) statements.push(course);
      return statements;
    }});
}

async function fail(env: Env, op: Operation, code: string, message='This split could not finish. No successful-split allowance was used. Try another source or upload an original or licensed audio file.') {
  await env.DB.batch([
    env.DB.prepare(`UPDATE app_operations SET error_code=? WHERE id=? AND fence=? AND state NOT IN (${TERMINAL})`).bind(code,op.id,op.fence),
    env.DB.prepare(`UPDATE jobs SET status='failed',error=? WHERE id=? AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND state NOT IN (${TERMINAL}))`).bind(message,op.job_id,op.id,op.fence),
  ]);
}
async function imported(env: Env,op: Operation,input: SplitInput,audio: {data:ArrayBuffer;title:string;fileName?:string;attribution?:unknown}) {
  if (!audio.data.byteLength||audio.data.byteLength>MAX_BYTES) throw new YouTubeError('Audio is empty or too large.','invalid_audio_response');
  const hash=await crypto.subtle.digest('SHA-256',audio.data);
  const sha=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const extension=audio.fileName?.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '.m4a';
  const key=`uploads/${op.id}/source-${op.fence}${extension}`;
  await env.AUDIO.put(key,audio.data,{httpMetadata:{contentType:audio.fileName?archiveContentType(audio.fileName):'audio/mp4'}});
  const current=await readOperation(env.DB,op.id);
  if (!current||current.fence!==op.fence||current.cancel_requested||['failed','cancelled'].includes(current.state)) {
    await env.AUDIO.delete(key);if(current)await fail(env,current,'cancelled');return;
  }
  input.key=key;input.filename=title(audio.title)||input.filename;
  await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET source_key=?,source_hash=?,filename=?,status='queued' WHERE id=? AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND cancel_requested=0 AND state NOT IN (${TERMINAL}))`).bind(key,sha,input.filename,op.job_id,op.id,op.fence),
    env.DB.prepare(`UPDATE app_operations SET request_json=?,provider_id=NULL,phase='split',state='queued',lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND fence=? AND cancel_requested=0 AND state NOT IN (${TERMINAL})`).bind(JSON.stringify(input),Date.now(),op.id,op.fence),
    ...(audio.attribution?[env.DB.prepare(`INSERT OR REPLACE INTO job_attributions(job_id,attribution) SELECT ?,? WHERE EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND cancel_requested=0 AND state NOT IN (${TERMINAL}))`).bind(op.job_id,JSON.stringify(audio.attribution),op.id,op.fence)]:[]),
  ]);
  const saved=await env.DB.prepare('SELECT source_key FROM jobs WHERE id=?').bind(op.job_id).first<{source_key:string}>();
  if(saved?.source_key!==key)await env.AUDIO.delete(key);
}
async function storeArchive(env: Env,op: Operation,input: SplitInput) {
  const scope=await fingerprint([op.subject,op.course_id]),source=await fingerprint([input.archiveId,input.archiveFile]);
  // Every cache hit revalidates the public rights floor with Archive metadata.
  await fetchArchiveItem(input.archiveId!);
  const cached=await env.DB.prepare('SELECT object_key,metadata_json FROM import_cache WHERE scope=? AND source=? AND expires_at>? AND object_key IS NOT NULL')
    .bind(scope,source,Date.now()).first<{object_key:string;metadata_json:string}>();
  if (cached) {
    const object=await env.AUDIO.get(cached.object_key);
    if (object && object.size<=MAX_BYTES) { await imported(env,op,input,{...JSON.parse(cached.metadata_json),data:await object.arrayBuffer()});return; }
  }
  const audio=await fetchArchiveAudio(input.archiveId!,input.archiveFile,env,{maximumBytes:CAIL_IMPORT_BYTES});
  await imported(env,op,input,audio);
  const current=await readOperation(env.DB,op.id);
  if (current?.phase==='split'&&input.key) await env.DB.prepare(`INSERT INTO import_cache(scope,source,operation_id,object_key,metadata_json,expires_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(scope,source) DO UPDATE SET operation_id=excluded.operation_id,object_key=excluded.object_key,metadata_json=excluded.metadata_json,expires_at=excluded.expires_at`)
    .bind(scope,source,op.id,input.key,JSON.stringify({title:audio.title,fileName:audio.fileName,attribution:audio.attribution}),op.created_at+24*60*60*1000).run();
}

async function start(env: Env,op: Operation) {
  const input=JSON.parse(op.request_json) as SplitInput;
  try { await authorizeStoredCourseWork(env,op.subject,op.course_id); }
  catch { await fail(env,op,'access_unavailable','Course access could not be confirmed. No successful-split allowance was used.');return; }
  if (op.cancel_requested) {await fail(env,op,'cancelled');return;}
  if (op.phase==='fetch'&&input.sourceType==='archive') {
    try {await storeArchive(env,op,input);} catch {await fail(env,op,'archive_import_failed');}return;
  }
  let attempt: string | null=null;
  try {
    let sourceUrl='';let model=input.model;
    if (op.phase==='split') {
      let sourceKey=input.key!;
      const capability=serverAutoCapability(env);
      if (input.auto&&capability) {
        const options=getSeparationOptions(env.SEPARATION_BACKEND);
        let expectedSourceBytes: number | undefined;
        if (input.sourceType==='upload'&&capability.mode==='authoritative') {
          const snapshot=await prepareAuthoritativeAutoSource(env,{jobId:op.id,sourceKey});sourceKey=snapshot.snapshotKey;expectedSourceBytes=snapshot.bytes;
        }
        const stored=await env.DB.prepare('SELECT source_hash FROM jobs WHERE id=?').bind(op.job_id).first<{source_hash:string|null}>();
        const head=stored?.source_hash?await env.AUDIO.head(sourceKey):null;
        const resolution=await resolveAutoRoutingWithSource({sourceUrl:await presignAnalysisDownload(env,sourceKey),sourceType:input.sourceType,mode:capability.mode,currentModel:model,fallbackModel:options.defaultModel,coreModels:options.models,
          ...(input.browserAnalysis?{browserAnalysis:parseBrowserAutoSummary(input.browserAnalysis,options.models)}:{}),
          ...(stored?.source_hash&&head?{expectedSourceIdentity:{schemaVersion:'1' as const,sha256:stored.source_hash,bytes:head.size}}:{}),
          ...(expectedSourceBytes!==undefined?{expectedSourceBytes}:{}),
          provider:configuredAudioAnalysisProvider(env),timeoutMs:audioAnalysisTimeoutMs(env),instrumentDiscovery:processingFeatureFlags(env).instrumentDiscovery});
        model=resolution.decision.resolvedCoreModel;
        await env.DB.prepare('UPDATE jobs SET model=?,routing_request=?,analysis=?,source_key=? WHERE id=?').bind(model,AUTO_ROUTING_REQUEST,JSON.stringify(resolution.decision),sourceKey,op.job_id).run();
      }
      sourceUrl=await presignDownload(env,sourceKey);
    }
    // This write precedes every paid POST. A crash from here reconciles, never retries.
    if (!await transition(env.DB,op,'starting')) return;
    const runner=getReplicateRunner(model);
    const version=op.phase==='fetch'?env.REPLICATE_YT_MODEL_VERSION:runner?replicateVersion(env,runner):undefined;
    attempt=await beginAttempt(env.DB,op,'replicate',version);
    const providerId=op.phase==='fetch'
      ? await startYouTubeImport(input.youtubeUrl!,env,operationWebhook(env,op.id,op.phase as 'fetch'|'split'))
      : (await getBackend(env).start({jobId:op.id,audioUrl:sourceUrl,webhookUrl:operationWebhook(env,op.id,op.phase as 'fetch'|'split'),model})).externalId;
    await finishAttempt(env.DB,attempt,'accepted',{externalId:providerId});
    if (await transition(env.DB,op,'processing',{providerId})) {
      await env.DB.prepare('UPDATE app_operations SET lease_owner=NULL,lease_until=0 WHERE id=? AND fence=?').bind(op.id,op.fence).run();
      await env.DB.prepare('UPDATE jobs SET status=?,external_id=? WHERE id=? AND status<>\'failed\'')
        .bind(op.phase==='fetch'?'importing':'processing',op.phase==='fetch'?null:providerId,op.job_id).run();
    }
  } catch(error) {
    if (attempt) await finishAttempt(env.DB,attempt,error instanceof UpstreamError?error.outcome:'uncertain',{
      code:error instanceof UpstreamError?error.code:'start_uncertain',status:error instanceof UpstreamError?error.status:undefined});
    if (!attempt) {await fail(env,op,'preparation_failed');return;}
    if (error instanceof UpstreamError&&error.outcome==='rejected') {
      const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM operation_attempts WHERE operation_id=? AND phase=?').bind(op.id,op.phase).first<{n:number}>();
      if (error.status===429) await setCooldown(env.DB,'replicate',error.notBefore);
      if (error.status===429&&(count?.n ?? 0)<3&&error.notBefore<op.deadline) {
        await transition(env.DB,op,'queued',{notBefore:error.notBefore,code:error.code});
        return;
      }
      await fail(env,op,error.code);return;
    }
    await transition(env.DB,op,'reconciling',{code:'start_uncertain'});
    await env.DB.prepare("UPDATE jobs SET status='reconciling' WHERE id=? AND status<>'failed'").bind(op.job_id).run();
  }
}

export async function reconcileSplit(env: Env,op: Operation,complete: Complete) {
  if (!op.provider_id||!['processing','reconciling'].includes(op.state)) return;
  const now=Date.now(),owner=crypto.randomUUID();
  const claimed=await env.DB.prepare(`UPDATE app_operations SET lease_owner=?,lease_until=?,fence=fence+1,updated_at=?
    WHERE id=? AND fence=? AND lease_until<=? AND not_before<=? AND state IN ('processing','reconciling') RETURNING *`)
    .bind(owner,now+WORK_LEASE_MS,now,op.id,op.fence,now,now).first<Operation>();
  if(!claimed)return;
  try {
    if (claimed.phase==='fetch') {
      const audio=await pollYouTubeImport(claimed.provider_id!,env);
      if(audio)await imported(env,claimed,JSON.parse(claimed.request_json),audio);
    } else {
      const result=await getBackend(env).fetchStatus(claimed.provider_id!);
      if(result.status!=='processing') {
        if(claimed.cancel_requested)await fail(env,claimed,'cancelled','Split cancelled. No successful-split allowance was used.');
        else await complete(env,claimed.job_id!,result);
      }
    }
  } catch(error) {
    if(error instanceof YouTubeError||error instanceof ArchiveError) await fail(env,claimed,error.code);
    else if(error instanceof UpstreamError&&error.notBefore) await setCooldown(env.DB,'replicate',error.notBefore);
    // Provider/storage outage retains the exact prediction, never creates another.
  } finally {
    await env.DB.prepare('UPDATE app_operations SET lease_owner=NULL,lease_until=0,not_before=? WHERE id=? AND fence=?')
      .bind(Math.max(now+5000,await cooldown(env.DB,'replicate')),claimed.id,claimed.fence).run();
  }
}
export async function drainSplitQueue(env: Env,complete: Complete) {
  if(env.AUTH_MODE!=='cail')return;
  await recoverExpired(env.DB);
  const active=await env.DB.prepare("SELECT * FROM app_operations WHERE kind='split' AND state IN ('processing','reconciling') AND provider_id IS NOT NULL AND not_before<=? ORDER BY updated_at LIMIT 4")
    .bind(Date.now()).all<Operation>();
  for(const op of active.results)await reconcileSplit(env,op,complete);
  if(env.SPLIT_STARTS_DISABLED==='true')return;
  for(const phase of ['fetch','split'] as const) {const op=await claimNext(env.DB,phase);if(op)await start(env,op);}
}

export async function recoverCallback(env: Env,operation: Operation,externalId: string) {
  if(operation.provider_id||!['starting','reconciling'].includes(operation.state))return;
  // A capability is unique to the operation AND phase. The accepted prediction
  // must also match the exact model version recorded before its paid POST.
  const attempt=await env.DB.prepare(`SELECT id,model FROM operation_attempts WHERE operation_id=? AND phase=?
    AND provider='replicate' AND outcome IN ('starting','uncertain') ORDER BY created_at DESC LIMIT 1`)
    .bind(operation.id,operation.phase).first<{id:string;model:string|null}>();
  if(!attempt?.model)return;
  if(!await getBackend(env).confirmStart?.(externalId,operationWebhook(env,operation.id,operation.phase as 'fetch'|'split'),attempt.model))return;
  await finishAttempt(env.DB,attempt.id,'accepted',{externalId});
  const accepted=await env.DB.prepare(`UPDATE app_operations SET provider_id=?,state='processing',lease_until=0,lease_owner=NULL,updated_at=?
    WHERE id=? AND fence=? AND phase=? AND provider_id IS NULL AND state IN ('starting','reconciling')`)
    .bind(externalId,Date.now(),operation.id,operation.fence,operation.phase).run();
  if(accepted.meta.changes&&operation.phase==='split')await env.DB.prepare("UPDATE jobs SET external_id=?,status='processing' WHERE id=? AND status NOT IN ('done','failed')").bind(externalId,operation.job_id).run();
}
