import { dailyWindow, SIGNED_IN_SPLITS_PER_DAY, HUMAN_INPUTS_PER_DAY } from '../daily-allowance.ts';

export type OperationKind = 'split' | 'chat' | 'guide';
export type Phase = 'fetch' | 'split' | 'chat' | 'guide';
export type State = 'queued' | 'running' | 'starting' | 'processing' | 'reconciling' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export interface Operation {
  id: string; subject: string; course_id: string | null; kind: OperationKind;
  idempotency_key: string; fingerprint: string; day: string; state: State; phase: Phase;
  job_id: string | null; request_json: string; result_json: string | null; provider_id: string | null;
  lease_owner: string | null; lease_until: number; fence: number; not_before: number;
  deadline: number; cancel_requested: number; error_code: string | null; created_at: number; updated_at: number;
}
export const TERMINAL = "'succeeded','partial','failed','cancelled'";
export const MAX_QUEUED_SPLITS = 100;
export const MAX_SPLIT_ATTEMPTS_PER_DAY = 40;
export const MAX_CHAT_ATTEMPTS_PER_DAY = 80;
export const validOperationKey = (key: unknown): key is string => typeof key === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(key);
export class OperationError extends Error {
  code: string; status: 400|409|429|503; retryAfter: number;
  constructor(code: string, status: 400 | 409 | 429 | 503, message: string, retryAfter = 0) { super(message);this.code=code;this.status=status;this.retryAfter=retryAfter; }
}
export async function fingerprint(value: unknown): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, '0')).join('');
}
export async function readOperation(db: D1Database, id: string): Promise<Operation | null> {
  return db.prepare('SELECT * FROM app_operations WHERE id=?').bind(id).first<Operation>();
}
export async function findOperation(db: D1Database, subject: string, kind: OperationKind, key: string) {
  return db.prepare('SELECT * FROM app_operations WHERE subject=? AND kind=? AND idempotency_key=?').bind(subject, kind, key).first<Operation>();
}
/** The INSERT predicate and all associated job writes execute in one D1 batch.
 * The unique key handles racing replays; quota includes active and settled work.
 */
export async function reserveOperation(db: D1Database, input: {
  subject: string; courseId: string | null; kind: OperationKind; key: string; fingerprint: string;
  phase: Phase; jobId?: string; request?: unknown; now?: number;
  statements?: (id: string) => D1PreparedStatement[];
}): Promise<{ operation: Operation; created: boolean }> {
  if (!validOperationKey(input.key)) throw new OperationError('idempotency_required', 400, 'Reload and submit again with a request identifier.');
  const now = input.now ?? Date.now();
  const { day, retryAfter } = dailyWindow(new Date(now));
  const limit = input.kind === 'split' ? SIGNED_IN_SPLITS_PER_DAY : input.kind === 'chat' ? HUMAN_INPUTS_PER_DAY : 20;
  const abuseLimit = input.kind === 'split' ? MAX_SPLIT_ATTEMPTS_PER_DAY : input.kind === 'chat' ? MAX_CHAT_ATTEMPTS_PER_DAY : 20;
  const id = input.kind==='split' && input.jobId ? input.jobId : crypto.randomUUID();
  const insert = db.prepare(`INSERT INTO app_operations
    (id,subject,course_id,kind,idempotency_key,fingerprint,day,state,phase,job_id,request_json,deadline,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,'queued',?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM app_operations WHERE subject=? AND kind=? AND day=? AND state NOT IN ('failed','cancelled')) < ?
      AND (SELECT COUNT(*) FROM app_operations WHERE subject=? AND kind=? AND day=?) < ?
      AND (? <> 'split' OR (SELECT COUNT(*) FROM app_operations WHERE kind='split' AND state NOT IN (${TERMINAL})) < ?)
      AND (? <> 'guide' OR (SELECT COUNT(*) FROM app_operations WHERE kind='guide' AND day=?) < 200)
    ON CONFLICT(subject,kind,idempotency_key) DO NOTHING`)
    .bind(id,input.subject,input.courseId,input.kind,input.key,input.fingerprint,day,input.phase,input.jobId ?? null,
      JSON.stringify(input.request ?? {}),now+24*60*60*1000,now,now,input.subject,input.kind,day,limit,
      input.subject,input.kind,day,abuseLimit,input.kind,MAX_QUEUED_SPLITS,input.kind,day);
  await db.batch([insert,...(input.statements?.(id) ?? [])]);
  const operation = await findOperation(db,input.subject,input.kind,input.key);
  if (!operation) {
    const counts=await db.prepare(`SELECT COUNT(*) AS attempts,
      SUM(CASE WHEN state NOT IN ('failed','cancelled') THEN 1 ELSE 0 END) AS held
      FROM app_operations WHERE subject=? AND kind=? AND day=?`).bind(input.subject,input.kind,day).first<{attempts:number;held:number}>();
    if ((counts?.held ?? 0)>=limit) throw new OperationError(`${input.kind}_daily_limit`,429,
      input.kind==='split'?'Completed and in-progress splits fill today\'s 15 places. Failed splits do not count as completed.'
        :'Today\'s Listening Guy input allowance is full.',retryAfter);
    if ((counts?.attempts ?? 0)>=abuseLimit || input.kind==='guide') throw new OperationError(`${input.kind}_attempt_limit`,429,
      'Repeated requests have reached the daily protection limit. Failed splits did not use successful-split allowance. Please try again after the reset.',retryAfter);
    throw new OperationError('split_queue_full',429,'The audio queue is full. Wait a minute and submit the same request again.',60);
  }
  if (operation.fingerprint !== input.fingerprint || operation.course_id !== input.courseId) {
    throw new OperationError('idempotency_conflict',409,'This request identifier belongs to different input. Submit a new request.');
  }
  return { operation, created: operation.id === id && operation.created_at === now };
}
export async function settleOperation(db: D1Database, id: string, state: 'succeeded' | 'partial' | 'failed' | 'cancelled', code: string | null = null, result: unknown = null, fence?: number) {
  const update = await db.prepare(`UPDATE app_operations SET state=?,error_code=?,result_json=?,lease_owner=NULL,lease_until=0,updated_at=?
    WHERE id=? AND state NOT IN (${TERMINAL}) AND (? IS NULL OR fence=?)
    AND (? NOT IN ('succeeded','partial') OR cancel_requested=0)`)
    .bind(state,code,result === null ? null : JSON.stringify(result),Date.now(),id,fence ?? null,fence ?? null,state).run();
  return update.meta.changes === 1;
}
export async function beginAttempt(db: D1Database, operation: Operation, provider: string, model?: string) {
  const id=crypto.randomUUID(), now=Date.now();
  const inserted=await db.prepare(`INSERT INTO operation_attempts(id,operation_id,phase,provider,model,outcome,created_at,updated_at)
    SELECT ?,id,phase,?,?,'starting',?,? FROM app_operations WHERE id=? AND fence=? AND state NOT IN (${TERMINAL})`)
    .bind(id,provider,model ?? null,now,now,operation.id,operation.fence).run();
  if(inserted.meta.changes!==1)throw new OperationError('operation_fenced',409,'This request is being recovered.');
  return id;
}
export async function finishAttempt(db: D1Database, id: string, outcome: string, detail: { externalId?: string; status?: number; code?: string; usage?: unknown } = {}) {
  await db.prepare('UPDATE operation_attempts SET outcome=?,external_id=COALESCE(?,external_id),http_status=?,code=?,usage_json=?,updated_at=? WHERE id=?')
    .bind(outcome,detail.externalId ?? null,detail.status ?? null,detail.code ?? null,detail.usage === undefined ? null : JSON.stringify(detail.usage),Date.now(),id).run();
}
