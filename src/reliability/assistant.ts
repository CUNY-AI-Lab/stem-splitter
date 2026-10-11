import type { Env } from '../env.ts';
import { fingerprint, OperationError, reserveOperation, settleOperation, type Operation } from './ledger.ts';
import type { QuotaClass } from '../daily-allowance.ts';

/** One reservation surrounds the human message, tools, and both model attempts.
 * This ledger contains no transcript text. Conversation storage owns readback. */
export async function reserveAssistant(env: Env, subject: string, courseId: string | null, kind: 'chat'|'guide', key: string, jobId: string, input: unknown, quotaClass: QuotaClass = 'member') {
  const reserved=await reserveOperation(env.DB,{subject,quotaClass,courseId,kind,key,jobId,fingerprint:await fingerprint(input),phase:kind,request:{}});
  const op=reserved.operation;
  if(!reserved.created) {
    throw new OperationError('input_already_submitted',409,op.state==='failed'?'This input did not complete. Send a new message to try again.':op.error_code==='delivery_uncertain'?'A reply may have started before the connection ended. This counts as one input. Reload the conversation before continuing.':'This input was already accepted. Reload the conversation before continuing.');
  }
  await env.DB.prepare("UPDATE app_operations SET state='running',lease_until=?,updated_at=? WHERE id=? AND state='queued'")
    .bind(Date.now()+90000,Date.now(),op.id).run();
  return {operation:op,replay:false};
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
    async complete(_reply: string) {
      if(!_reply.trim()) {
        await settleOperation(env.DB,operation.id,'failed','no_usable_response');
        throw new OperationError('no_usable_response',503,'The Listening Guide could not finish this reply. Please try a new message.');
      }
      // Final delivery is conditional on the same live reservation. A stale
      // runner must not emit tools/done after recovery has already settled it.
      // For course work, reset or a new turn also invalidates the saved receipt.
      const result=await env.DB.prepare(`UPDATE app_operations SET state='succeeded',error_code=NULL,result_json=?,
        lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND state='running' AND lease_until>? AND cancel_requested=0
        AND (course_id IS NULL OR kind<>'chat' OR EXISTS(SELECT 1 FROM course_turns t
          JOIN course_conversations c ON c.job_id=t.job_id AND c.subject=t.subject
          WHERE t.job_id=app_operations.job_id AND t.subject=app_operations.subject
          AND t.turn_id=app_operations.idempotency_key AND t.state='complete' AND c.pending_turn IS NULL
          AND c.revision=t.revision AND c.expires_at>datetime('now')))`)
        .bind(JSON.stringify({delivery:'completed'}),Date.now(),operation.id,Date.now()).run();
      if(!result.meta.changes)throw new OperationError('input_no_longer_active',409,'This input ended. Reload the conversation before continuing.');
    },
    async failed() {
      await settleOperation(env.DB,operation.id,delivered?'partial':'failed',delivered?'partial_response':'no_usable_response',{delivery:delivered?'partial':'none'});
    },
  };
}
