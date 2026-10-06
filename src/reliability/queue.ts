import { type Operation, type Phase, TERMINAL, readOperation } from './ledger.ts';

// Conservative application ceilings; they do not assert an account entitlement.
// Unknown starts occupy a slot until authoritative evidence resolves them.
export const QUEUE_CAPS = { fetch: 1, split: 1, perSubject: 1 } as const;
export const WORK_LEASE_MS = 5*60*1000;

export async function claimNext(db: D1Database, phase: 'fetch' | 'split', now=Date.now()): Promise<Operation | null> {
  const owner=crypto.randomUUID();
  // D1 serializes this statement. The subquery plus compare-and-set cannot
  // oversubscribe even when unrelated Worker instances claim simultaneously.
  const row=await db.prepare(`UPDATE app_operations SET state='running',lease_owner=?,lease_until=?,fence=fence+1,updated_at=?
    WHERE id=(SELECT q.id FROM app_operations q
      LEFT JOIN operation_fairness f ON f.subject=q.subject AND f.phase=q.phase
      WHERE q.kind='split' AND q.phase=? AND q.state='queued' AND q.not_before<=? AND q.deadline>?
      AND COALESCE((SELECT until_ms FROM provider_cooldowns WHERE provider='replicate'),0)<=?
      AND (SELECT COUNT(*) FROM app_operations a WHERE a.kind='split' AND a.phase=q.phase AND a.state IN ('running','starting','processing','reconciling'))<?
      AND (SELECT COUNT(*) FROM app_operations a WHERE a.kind='split' AND a.subject=q.subject AND a.phase=q.phase AND a.state IN ('running','starting','processing','reconciling'))<?
      ORDER BY COALESCE(f.last_started,0),q.created_at,q.id LIMIT 1)
    AND state='queued' RETURNING *`)
    .bind(owner,now+WORK_LEASE_MS,now,phase,now,now,now,QUEUE_CAPS[phase],QUEUE_CAPS.perSubject).first<Operation>();
  if (row) await db.prepare(`INSERT INTO operation_fairness(subject,phase,last_started) VALUES(?,?,?)
    ON CONFLICT(subject,phase) DO UPDATE SET last_started=excluded.last_started`).bind(row.subject,phase,now).run();
  return row;
}

export async function transition(db: D1Database, operation: Operation, state: Operation['state'], changes: {phase?: Phase; providerId?: string | null; notBefore?: number; code?: string | null}={}) {
  const result=await db.prepare(`UPDATE app_operations SET state=?,phase=?,provider_id=?,not_before=?,error_code=?,updated_at=?
    WHERE id=? AND fence=? AND lease_owner IS ? AND state NOT IN (${TERMINAL})`)
    .bind(state,changes.phase ?? operation.phase,changes.providerId === undefined ? operation.provider_id : changes.providerId,
      changes.notBefore ?? 0,changes.code ?? null,Date.now(),operation.id,operation.fence,operation.lease_owner).run();
  // D1 includes audit-trigger writes in changes; SQLite's shim counts only
  // the outer row. Zero is the portable losing-CAS signal.
  return result.meta.changes>0;
}

export async function recoverExpired(db: D1Database, now=Date.now()) {
  // Never blindly repeat an accepted or ambiguously accepted POST. Work that
  // died before an attempt record is safe to enqueue; starts reconcile.
  await db.prepare(`UPDATE app_operations SET state=CASE
    WHEN EXISTS(SELECT 1 FROM operation_attempts a WHERE a.operation_id=app_operations.id AND a.phase=app_operations.phase AND a.outcome IN ('starting','accepted','uncertain'))
      THEN 'reconciling' ELSE 'queued' END,
    fence=fence+1,lease_owner=NULL,lease_until=0,updated_at=?
    WHERE kind='split' AND state IN ('running','starting') AND lease_until<?`).bind(now,now).run();
  await db.prepare(`UPDATE jobs SET status='failed',error='This request expired before it started. Submit it again.'
    WHERE id IN(SELECT job_id FROM app_operations WHERE kind='split' AND state='queued' AND deadline<=?)`).bind(now).run();
  // A late known response is safe evidence even when its old Worker lost the
  // lease. Adopt the ID from the durable attempt, never POST a replacement.
  await db.prepare(`UPDATE app_operations SET provider_id=(SELECT a.external_id FROM operation_attempts a
    WHERE a.operation_id=app_operations.id AND a.phase=app_operations.phase AND a.outcome='accepted' AND a.external_id IS NOT NULL
    ORDER BY a.created_at DESC LIMIT 1),updated_at=?
    WHERE kind='split' AND state='reconciling' AND provider_id IS NULL`).bind(now).run();
  await db.prepare(`UPDATE jobs SET external_id=(SELECT provider_id FROM app_operations WHERE job_id=jobs.id AND kind='split'),status='processing'
    WHERE id IN(SELECT job_id FROM app_operations WHERE kind='split' AND phase='split' AND state='reconciling' AND provider_id IS NOT NULL)
    AND status NOT IN ('done','failed')`).run();
  // Every usable delta/effect intent is persisted before delivery. An absent
  // marker proves no usable output was delivered; a marker may be partial.
  // Both outcomes fence the old key/runner and never regenerate its tools.
  await db.prepare(`UPDATE app_operations SET state=CASE WHEN result_json IS NULL THEN 'failed' ELSE 'partial' END,
    error_code=CASE WHEN result_json IS NULL THEN 'no_usable_response' ELSE 'delivery_uncertain' END,updated_at=?
    WHERE kind IN ('chat','guide') AND state IN ('running','starting','reconciling') AND lease_until<?`).bind(now,now).run();
}

export async function cancelOperation(db: D1Database, id: string, subject: string) {
  const operation=await readOperation(db,id);
  if (!operation || operation.subject!==subject) return false;
  await db.prepare(`UPDATE app_operations SET cancel_requested=1,updated_at=? WHERE id=? AND state NOT IN (${TERMINAL})`).bind(Date.now(),id).run();
  // An unstarted queued request has no external effects. An accepted/unknown
  // one keeps its reservation and capacity until the provider becomes terminal.
  await db.prepare(`UPDATE jobs SET status='failed',error='Split cancelled. No successful-split allowance was used.'
    WHERE id=? AND EXISTS(SELECT 1 FROM app_operations WHERE id=? AND state='queued' AND cancel_requested=1)`)
    .bind(operation.job_id,id).run();
  return true;
}
