import { dispatchOutput, outputProgress, settleStoppedOutput } from './output.ts';
import { parseMediaUrl } from '../url-source.ts';
import { durationIsAllowed } from '../import-policy.ts';
import type { Env } from '../env.ts';
import { cancelReplicatePrediction } from '../separation/replicate.ts';
import { parseVideoSource } from '../video-source.ts';
import type { AppPrincipal } from '../identity.ts';
import { archiveAudioMetadata, archiveContentType, ArchiveError, fetchArchiveAudio, fetchArchiveItem, parseArchiveIdentifier, validateArchiveSongFrames } from '../archive.ts';
import { pollYouTubeImport, startVideoImport, replicateConfiguration, CAIL_IMPORT_BYTES, YouTubeError } from '../youtube.ts';
import { fetchVimeoAudio, vimeoFailureDiagnostic } from '../vimeo.ts';
import { importLinkViaService, linkImportEnabled } from '../link-import-client.ts';
import type { ImportResult } from '../link-import.ts';
import { getBackend, type SeparationResult } from '../separation/index.ts';
import { getSeparationOptions, modelIsAllowed, getReplicateRunner, replicateVersion, ADAPTIVE_FOUR_MODEL, adaptiveOutputEnabled } from '../separation/options.ts';
import { presignDownload, presignAnalysisDownload } from '../r2.ts';
import { serverAutoCapability, configuredAudioAnalysisProvider, resolveAutoRoutingWithSource, audioAnalysisTimeoutMs, AUTO_ROUTING_REQUEST, prepareAuthoritativeAutoSource } from '../analysis/index.ts';
import { parseBrowserAutoSummary } from '../analysis/contract.ts';
import { processingFeatureFlags } from '../features.ts';
import { authorizeStoredCourseWork, courseAssignmentStatement } from '../classroom/access.ts';
import { beginAttempt, finishAttempt, fingerprint, OperationError, readOperation, reserveOperation, TERMINAL, type Operation } from './ledger.ts';
import { claimNext, claimNativeImport, isOwnedSourceImport, recoverExpired, expireSplitOperations, transition, WORK_LEASE_MS } from './queue.ts';
import { logSplitError } from './error-log.ts';
import { cooldown, retryAt, setCooldown, UpstreamError } from './retry.ts';
import { activeGuest, ownershipTable } from '../guest/access.ts';
import { claimedOperationOwner, ownsClaimedOperation } from '../guest/claim.ts';

const MAX_BYTES=100*1024*1024;
interface SplitInput {
  sourceType: 'upload'|'youtube'|'vimeo'|'archive'|'audius'; key?: string; filename: string; videoUrl?: string; youtubeUrl?: string; audiusId?: string;
  archiveId?: string; archiveFile?: string; archiveSearch?: boolean; model: string; auto: boolean; browserAnalysis?: unknown;
  /** Selected by the trusted adapter when reserving a new operation. */
  browserAudio?: boolean;
  adaptive?: 4 | 'auto';
  /** Server-validated remote source; acquired as an app-owned upload snapshot. */
  remoteUrl?: string;
}
type Complete = (env: Env, jobId: string, result: SeparationResult,operation?:Operation) => Promise<void>;
const title=(value: unknown) => typeof value==='string' ? value.replace(/[\x00-\x1f\x7f/\\]/g,' ').trim().slice(0,200) : '';
export const operationWebhook=(env: Env,id: string,phase: 'fetch'|'split') => `${env.PUBLIC_BASE_URL}/api/webhooks/separation?job=${id}&phase=${phase}&token=${env.WEBHOOK_SECRET}`;

export async function submitSplit(env: Env, principal: AppPrincipal, body: unknown, key: string | undefined) {
  if (env.SPLIT_STARTS_DISABLED==='true') throw new OperationError('splits_paused',503,'New splits are temporarily paused. Saved audio still plays.');
  if (!body || typeof body!=='object'||Array.isArray(body)) throw new OperationError('invalid_input',400,'Choose an audio file or a supported source.');
  const value=body as Record<string,unknown>;
  const courseId=principal.courseId ?? null;
  if (courseId && value.coursePolicy!=='course-work-v1') throw new OperationError('course_policy_required',400,'Review the course sharing notice before submitting.');
  const adaptiveAvailable=adaptiveOutputEnabled(env);
  const options=getSeparationOptions(env.SEPARATION_BACKEND,adaptiveAvailable), submitted=value.model ?? options.defaultModel;
  const adaptive=adaptiveAvailable && (submitted===ADAPTIVE_FOUR_MODEL || submitted===AUTO_ROUTING_REQUEST)
    ? submitted===AUTO_ROUTING_REQUEST ? 'auto' as const : 4 as const : undefined;
  const capability=serverAutoCapability(env);
  const auto=Boolean(!adaptive&&capability&&(submitted===AUTO_ROUTING_REQUEST||value.routingRequest===AUTO_ROUTING_REQUEST));
  if (typeof submitted!=='string'||(submitted===AUTO_ROUTING_REQUEST ? !adaptive&&(!auto||capability?.mode!=='authoritative') : !modelIsAllowed(env.SEPARATION_BACKEND,submitted,adaptiveAvailable))) throw new OperationError('invalid_model',400,'Choose an available split model.');
  const input: SplitInput={sourceType:'upload',filename:'Audio',model:adaptive?'htdemucs_6s':submitted===AUTO_ROUTING_REQUEST?options.defaultModel:submitted,auto,...(adaptive?{adaptive}:{})};
  if (auto) input.browserAnalysis=parseBrowserAutoSummary(value.browserAnalysis,options.models);
  if ([value.sourceUrl,value.videoUrl,value.youtubeUrl,value.archiveId,value.audiusId,value.key].filter(v=>v!==undefined).length!==1) throw new OperationError('invalid_input',400,'Choose exactly one audio source.');
  if (value.sourceUrl !== undefined) {
    const url = parseMediaUrl(value.sourceUrl);
    if (!url) throw new OperationError('invalid_source_url',400,'Paste a public HTTPS media link.');
    if (env.URL_IMPORT_ENABLED !== 'true' || !replicateConfiguration(env)) throw new OperationError('url_import_unavailable',503,'URL import is temporarily unavailable. Upload an audio file.');
    const known = parseVideoSource(url);
    if (known?.sourceType === 'youtube' && typeof env.fetchYouTubeBrowserAudio === 'function') {
      input.sourceType='youtube'; input.youtubeUrl=known.canonicalUrl; input.filename='YouTube audio';
    } else if (known?.sourceType === 'vimeo') {
      input.sourceType='vimeo'; input.videoUrl=known.canonicalUrl; input.filename='Vimeo audio';
    } else { input.remoteUrl = url; input.filename = 'Imported audio'; }
  } else if (value.videoUrl!==undefined || value.youtubeUrl!==undefined) {
    const source=parseVideoSource(value.videoUrl!==undefined?value.videoUrl:value.youtubeUrl);
    if (!source) throw new OperationError('invalid_youtube_url',400,'Paste a supported video link.');
    const browserYouTube=source.sourceType==='youtube'&&typeof env.fetchYouTubeBrowserAudio==='function';
    if(source.sourceType==='youtube'&&!browserYouTube&&!replicateConfiguration(env))throw new OperationError('youtube_unconfigured',503,'Video import is temporarily unavailable. Upload an original or licensed audio file.');
    if(source.sourceType==='vimeo'||browserYouTube) {
      const runner=getReplicateRunner(input.model);
      if(!runner||!env.REPLICATE_API_TOKEN||!replicateVersion(env,runner))throw new OperationError('provider_configuration',503,'Audio separation is temporarily unavailable.');
    }
    input.sourceType=source.sourceType; input.filename=source.sourceType==='vimeo'?'Vimeo audio':'YouTube audio';
    // Keep existing YouTube operation fingerprints stable across this release.
    if(source.sourceType==='youtube')input.youtubeUrl=source.canonicalUrl;
    else input.videoUrl=source.canonicalUrl;
  } else if (value.audiusId!==undefined) {
    throw new OperationError('unsupported_source',400,'Search again to choose an Internet Archive recording.');
  } else if (value.archiveId!==undefined) {
    const id=typeof value.archiveId==='string'&&parseArchiveIdentifier(value.archiveId);
    if (!id||value.archiveFile!==undefined&&(typeof value.archiveFile!=='string'||value.archiveFile.length>1024)) throw new OperationError('invalid_archive_id',400,'Choose an available Archive audio file.');
    input.sourceType='archive';input.archiveId=id;input.archiveFile=value.archiveFile as string|undefined;input.filename='Archive audio';
    if(value.archiveSearch===true) {
      if(!input.archiveFile)throw new OperationError('invalid_archive_id',400,'Choose an available Archive audio file.');
      input.archiveSearch=true;
    }
  } else {
    if (typeof value.key!=='string'||!/^uploads\/[a-zA-Z0-9-]+\/[^/]+$/.test(value.key)||!title(value.filename)) throw new OperationError('invalid_upload',400,'Choose and upload an audio file.');
    const owned=await env.DB.prepare(`SELECT 1 FROM ${ownershipTable(principal,'upload')} WHERE object_key=? AND subject=? AND state='ready' AND expires_at>?`)
      .bind(value.key,principal.subject,new Date().toISOString()).first();
    const source=owned&&await env.AUDIO.head(value.key);
    if (!source) throw new OperationError('upload_not_found',404,'The upload is unavailable. Upload it again.');
    if (source.size<=0||source.size>MAX_BYTES) throw new OperationError('invalid_upload',400,'The upload is empty or too large. Upload it again.');
    input.key=value.key;input.filename=title(value.filename);
  }
  const requestFingerprint=await fingerprint(input);
  if(input.sourceType==='youtube'&&typeof env.fetchYouTubeBrowserAudio==='function')input.browserAudio=true;
  const id=crypto.randomUUID();
  return reserveOperation(env.DB,{subject:principal.subject,quotaClass:principal.quotaClass ?? 'member',role:principal.role,courseId,kind:'split',key:key ?? '',fingerprint:requestFingerprint,phase:input.sourceType==='upload'&&!input.remoteUrl?'split':'fetch',jobId:id,request:input,
    statements: opId=>{
      const statements=[env.DB.prepare(`INSERT INTO jobs(id,filename,source_key,status,model,source_type,routing_request)
        SELECT id,?,?,'queued',?,?,? FROM app_operations WHERE id=?`)
        .bind(input.filename,input.key ?? `uploads/${id}/source.m4a`,input.model,input.sourceType,input.adaptive?`adaptive:${input.adaptive}`:null,opId),
        env.DB.prepare(`INSERT INTO ${ownershipTable(principal,'job')}(job_id,subject) SELECT id,subject FROM app_operations WHERE id=?`).bind(opId)];
      const course=courseAssignmentStatement(env,id,principal);
      if (course) statements.push(course);
      return statements;
    }});
}

async function fail(env: Env, op: Operation, code: string, message='This split could not finish. No allowance was used. Try another source or upload an original or licensed audio file.') {
  await env.DB.batch([
    env.DB.prepare(`UPDATE app_operations SET error_code=? WHERE id=? AND fence=? AND state NOT IN (${TERMINAL})`).bind(code,op.id,op.fence),
    env.DB.prepare(`UPDATE jobs SET status='failed',error=? WHERE id=? AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND state NOT IN (${TERMINAL}))`).bind(message,op.job_id,op.id,op.fence),
  ]);
}
async function imported(env: Env,op: Operation,input: SplitInput,audio: {data:ArrayBuffer;title:string;fileName?:string;contentType?:'audio/webm'|'audio/mp4';attribution?:unknown;durationSec?:number}) {
  const maximum = op.quota_class === 'guest' ? 300 : 900;
  if (!durationIsAllowed(audio.durationSec,maximum)) throw new YouTubeError(`Audio exceeds your ${maximum/60}-minute import limit or has no valid duration.`, 'source_too_long');
  if (!audio.data.byteLength||audio.data.byteLength>MAX_BYTES) throw new YouTubeError('Audio is empty or too large.','invalid_audio_response');
  const hash=await crypto.subtle.digest('SHA-256',audio.data);
  const sha=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const extension=audio.fileName?.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '.m4a';
  const key=`uploads/${op.id}/source-${op.fence}${extension}`;
  await env.AUDIO.put(key,audio.data,{httpMetadata:{contentType:audio.contentType??(audio.fileName?archiveContentType(audio.fileName):'audio/mp4')}});
  await commitImported(env,op,input,{key,sha,title:audio.title,attribution:audio.attribution});
}
/** Hand a stored source to the split phase under the same fence, or remove it. */
async function commitImported(env: Env,op: Operation,input: SplitInput,stored: {key:string;sha:string;title:string;attribution?:unknown}) {
  const {key,sha}=stored;
  const current=await readOperation(env.DB,op.id);
  if (!current||current.fence!==op.fence||current.cancel_requested||['failed','cancelled'].includes(current.state)) {
    await env.AUDIO.delete(key);
    if(current?.fence===op.fence&&current.cancel_requested)await fail(env,op,'cancelled');
    return;
  }
  input.key=key;input.filename=title(stored.title)||input.filename;
  await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET source_key=?,source_hash=?,filename=?,status='queued' WHERE id=? AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND cancel_requested=0 AND state NOT IN (${TERMINAL}))`).bind(key,sha,input.filename,op.job_id,op.id,op.fence),
    env.DB.prepare(`UPDATE app_operations SET request_json=?,provider_id=NULL,phase='split',state='queued',error_code=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND fence=? AND cancel_requested=0 AND state NOT IN (${TERMINAL})`).bind(JSON.stringify(input),Date.now(),op.id,op.fence),
    ...(stored.attribution?[env.DB.prepare(`INSERT OR REPLACE INTO job_attributions(job_id,attribution) SELECT ?,? WHERE EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND cancel_requested=0 AND state NOT IN (${TERMINAL}))`).bind(op.job_id,JSON.stringify(stored.attribution),op.id,op.fence)]:[]),
  ]);
  const saved=await env.DB.prepare('SELECT source_key FROM jobs WHERE id=?').bind(op.job_id).first<{source_key:string}>();
  if(saved?.source_key!==key)await env.AUDIO.delete(key);
}
/** Direct and share links fetched by cail-stem-import. Returns false only when
 * the link needs the hosted ffmpeg importer (other containers, web pages). */
async function importLinkNatively(env: Env,op: Operation,input: SplitInput): Promise<boolean> {
  const maximum=op.quota_class==='guest'?300:900;
  const keyPrefix=`uploads/${op.id}/source-${op.fence}`;
  let result: ImportResult;
  try {
    // Finish inside the claim's lease so recovery never races a live import.
    result=await importLinkViaService(env,{url:input.remoteUrl!,keyPrefix,maximumSeconds:maximum,deadline:Math.min(op.deadline,op.lease_until-10_000)});
  } catch(error) {
    console.error(JSON.stringify({event:'link_import_unavailable',jobId:op.job_id,name:error instanceof Error?error.name:typeof error}));
    await fail(env,op,'link_import_unavailable','The link importer is unavailable right now. No allowance was used. Try again shortly or upload the file.');
    return true;
  }
  if (!result.ok) {
    if (result.hosted) return false;
    await fail(env,op,result.code,`${result.message} No allowance was used.`);
    return true;
  }
  if (!result.key.startsWith(`${keyPrefix}.`)||!durationIsAllowed(result.durationSec,maximum)||result.bytes<=0||result.bytes>MAX_BYTES||!/^[0-9a-f]{64}$/.test(result.sha256)) {
    if (result.key.startsWith(`${keyPrefix}.`)) await env.AUDIO.delete(result.key);
    await fail(env,op,'invalid_audio_response');
    return true;
  }
  await commitImported(env,op,input,{key:result.key,sha:result.sha256,title:result.title});
  return true;
}
async function storeArchive(env: Env,op: Operation,input: SplitInput) {
  const maximumSeconds=op.quota_class==='guest'?300:900;
  const scope=await fingerprint([op.subject,op.course_id]),source=await fingerprint([input.archiveId,input.archiveFile,input.archiveSearch===true]);
  // Every cache hit revalidates the public rights floor with Archive metadata.
  const item=await fetchArchiveItem(input.archiveId!,{publicAudio:input.archiveSearch===true,maximumSeconds});
  const track=input.archiveFile?item.tracks.find(track=>track.name===input.archiveFile):item.tracks.find(track=>track.importable);
  if(!track?.importable||track.bytes>CAIL_IMPORT_BYTES)throw new ArchiveError('Choose an available Archive audio file.', 'archive_file_unavailable');
  const cached=await env.DB.prepare('SELECT object_key,metadata_json FROM import_cache WHERE scope=? AND source=? AND expires_at>? AND object_key IS NOT NULL')
    .bind(scope,source,Date.now()).first<{object_key:string;metadata_json:string}>();
  if (cached) {
    const object=await env.AUDIO.get(cached.object_key);
    if (object && object.size===track.bytes && object.size<=CAIL_IMPORT_BYTES) {
      // Fresh metadata also corrects titles and credits cached before attribution was separated.
      const data=await new Response(object.body).arrayBuffer();
      validateArchiveSongFrames(data,track.durationSec,maximumSeconds);
      await imported(env,op,input,{...archiveAudioMetadata(item,track,input.archiveSearch===true),durationSec:track.durationSec,data});return;
    }
  }
  const audio=await fetchArchiveAudio(input.archiveId!,input.archiveFile,env,{maximumBytes:CAIL_IMPORT_BYTES,publicAudio:input.archiveSearch===true,maximumSeconds});
  await imported(env,op,input,audio);
  const current=await readOperation(env.DB,op.id);
  if (current?.fence===op.fence&&current.phase==='split'&&input.key) await env.DB.prepare(`INSERT INTO import_cache(scope,source,operation_id,object_key,metadata_json,expires_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(scope,source) DO UPDATE SET operation_id=excluded.operation_id,object_key=excluded.object_key,metadata_json=excluded.metadata_json,expires_at=excluded.expires_at`)
    .bind(scope,source,op.id,input.key,JSON.stringify({title:audio.title,fileName:audio.fileName,attribution:audio.attribution}),op.created_at+24*60*60*1000).run();
}

async function start(env: Env,op: Operation) {
  const input=JSON.parse(op.request_json) as SplitInput;
  try {
    if (op.quota_class === 'guest') {
      const owner = await claimedOperationOwner(env,op);
      if (owner) await authorizeStoredCourseWork(env,owner,null);
      else if (!env.guestRuntimeReady || op.course_id !== null || !await activeGuest(env.DB,op.subject)) throw new Error('Guest access ended');
    } else await authorizeStoredCourseWork(env,op.subject,op.course_id);
  }
  catch { await fail(env,op,'access_unavailable','Course access could not be confirmed. No allowance was used.');return; }
  if (op.cancel_requested) {await fail(env,op,'cancelled');return;}
  if (op.phase==='fetch'&&input.sourceType==='archive') {
    try {await storeArchive(env,op,input);} catch(error) {
      await fail(env,op,error instanceof ArchiveError?error.code:'archive_import_failed',
        error instanceof ArchiveError?`${error.message} No allowance was used.`:undefined);
    }return;
  }
  if (op.phase==='fetch'&&isOwnedSourceImport(input)) {
    // The owner's HTTP request awaits this import under the existing five-minute lease.
    // Reclaiming an interrupted source fetch preserves the separate GPU-start fence.
    try {
      const url=(input.videoUrl??input.youtubeUrl)!;
      if(input.sourceType==='audius') {
        await fail(env,op,'unsupported_source','Search again to choose an Internet Archive recording. No allowance was used.');
      } else if(input.sourceType==='youtube') {
        if(typeof env.fetchYouTubeBrowserAudio!=='function')throw new YouTubeError('Video import is temporarily unavailable.','youtube_fetch_unavailable');
        await imported(env,op,input,await env.fetchYouTubeBrowserAudio(url,{deadline:op.deadline}));
      } else await imported(env,op,input,await fetchVimeoAudio(url,{deadline:op.deadline,browser:env.AUTH_MODE==='cail'?env.BROWSER:undefined}));
    }
    catch(error) {
      if(input.sourceType==='youtube'&&input.browserAudio===true&&env.URL_IMPORT_ENABLED==='true'
        &&error instanceof YouTubeError&&['youtube_fetch_unavailable','youtube_fetch_timeout'].includes(error.code)
        &&replicateConfiguration(env)&&Date.now()+10000<op.deadline) {
        input.browserAudio=false;
        await env.DB.prepare("UPDATE app_operations SET request_json=?,state='queued',provider_id=NULL,error_code='browser_import_fallback',not_before=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND fence=? AND lease_owner=? AND cancel_requested=0 AND state='running'")
          .bind(JSON.stringify(input),Date.now()+5000,Date.now(),op.id,op.fence,op.lease_owner).run();
        return;
      }
      const diagnostic=vimeoFailureDiagnostic(error);
      if(diagnostic)console.error(JSON.stringify({event:'vimeo_import_failed',jobId:op.job_id,...diagnostic}));
      await fail(env,op,error instanceof YouTubeError?error.code:input.sourceType==='audius'?'music_unavailable':input.sourceType==='vimeo'?'vimeo_import_failed':'youtube_fetch_unavailable',
      error instanceof YouTubeError&&error.code==='source_too_long' ? error.message : error instanceof YouTubeError&&error.code==='audio_too_large'
        ?'This import exceeds the 12 MiB audio limit. No allowance was used. Try a shorter clip or upload an original or licensed file.':undefined);}
    return;
  }
  if (op.phase==='fetch'&&input.remoteUrl&&linkImportEnabled(env)&&await importLinkNatively(env,op,input)) return;
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
          const snapshot=await prepareAuthoritativeAutoSource(env,{jobId:op.id,sourceKey,allowExisting:true,isCurrent:async()=>{const current=await readOperation(env.DB,op.id);return current?.fence===op.fence&&current.lease_owner===op.lease_owner&&current.state==='running'&&!current.cancel_requested;}});sourceKey=snapshot.snapshotKey;expectedSourceBytes=snapshot.bytes;
        }
        const stored=await env.DB.prepare('SELECT source_hash FROM jobs WHERE id=?').bind(op.job_id).first<{source_hash:string|null}>();
        const head=stored?.source_hash?await env.AUDIO.head(sourceKey):null;
        const resolution=await resolveAutoRoutingWithSource({sourceUrl:await presignAnalysisDownload(env,sourceKey),sourceType:input.sourceType,mode:capability.mode,currentModel:model,fallbackModel:options.defaultModel,coreModels:options.models,
          ...(input.browserAnalysis?{browserAnalysis:parseBrowserAutoSummary(input.browserAnalysis,options.models)}:{}),
          ...(stored?.source_hash&&head?{expectedSourceIdentity:{schemaVersion:'1' as const,sha256:stored.source_hash,bytes:head.size}}:{}),
          ...(expectedSourceBytes!==undefined?{expectedSourceBytes}:{}),
          provider:configuredAudioAnalysisProvider(env),timeoutMs:audioAnalysisTimeoutMs(env),instrumentDiscovery:processingFeatureFlags(env).instrumentDiscovery});
        model=resolution.decision.resolvedCoreModel;
        const changed=await env.DB.prepare(`UPDATE jobs SET model=?,routing_request=?,analysis=?,source_key=? WHERE id=?
          AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND lease_owner IS ? AND cancel_requested=0 AND state='running')`).bind(model,AUTO_ROUTING_REQUEST,JSON.stringify(resolution.decision),sourceKey,op.job_id,op.id,op.fence,op.lease_owner).run();
        if(!changed.meta.changes)return;
      }
      sourceUrl=await presignDownload(env,sourceKey);
    }
    const runner=getReplicateRunner(model);
    const version=op.phase==='fetch'?env.REPLICATE_YT_MODEL_VERSION:runner?replicateVersion(env,runner):undefined;
    if(!version||!env.REPLICATE_API_TOKEN) {await fail(env,op,'provider_configuration','Audio separation is temporarily unavailable. No allowance was used.');return;}
    // This write precedes every paid POST. A crash from here reconciles, never retries.
    if (!await transition(env.DB,op,'starting')) return;
    attempt=await beginAttempt(env.DB,op,'replicate',version);
    const providerId=op.phase==='fetch'
      ? await startVideoImport((input.remoteUrl??input.videoUrl??input.youtubeUrl)!,env,operationWebhook(env,op.id,op.phase as 'fetch'|'split'), { generalUrl: Boolean(input.remoteUrl), maximumDurationSeconds: op.quota_class === 'guest' ? 300 : 900 })
      : (await getBackend(env).start({jobId:op.id,audioUrl:sourceUrl,webhookUrl:operationWebhook(env,op.id,op.phase as 'fetch'|'split'),model})).externalId;
    await finishAttempt(env.DB,attempt,'accepted',{externalId:providerId});
    if (await transition(env.DB,op,'processing',{providerId})) {
      await env.DB.prepare('UPDATE app_operations SET lease_owner=NULL,lease_until=0 WHERE id=? AND fence=?').bind(op.id,op.fence).run();
      await env.DB.prepare(`UPDATE jobs SET status=?,external_id=? WHERE id=? AND status NOT IN ('failed','done') AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND state='processing')`)
        .bind(op.phase==='fetch'?'importing':'processing',op.phase==='fetch'?null:providerId,op.job_id,op.id,op.fence).run();
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
    await env.DB.prepare("UPDATE jobs SET status='reconciling' WHERE id=? AND status NOT IN ('failed','done') AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND state='reconciling')").bind(op.job_id,op.id,op.fence).run();
  }
}

export async function reconcileSplit(env: Env,op: Operation,complete: Complete) {
  if (!['processing','reconciling'].includes(op.state)) return;
  if (outputProgress(op)) {
    if(op.cancel_requested || op.deadline<=Date.now())await settleStoppedOutput(env,op);
    else await dispatchOutput(env,op.id);
    return;
  }
  if (op.deadline<=Date.now()) {await expireSplitOperations(env.DB,Date.now(),op.id);return;}
  if (!op.provider_id) return;
  const now=Date.now(),owner=crypto.randomUUID();
  const claimed=await env.DB.prepare(`UPDATE app_operations SET lease_owner=?,lease_until=?,fence=fence+1,updated_at=?
    WHERE id=? AND fence=? AND lease_until<=? AND not_before<=? AND state IN ('processing','reconciling')
    AND (COALESCE((SELECT until_ms FROM provider_cooldowns WHERE provider='replicate'),0)<=?
      OR (phase='fetch' AND error_code='import_delivery_unavailable' AND deadline<=?)) RETURNING *`)
    .bind(owner,now+WORK_LEASE_MS,now,op.id,op.fence,now,now,now,now).first<Operation>();
  if(!claimed)return;
  let nextPollAt=now+5000;
  let stage: 'source_import' | 'provider_status' | 'output_ingest' = op.phase==='fetch'?'source_import':'provider_status';
  let deliveryAccepted=claimed.phase==='fetch'&&claimed.error_code==='import_delivery_unavailable';
  try {
    const canCancelProvider = claimed.phase === 'fetch' || (env.SEPARATION_BACKEND ?? 'replicate') === 'replicate';
    if (claimed.cancel_requested && canCancelProvider) {
      if (await cancelReplicatePrediction(env, claimed.provider_id!)) {
        await fail(env,claimed,'cancelled','Split cancelled. No allowance was used.');
      }
      return;
    }
    if (claimed.phase==='fetch') {
      // A prior delivery failure proves extraction finished. Its allowance can
      // expire locally even if subsequent status reads or provider cooldowns stall.
      if(deliveryAccepted&&now>=claimed.deadline) {await fail(env,claimed,'youtube_fetch_timeout');return;}
      const audio=await pollYouTubeImport(claimed.provider_id!,env,claimed.deadline);
      if(audio)await imported(env,claimed,JSON.parse(claimed.request_json),audio);
    } else {
      const result=await getBackend(env).fetchStatus(claimed.provider_id!);
      const current=await readOperation(env.DB,claimed.id);
      if(current?.fence!==claimed.fence||current.lease_owner!==claimed.lease_owner)return;
      if(result.status!=='processing') {
        if(current.cancel_requested)await fail(env,claimed,'cancelled','Split cancelled. No allowance was used.');
        else {stage='output_ingest';await complete(env,claimed.job_id!,result,claimed);}
      } else if (current.cancel_requested && canCancelProvider) {
        if (await cancelReplicatePrediction(env, claimed.provider_id!)) {
          await fail(env,claimed,'cancelled','Split cancelled. No allowance was used.');
        }
      }
    }
  } catch(error) {
    logSplitError('split_reconcile_failed',claimed.job_id!,stage,error);
    if(error instanceof YouTubeError&&error.terminalPrediction&&error.retryable&&claimed.phase==='fetch'&&!claimed.cancel_requested
      &&['source_fetch_unavailable','youtube_fetch_busy','extractor_timeout','youtube_fetch_timeout'].includes(error.code)) {
      const attempts=await env.DB.prepare("SELECT COUNT(*) AS n FROM operation_attempts WHERE operation_id=? AND phase='fetch'").bind(claimed.id).first<{n:number}>();
      nextPollAt=Math.max(error.notBefore,retryAt(null,now,(attempts?.n??1)+3));
      if((attempts?.n??0)<3&&nextPollAt<claimed.deadline) {
        await env.DB.batch([
          env.DB.prepare("UPDATE operation_attempts SET outcome='failed',code=?,updated_at=? WHERE operation_id=? AND phase='fetch' AND external_id=? AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND lease_owner=?)")
            .bind(error.code,now,claimed.id,claimed.provider_id,claimed.id,claimed.fence,claimed.lease_owner),
          env.DB.prepare("UPDATE app_operations SET state='queued',provider_id=NULL,error_code=?,not_before=?,updated_at=? WHERE id=? AND fence=? AND lease_owner=? AND cancel_requested=0 AND state IN ('processing','reconciling')")
            .bind(error.code,nextPollAt,now,claimed.id,claimed.fence,claimed.lease_owner),
        ]);
        return;
      }
    }
    if(error instanceof YouTubeError||error instanceof ArchiveError) await fail(env,claimed,error.code,
      error.code==='source_too_long'?error.message:error.code==='audio_too_large'?'This import exceeds the 12 MiB audio limit. No allowance was used. Try a shorter clip or upload an original or licensed file.':undefined);
    else if(error instanceof UpstreamError) {
      if(error.code==='import_delivery_unavailable') {
        deliveryAccepted=true;
        await env.DB.prepare(`UPDATE app_operations SET error_code='import_delivery_unavailable'
          WHERE id=? AND fence=? AND state NOT IN (${TERMINAL})`).bind(claimed.id,claimed.fence).run();
      }
      if(error.notBefore)await setCooldown(env.DB,'replicate',error.notBefore);
    }
    // Provider/storage outage retains the exact prediction, never creates another.
  } finally {
    if(claimed.deadline<=Date.now())await expireSplitOperations(env.DB,Date.now(),claimed.id);
    await env.DB.prepare(`UPDATE app_operations SET lease_owner=NULL,lease_until=0,not_before=? WHERE id=? AND fence=? AND state NOT IN (${TERMINAL})`)
      .bind(Math.min(Math.max(nextPollAt,await cooldown(env.DB,'replicate')),deliveryAccepted?claimed.deadline:Infinity),claimed.id,claimed.fence).run();
  }
}
export async function resumeOwnedSourceImport(env:Env,principal:AppPrincipal,operation:Operation) {
  const claimedOwner=await ownsClaimedOperation(env,principal,operation);
  if(env.AUTH_MODE!=='cail'||env.SPLIT_STARTS_DISABLED==='true'||(!claimedOwner&&(operation.subject!==principal.subject
    ||operation.quota_class!==(principal.quotaClass??'member')))||operation.phase!=='fetch'
    ||!['queued','running'].includes(operation.state)||!isOwnedSourceImport(JSON.parse(operation.request_json)))return;
  await recoverExpired(env.DB);
  const current=await readOperation(env.DB,operation.id);
  if(current?.subject!==operation.subject||current.phase!=='fetch'||!['queued','running'].includes(current.state))return;
  if(current.cancel_requested) {
    if(current.state==='queued')await fail(env,current,'cancelled');
    return;
  }
  const claimed=await claimNativeImport(env.DB,operation.id,operation.subject);
  if(claimed)await start(env,claimed);
}
export const resumeOwnedVimeoImport=resumeOwnedSourceImport;

export async function drainSplitQueue(env: Env,complete: Complete) {
  if(env.AUTH_MODE!=='cail')return;
  await recoverExpired(env.DB);
  const active=await env.DB.prepare("SELECT * FROM app_operations WHERE kind='split' AND state IN ('processing','reconciling') AND provider_id IS NOT NULL AND not_before<=? ORDER BY updated_at LIMIT 4")
    .bind(Date.now()).all<Operation>();
  for(const op of active.results)await reconcileSplit(env,op,complete);
  if(env.SPLIT_STARTS_DISABLED==='true')return;
  const limit=env.SPLIT_CONCURRENCY==='2'?2:1;
  for(const phase of ['fetch','split'] as const) {
    for(let slot=0;slot<(phase==='split'?limit:1);slot++) {
      const op=await claimNext(env.DB,phase,Date.now(),limit);if(!op)break;await start(env,op);
    }
  }
}

export async function recoverCallback(env: Env,operation: Operation,externalId: string) {
  if(operation.provider_id||!['starting','reconciling'].includes(operation.state))return;
  // A delayed callback from a retired fetch must not claim a later uncertain start.
  if(await env.DB.prepare("SELECT 1 FROM operation_attempts WHERE operation_id=? AND phase=? AND external_id=? AND outcome='failed'")
    .bind(operation.id,operation.phase,externalId).first())return;
  // A capability is unique to the operation AND phase. The accepted prediction
  // must also match the exact model version recorded before its paid POST.
  const attempt=await env.DB.prepare(`SELECT id,model FROM operation_attempts WHERE operation_id=? AND phase=?
    AND provider='replicate' AND outcome IN ('starting','uncertain') ORDER BY created_at DESC LIMIT 1`)
    .bind(operation.id,operation.phase).first<{id:string;model:string|null}>();
  if(!attempt?.model)return;
  if(await cooldown(env.DB,'replicate')>Date.now())return;
  try {if(!await getBackend(env).confirmStart?.(externalId,operationWebhook(env,operation.id,operation.phase as 'fetch'|'split'),attempt.model))return;}
  catch(error) {if(error instanceof UpstreamError&&error.notBefore) {await setCooldown(env.DB,'replicate',error.notBefore);await env.DB.prepare('UPDATE app_operations SET not_before=MAX(not_before,?) WHERE id=?').bind(error.notBefore,operation.id).run();}return;}
  await finishAttempt(env.DB,attempt.id,'accepted',{externalId});
  const accepted=await env.DB.prepare(`UPDATE app_operations SET provider_id=?,state='processing',lease_until=0,lease_owner=NULL,updated_at=?
    WHERE id=? AND fence=? AND phase=? AND provider_id IS NULL AND state IN ('starting','reconciling')`)
    .bind(externalId,Date.now(),operation.id,operation.fence,operation.phase).run();
  if(accepted.meta.changes&&operation.phase==='split')await env.DB.prepare("UPDATE jobs SET external_id=?,status='processing' WHERE id=? AND status NOT IN ('done','failed')").bind(externalId,operation.job_id).run();
}
