import type { Env } from '../env.ts';
import { fingerprint, OperationError, reserveOperation, settleOperation, type Operation } from './ledger.ts';

/** One reservation surrounds the human message, tools, and both model attempts.
 * This ledger contains no transcript text. Conversation storage owns readback. */
export async function reserveAssistant(env: Env, subject: string, courseId: string | null, kind: 'chat'|'guide', key: string, jobId: string, input: unknown) {
  const reserved=await reserveOperation(env.DB,{subject,courseId,kind,key,jobId,fingerprint:await fingerprint(input),phase:kind,request:{}});
  const op=reserved.operation;
  if(!reserved.created) {
    throw new OperationError('input_already_submitted',409,op.state==='failed'?'This input did not complete. Send a new message to try again.':'This input was already accepted. Reload the conversation before continuing.');
  }
  await env.DB.prepare("UPDATE app_operations SET state='running',lease_until=?,updated_at=? WHERE id=? AND state='queued'")
    .bind(Date.now()+90000,Date.now(),op.id).run();
  return {operation:op,replay:false};
}
export function assistantReceipt(env: Env,operation: Operation) {
  let delivered=false;
  return {
    /** Persist BEFORE handing output to the response writer. A process crash
     * after this point must not turn a delivered partial into a free replay. */
    async delta(value: string) {
      delivered ||= Boolean(value);
      await env.DB.prepare("UPDATE app_operations SET result_json=?,updated_at=? WHERE id=? AND state='running'")
        .bind(JSON.stringify({delivery:'partial'}),Date.now(),operation.id).run();
    },
    async complete(_reply: string) {
      await settleOperation(env.DB,operation.id,'succeeded',null,{delivery:'completed'});
    },
    async failed() {
      await settleOperation(env.DB,operation.id,delivered?'partial':'failed',delivered?'partial_response':'no_usable_response',{delivery:delivered?'partial':'none'});
    },
  };
}
