import { operationAllowance } from '../daily-allowance.ts';
/** Daily member input accounting is independent of Gateway spend. */
export const GUEST_LISTENING_REPLIES = 2;
export const LISTENING_ATTEMPT_WINDOW_MS = 60_000;
export const LISTENING_ATTEMPTS_PER_WINDOW = 10;
const terminal = "'succeeded','partial','failed','cancelled'";
export interface ListeningUsage {
  ok: true; limit: number; successfulTurns: number; remainingTurns: number;
  inProgress: number; cooldownUntil: string | null; serverTime: string; retryAfterSeconds: number; resetsAt?: string;
}
/** Expiry fences the old runner. It never regenerates an uncertain provider call. */
export async function recoverListeningOperations(db: D1Database, subject: string, now=Date.now()) {
  await db.prepare(`UPDATE app_operations SET state=CASE WHEN result_json IS NULL THEN 'failed' ELSE 'partial' END,
    error_code=CASE WHEN result_json IS NULL THEN 'no_usable_response' ELSE 'delivery_uncertain' END,updated_at=?
    WHERE subject=? AND kind IN ('chat','guide') AND ((state IN ('running','starting','reconciling') AND lease_until<=?)
      OR (state='queued' AND created_at<=?))`).bind(now,subject,now,now-90_000).run();
}
export async function listeningUsage(db: D1Database, subject: string, now=Date.now()): Promise<ListeningUsage> {
  const allowance=await operationAllowance(db,subject,'chat',new Date(now),'member');
  return {ok:true,limit:allowance.limit,successfulTurns:allowance.completed,inProgress:allowance.inProgress,
    remainingTurns:allowance.remaining,cooldownUntil:null,serverTime:new Date(now).toISOString(),
    resetsAt:allowance.resetsAt,retryAfterSeconds:0};
}

/** The anonymous demo spans one browser session across recordings and UTC days.
 * Pending requests hold places; failed and incomplete replies release them. */
export async function guestListeningUsage(db: D1Database, subject: string, jobId: string, now=Date.now()) {
  const row=await db.prepare(`SELECT
    SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN state NOT IN (${terminal}) THEN 1 ELSE 0 END) AS active
    FROM app_operations WHERE subject=? AND quota_class='guest' AND kind IN ('chat','guide')`)
    .bind(subject).first<{completed:number|null;active:number|null}>();
  const successfulTurns=row?.completed??0,inProgress=row?.active??0;
  return {ok:true,scope:'session' as const,jobId,limit:GUEST_LISTENING_REPLIES,successfulTurns,inProgress,
    remainingTurns:Math.max(0,GUEST_LISTENING_REPLIES-successfulTurns-inProgress),
    showSignIn:successfulTurns>=2,signInRequired:successfulTurns>=GUEST_LISTENING_REPLIES,cooldownUntil:null,serverTime:new Date(now).toISOString(),
    retryAfterSeconds:inProgress>0 && successfulTurns+inProgress>=GUEST_LISTENING_REPLIES?2:0};
}
