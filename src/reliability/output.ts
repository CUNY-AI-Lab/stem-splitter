import type { Env } from '../env.ts';
import type { SeparationResult } from '../separation/types.ts';
import { validateAndOrderStems } from '../separation/options.ts';
import type { EncodedLayerSource } from '../separation/compose-layers.ts';
import { prominentLayerPlan, type SourceLayer, type LayerEnergy, type ProminentLayerPlan } from '../separation/prominent-layers.ts';
import { readOperation, TERMINAL, type Operation } from './ledger.ts';
import { InvalidStemAudioError } from './media.ts';
import { expireSplitOperations } from './queue.ts';

export const OUTPUT_KIND = 'split-output-v1';
export const OUTPUT_LEASE_MS = 60_000;
export const OUTPUT_CAP = 1;
const DISPATCH_MS = 60_000;
type Stored = {name: string; key: string; energy?: LayerEnergy; validated?: boolean};
export interface OutputProgress {
  kind: typeof OUTPUT_KIND;
  model: string;
  requested: 4 | 'auto' | null;
  remote: {name: string; url: string}[];
  sources: Stored[];
  outputs: Stored[];
  plan?: ProminentLayerPlan;
  gain?: number;
}
export interface OutputAudio {
  measure(data: ArrayBuffer, name: SourceLayer, checkpoint: () => Promise<void>): Promise<LayerEnergy>;
  gain(sources: EncodedLayerSource[], energy: LayerEnergy[], plan: ProminentLayerPlan, checkpoint: () => Promise<void>): Promise<number>;
  encode(input: {sources: EncodedLayerSource[]; sampleRate: number; gain: number;
    append(bytes: Uint8Array): Promise<void>; checkpoint(): Promise<void>}): Promise<void>;
}
export function outputProgress(op: Pick<Operation, 'result_json'>): OutputProgress | null {
  if (!op.result_json) return null;
  const value = JSON.parse(op.result_json);
  return value?.kind === OUTPUT_KIND ? value as OutputProgress : null;
}

/** D1 is the outbox. A lost send is repaired by cron; competing polls enqueue
 * at most once per recovery interval. Queue delivery itself is at least once. */
export async function dispatchOutput(env: Env, id: string) {
  if (!env.deferAdaptiveOutput) return;
  const now = Date.now();
  const claimed = await env.DB.prepare(`UPDATE app_operations SET not_before=? WHERE id=? AND kind='split'
    AND json_extract(result_json,'$.kind')=? AND state IN ('processing','reconciling')
    AND lease_until<=? AND not_before<=? AND deadline>? AND cancel_requested=0 RETURNING fence`)
    .bind(now + DISPATCH_MS, id, OUTPUT_KIND, now, now, now).first<{fence:number}>();
  if (!claimed) return;
  try { await env.deferAdaptiveOutput(id); }
  catch (error) {
    await env.DB.prepare('UPDATE app_operations SET not_before=0 WHERE id=? AND fence=? AND not_before=?')
      .bind(id, claimed.fence, now + DISPATCH_MS).run();
    throw error;
  }
}

/** Provider completion frees provider capacity before output work begins. No
 * further provider status read or paid start is needed to resume publication. */
export async function handoffOutput(env: Env, op: Operation, result: SeparationResult, model: string, requested: 4 | 'auto' | null) {
  const remote = validateAndOrderStems(model, result.stems);
  for (const stem of remote) {
    const url = new URL(stem.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))) {
      throw new InvalidStemAudioError('Unsupported provider audio address');
    }
  }
  const progress: OutputProgress = {kind: OUTPUT_KIND, model, requested, remote, sources: [], outputs: []};
  const changed = await env.DB.prepare(`UPDATE app_operations SET result_json=?,fence=fence+1,lease_owner=NULL,lease_until=0,not_before=0,updated_at=?
    WHERE id=? AND fence=? AND lease_owner IS ? AND state IN ('processing','reconciling')
    AND cancel_requested=0 AND deadline>? AND result_json IS NULL`)
    .bind(JSON.stringify(progress), Date.now(), op.id, op.fence, op.lease_owner, Date.now()).run();
  if (changed.meta.changes) await dispatchOutput(env, op.id);
}

async function cleanup(env: Env, id: string, candidates: string[]) {
  // A failed D1 acknowledgement is not proof of a failed write. Read durable
  // references before deleting anything; unknown outcomes retain the object.
  const op = await readOperation(env.DB, id);
  const row = await env.DB.prepare('SELECT status,stems FROM jobs WHERE id=?').bind(id).first<{status:string;stems:string|null}>();
  const keep = new Set<string>(row?.stems ? JSON.parse(row.stems).map((s:Stored) => s.key) : []);
  const p = op && outputProgress(op);
  const terminal = !op || ['succeeded','failed','cancelled'].includes(op.state);
  if (!terminal && p) for (const s of [...p.sources, ...p.outputs]) keep.add(s.key);
  const keys = terminal && p ? [...candidates, ...p.sources.map(s=>s.key), ...p.outputs.map(s=>s.key)] : candidates;
  const results = await Promise.allSettled([...new Set(keys)].filter(key=>!keep.has(key)).map(key=>env.AUDIO.delete(key)));
  if (results.some(r=>r.status==='rejected')) console.error(JSON.stringify({event:'partial_stem_cleanup_failed',jobId:id}));
}

export async function settleStoppedOutput(env: Env, op: Operation) {
  if (op.deadline <= Date.now()) await expireSplitOperations(env.DB, Date.now(), op.id);
  else if (op.cancel_requested) await env.DB.batch([
    env.DB.prepare(`UPDATE app_operations SET fence=fence+1 WHERE id=? AND cancel_requested=1 AND state NOT IN (${TERMINAL})`).bind(op.id),
    env.DB.prepare(`UPDATE jobs SET status='failed',error='Split cancelled. No allowance was used.'
      WHERE id=? AND status NOT IN ('done','failed') AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND cancel_requested=1)`).bind(op.id,op.id),
  ]);
  await cleanup(env, op.id, []);
}

/** One CPU-bounded stage per delivery: one download/measurement, peak pass,
 * one encode, one validation, or publication. Completed stages survive retries. */
export async function runOutputStep(env: Env, id: string, download: (name:string,url:string,strict:boolean)=>Promise<ArrayBuffer>): Promise<boolean> {
  const prior = await readOperation(env.DB, id);
  if (!prior || !outputProgress(prior)) return true;
  if (['succeeded','failed','cancelled'].includes(prior.state) || prior.cancel_requested || prior.deadline <= Date.now()) {
    await settleStoppedOutput(env, prior); return true;
  }
  const now = Date.now(), owner = crypto.randomUUID();
  const op = await env.DB.prepare(`UPDATE app_operations SET lease_owner=?,lease_until=?,fence=fence+1,updated_at=?
    WHERE id=? AND fence=? AND lease_until<=? AND state IN ('processing','reconciling') AND cancel_requested=0 AND deadline>?
    AND (SELECT COUNT(*) FROM app_operations WHERE kind='split' AND json_extract(result_json,'$.kind')=?
      AND state IN ('processing','reconciling') AND lease_until>?)<? RETURNING *`)
    .bind(owner,now+OUTPUT_LEASE_MS,now,id,prior.fence,now,now,OUTPUT_KIND,now,OUTPUT_CAP).first<Operation>();
  if (!op) return false;
  const p = outputProgress(op)!;
  const candidates: string[] = [];
  let stage = 'download';
  const started = Date.now();
  const checkpoint = async () => {
    const now = Date.now();
    const result = await env.DB.prepare(`UPDATE app_operations SET lease_until=?,updated_at=? WHERE id=? AND fence=? AND lease_owner=?
      AND lease_until>? AND deadline>? AND cancel_requested=0 AND state IN ('processing','reconciling')`)
      .bind(now+OUTPUT_LEASE_MS,now,id,op.fence,owner,now,now).run();
    if (!result.meta.changes) throw new Error('Output lease lost');
  };
  const save = async () => {
    const now = Date.now();
    const saved = await env.DB.prepare(`UPDATE app_operations SET result_json=?,updated_at=? WHERE id=? AND fence=? AND lease_owner=?
      AND lease_until>? AND deadline>? AND cancel_requested=0 AND state IN ('processing','reconciling')`)
      .bind(JSON.stringify(p),now,id,op.fence,owner,now,now).run();
    if (!saved.meta.changes) throw new Error('Output checkpoint fenced');
  };
  const sources = (): EncodedLayerSource[] => p.sources.map(s=>({name:s.name as SourceLayer,open:async()=>{
    const audio=await env.AUDIO.get(s.key);if(!audio)throw new Error('Stored source unavailable');return audio.body;
  }}));
  try {
    const missing = p.remote.find(s=>!p.sources.some(stored=>stored.name===s.name));
    if (missing) {
      const bytes = await download(missing.name,missing.url,true);
      await checkpoint();
      let energy: LayerEnergy | undefined;
      if (p.requested) {
        if (!env.outputAudio) throw new Error('Output codec unavailable');
        energy = await env.outputAudio.measure(bytes,missing.name as SourceLayer,checkpoint);
      } else if (!env.validateStemAudio || !await env.validateStemAudio(bytes)) throw new InvalidStemAudioError('Source decode failed');
      await checkpoint();
      const key=`stems/${id}/${crypto.randomUUID()}/${missing.name}.mp3`;candidates.push(key);
      await env.AUDIO.put(key,bytes,{httpMetadata:{contentType:'audio/mpeg'}});
      p.sources.push({name:missing.name,key,...(energy?{energy}:{})});
      if (p.sources.length===p.remote.length) p.remote=[]; // Delivery URLs are no longer needed.
      await save();
    } else if (p.requested && !p.plan) {
      stage='plan';
      try { p.plan=prominentLayerPlan(p.sources.map(s=>s.energy!),p.requested); }
      catch { throw new InvalidStemAudioError('Unaligned provider sources'); }
      await save();
    } else if (p.plan && p.plan.parts!==6 && p.gain===undefined) {
      stage='peak';
      if (!env.outputAudio) throw new Error('Output codec unavailable');
      p.gain=await env.outputAudio.gain(sources(),p.sources.map(s=>s.energy!),p.plan,checkpoint);
      await save();
    } else if (p.outputs.some(s=>!s.validated)) {
      stage='validate';
      const output=p.outputs.find(s=>!s.validated)!;
      const stored=await env.AUDIO.get(output.key);
      if(!stored || stored.size>24*1024*1024)throw new Error('Encoded output unavailable');
      if(!env.validateStemAudio || !await env.validateStemAudio(await new Response(stored.body).arrayBuffer()))throw new InvalidStemAudioError('Output decode failed');
      output.validated=true;await save();
    } else if (p.plan && p.plan.parts!==6 && p.outputs.length<p.plan.parts) {
      stage='encode';
      if (!env.outputAudio) throw new Error('Output codec unavailable');
      const name=[...p.plan.selected,'other' as const][p.outputs.length];
      const names=name==='other'?p.plan.remainder:[name];
      const key=`stems/${id}/${crypto.randomUUID()}/display/${name}.mp3`;candidates.push(key);
      const sink=await multipartSink(env.AUDIO,key);
      try {
        await env.outputAudio.encode({sources:sources().filter(s=>names.includes(s.name)),sampleRate:p.sources[0].energy!.sampleRate,
          gain:p.gain!,checkpoint,append:sink.append});
        await checkpoint();await sink.finish();
      } catch(error) {await sink.abort().catch(()=>{});throw error;}
      p.outputs.push({name,key,validated:false});await save();
    } else {
      stage='publish';
      const published=p.plan&&p.plan.parts!==6?p.outputs:p.sources;
      const model=p.plan?.model??p.model;
      const ordered=validateAndOrderStems(model,published.map(s=>({name:s.name,url:s.key}))).map(s=>({name:s.name,key:s.url}));
      const committed=await env.DB.prepare(`UPDATE jobs SET status='done',stems=?,model=?,error=NULL WHERE id=? AND status NOT IN ('done','failed')
        AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND lease_owner=? AND cancel_requested=0 AND deadline>? AND lease_until>?)`)
        .bind(JSON.stringify(ordered),model,id,id,op.fence,owner,Date.now(),Date.now()).run();
      if(!committed.meta.changes)throw new Error('Output publication fenced');
      await cleanup(env,id,[]);
      return true;
    }
    return false;
  } catch (error) {
    const current=await readOperation(env.DB,id);
    if(current && (current.deadline<=Date.now() || current.cancel_requested)) await settleStoppedOutput(env,current);
    else if(error instanceof InvalidStemAudioError) await env.DB.prepare(`UPDATE jobs SET status='failed',error='The separator returned unplayable audio. No allowance was used.'
      WHERE id=? AND status NOT IN ('done','failed') AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND fence=? AND lease_owner=?)`)
      .bind(id,id,op.fence,owner).run();
    await cleanup(env,id,candidates);
    const final=await readOperation(env.DB,id);
    if(final && ['succeeded','failed','cancelled'].includes(final.state))return true;
    throw error;
  } finally {
    await env.DB.prepare(`UPDATE app_operations SET lease_owner=NULL,lease_until=0,not_before=0 WHERE id=? AND fence=? AND lease_owner=?
      AND state NOT IN (${TERMINAL})`).bind(id,op.fence,owner).run();
    console.log(JSON.stringify({event:'split_output_stage',jobId:id,stage,wallMs:Date.now()-started}));
  }
}

/** Fixed-size multipart buffering avoids keeping a fifteen-minute MP3 in memory
 * alongside up to five decoder heaps. Interrupted multipart uploads expire. */
export async function multipartSink(bucket: R2Bucket, key: string) {
  const upload=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:'audio/mpeg'}});
  const partSize=5*1024*1024, buffer=new Uint8Array(partSize), parts:R2UploadedPart[]=[];
  let used=0,total=0;
  const flush=async()=>{if(used){parts.push(await upload.uploadPart(parts.length+1,buffer.subarray(0,used)));used=0;}};
  return {
    async append(bytes:Uint8Array) {
      total+=bytes.length;if(total>24*1024*1024)throw new Error('Encoded layer too large');
      for(let at=0;at<bytes.length;){const take=Math.min(partSize-used,bytes.length-at);buffer.set(bytes.subarray(at,at+take),used);used+=take;at+=take;if(used===partSize)await flush();}
    },
    async finish(){await flush();if(!parts.length)throw new InvalidStemAudioError('Empty output');await upload.complete(parts);},
    abort:()=>upload.abort(),
  };
}
