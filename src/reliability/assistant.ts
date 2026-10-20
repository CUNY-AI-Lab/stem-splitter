import type { Env } from '../env.ts';
import { fingerprint, OperationError, readOperation, reserveOperation, settleOperation, type Operation } from './ledger.ts';
import type { QuotaClass } from '../daily-allowance.ts';

/** One reservation surrounds the human message, tools, and both model attempts.
 * This ledger contains no transcript text. Conversation storage owns readback. */
export async function reserveAssistant(env: Env, subject: string, courseId: string | null, kind: 'chat'|'guide', key: string, jobId: string, input: unknown, quotaClass: QuotaClass = 'member') {
  const reserved=await reserveOperation(env.DB,{subject,quotaClass,courseId,kind,key,jobId,fingerprint:await fingerprint(input),phase:kind,request:{}});
  const op=reserved.operation;
  if(!reserved.created) {
    if(op.state==='succeeded')return {operation:op,replay:true};
    if(['failed','partial','cancelled'].includes(op.state))throw await assistantFailure(env,op);
    throw new OperationError('listening_in_progress',409,'This request is still being processed. Retry the same request to check its result.',2,{newAttemptAllowed:false,retryable:true});
  }
  await env.DB.prepare("UPDATE app_operations SET state='running',lease_until=?,updated_at=? WHERE id=? AND state='queued'")
    .bind(Date.now()+90000,Date.now(),op.id).run();
  return {operation:op,replay:false};
}

/** A terminal key is never regenerated. A new explicit attempt is permitted
 * only after the ledger has no starting/uncertain provider attempt. */
export async function assistantFailure(env:Env, operation:Operation) {
  if(operation.state==='succeeded')return new OperationError('listening_result_available',409,
    'This reply completed. Retry the same request to recover its saved result.',2,{newAttemptAllowed:false,retryable:true});
  const uncertain=await env.DB.prepare("SELECT 1 FROM operation_attempts WHERE operation_id=? AND outcome IN ('starting','accepted','uncertain')").bind(operation.id).first();
  const retryAfter=uncertain?Math.max(0,Math.ceil((operation.created_at+120_000-Date.now())/1000)):0;
  const wait=retryAfter>0;
  const turnMessage=operation.quota_class==='member'?' It did not use a successful turn.':'';
  return new OperationError(wait?'listening_attempt_uncertain':'listening_attempt_failed',409,
    wait?`This request ended before its provider outcome could be verified.${turnMessage} Wait up to two minutes, then retry this request to recover or start a new attempt.`
      :`This request did not complete.${turnMessage} You can send it again as a new attempt.`,
    retryAfter,{newAttemptAllowed:!wait,retryable:true});
}

/** Called only after current request authorization. SQL repeats the exact
 * owner and retention boundary; no instructor or administrative read path. */
export async function replayAssistant(env:Env,operation:Operation):Promise<Record<string,unknown>|null> {
  if(operation.state!=='succeeded'||operation.quota_class!=='member')return null;
  if(operation.course_id && operation.kind==='chat') {
    const row=await env.DB.prepare(`SELECT t.reply,t.finish_reason,c.revision,t.tools FROM course_turns t
      JOIN course_conversations c ON c.job_id=t.job_id AND c.subject=t.subject
      JOIN jobs j ON j.id=t.job_id JOIN job_owners o ON o.job_id=j.id AND o.subject=t.subject
      WHERE t.job_id=? AND t.subject=? AND t.turn_id=? AND t.state='complete'
      AND c.expires_at>datetime('now') AND j.created_at>datetime('now','-90 days')
      AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)`)
      .bind(operation.job_id,operation.subject,operation.idempotency_key).first<{reply:string;finish_reason:string;revision:number;tools:string}>();
    const tools=row?JSON.parse(row.tools||'[]'):[];
    return row?{text:row.reply,finishReason:row.finish_reason,revision:row.revision,
      calls:tools.filter((v:{name?:string})=>v.name!=='add_note'),
      notesChanged:tools.some((v:{name?:string})=>v.name==='add_note')}:null;
  }
  const row=await env.DB.prepare(`SELECT r.response_json FROM listening_reply_receipts r
    JOIN jobs j ON j.id=r.job_id JOIN job_owners o ON o.job_id=j.id AND o.subject=r.subject
    WHERE r.operation_id=? AND r.subject=? AND r.job_id=? AND r.expires_at>?
      AND j.created_at>datetime('now','-90 days') AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)`)
    .bind(operation.id,operation.subject,operation.job_id,Date.now()).first<{response_json:string}>();
  return row?JSON.parse(row.response_json):null;
}
export function assistantReceipt(env: Env,operation: Operation) {
  let delivered=false,courseClaim:string|null=null;
  const mark=async(delivery:'partial'|'effect_intent')=>{
    const result=await env.DB.prepare(`UPDATE app_operations SET result_json=?,updated_at=? WHERE id=? AND state='running' AND lease_until>?
      AND (course_id IS NULL OR kind<>'chat' OR EXISTS(SELECT 1 FROM course_conversations c
        WHERE c.job_id=app_operations.job_id AND c.subject=app_operations.subject AND c.pending_turn=?
        AND c.pending_expires_at>datetime('now') AND c.expires_at>datetime('now')))`)
      .bind(JSON.stringify({delivery}),Date.now(),operation.id,Date.now(),courseClaim).run();
    if(!result.meta.changes)throw new OperationError('input_no_longer_active',409,'This input ended. Reload the conversation before continuing.');
    delivered=true;
  };
  return {
    bindCourseClaim(claimId:string) {courseClaim=claimId;},
    /** Persist BEFORE handing output to the response writer. A process crash
     * after this point must not turn a delivered partial into a free replay. */
    async delta(value: string) {
      if(value.trim())await mark('partial');
    },
    /** Persist before durable conversation/cache/tool effects, including an
     * unusual provider response that supplied final content without deltas. */
    async effect() {await mark('effect_intent');},
    async complete(_reply: string, response?:Record<string,unknown>) {
      if(!_reply.trim()) {
        await settleOperation(env.DB,operation.id,'failed','no_usable_response');
        throw new OperationError('no_usable_response',503,'The Listening Guide could not finish this reply. Please try a new message.');
      }
      // Final delivery is conditional on the same live reservation. A stale
      // runner must not emit tools/done after recovery has already settled it.
      // For course work, reset or a new turn also invalidates the saved receipt.
      const now=Date.now();
      const update=env.DB.prepare(`UPDATE app_operations SET state='succeeded',error_code=NULL,result_json=?,
        lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND state='running' AND lease_until>? AND cancel_requested=0
        AND (course_id IS NULL OR kind<>'chat' OR EXISTS(SELECT 1 FROM course_turns t
          JOIN course_conversations c ON c.job_id=t.job_id AND c.subject=t.subject
          WHERE t.job_id=app_operations.job_id AND t.subject=app_operations.subject
          AND t.turn_id=app_operations.idempotency_key AND t.state='complete' AND c.pending_turn IS NULL
          AND c.revision=t.revision AND c.expires_at>datetime('now')))`)
        .bind(JSON.stringify({delivery:'completed'}),now,operation.id,now);
      const statements=[update];
      if(response && operation.quota_class==='member' && !operation.course_id && operation.kind==='chat') {
        statements.push(env.DB.prepare(`INSERT INTO listening_reply_receipts(operation_id,job_id,subject,response_json,expires_at)
          SELECT o.id,j.id,o.subject,?,MIN(?,CAST(strftime('%s',j.created_at,'+90 days') AS INTEGER)*1000)
          FROM app_operations o JOIN jobs j ON j.id=o.job_id JOIN job_owners own ON own.job_id=j.id AND own.subject=o.subject
          WHERE o.id=? AND o.state='succeeded' AND o.updated_at=? AND j.created_at>datetime('now','-90 days')
          AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id) ON CONFLICT(operation_id) DO NOTHING`)
          .bind(JSON.stringify(response),now+86400000,operation.id,now));
      }
      const result=await env.DB.batch(statements);
      if(!result[0].meta.changes)throw new OperationError('input_no_longer_active',409,'This input ended. Reload the conversation before continuing.');
    },
    async cached() {await settleOperation(env.DB,operation.id,'cancelled','cached_response');},
    async failed() {
      await settleOperation(env.DB,operation.id,delivered?'partial':'failed',delivered?'partial_response':'no_usable_response',{delivery:delivered?'partial':'none'});
    },
    async failure() {return assistantFailure(env,(await readOperation(env.DB,operation.id))??operation);},
  };
}
