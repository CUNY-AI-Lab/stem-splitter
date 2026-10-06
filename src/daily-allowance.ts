/** App allowances are independent of provider spend and Gateway authorization. */
export const SIGNED_IN_SPLITS_PER_DAY = 15;
export const HUMAN_INPUTS_PER_DAY = 50;
export const GUEST_SPLITS_PER_DAY = 5;
export const GUEST_INPUTS_PER_DAY = 25;
export type QuotaClass = 'member' | 'guest';
export function allowanceLimit(kind: 'split' | 'chat' | 'guide', quotaClass: QuotaClass) {
  return kind === 'guide' ? quotaClass === 'guest' ? 10 : 20
    : kind === 'split' ? quotaClass === 'guest' ? GUEST_SPLITS_PER_DAY : SIGNED_IN_SPLITS_PER_DAY
    : quotaClass === 'guest' ? GUEST_INPUTS_PER_DAY : HUMAN_INPUTS_PER_DAY;
}

export function dailyWindow(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const resetsAt = new Date(`${day}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return { day, resetsAt: resetsAt.toISOString(), retryAfter: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)) };
}

export async function splitAllowance(db: D1Database, subject: string, now = new Date(), quotaClass: QuotaClass = 'member') {
  return operationAllowance(db, subject, 'split', now, quotaClass);
}

export async function operationAllowance(db: D1Database, subject: string, kind: 'split' | 'chat', now = new Date(), quotaClass: QuotaClass = 'member') {
  const { day, resetsAt } = dailyWindow(now);
  const row = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state IN ('succeeded','partial') THEN 1 ELSE 0 END),0) AS completed,
    COALESCE(SUM(CASE WHEN state NOT IN ('succeeded','partial','failed','cancelled') THEN 1 ELSE 0 END),0) AS inProgress
    FROM app_operations WHERE kind=? AND day=? AND subject=?`)
    .bind(kind, day, subject).first<{ completed: number; inProgress: number }>();
  // A missing/corrupt read must never present a full allowance as verified.
  if (!row || !Number.isSafeInteger(row.completed) || row.completed < 0 || !Number.isSafeInteger(row.inProgress) || row.inProgress < 0) throw new Error('Allowance unavailable');
  const limit = allowanceLimit(kind,quotaClass);
  return { limit, completed: row.completed, inProgress: row.inProgress, remaining: Math.max(0, limit-row.completed-row.inProgress), resetsAt };
}
