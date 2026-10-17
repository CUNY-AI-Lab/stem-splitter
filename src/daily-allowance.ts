/** App allowances are independent of provider spend and Gateway authorization. */
export const SIGNED_IN_SPLITS_PER_DAY = 15;
export const OTHER_MEMBER_SPLITS_PER_DAY = 5;
export const HUMAN_INPUTS_PER_DAY = 50;
export const GUEST_SPLITS_PER_DAY = 3;
export const GUEST_INPUTS_PER_DAY = 25;
export type QuotaClass = 'member' | 'guest';
export type AllowanceRole = 'student' | 'member' | 'instructor' | 'admin' | 'guest';
export function allowanceLimit(kind: 'split' | 'chat' | 'guide', quotaClass: QuotaClass, role: AllowanceRole = 'member') {
  return kind === 'guide' ? quotaClass === 'guest' ? 10 : 20
    : kind === 'split' ? quotaClass === 'guest' ? GUEST_SPLITS_PER_DAY : role === 'student' ? SIGNED_IN_SPLITS_PER_DAY : OTHER_MEMBER_SPLITS_PER_DAY
    : quotaClass === 'guest' ? GUEST_INPUTS_PER_DAY : HUMAN_INPUTS_PER_DAY;
}

/** A dated operator grant adds capacity only while central identity verifies admin.
 * Usage remains intact; the next UTC day automatically restores the normal cap. */
export async function effectiveAllowanceLimit(db: D1Database, subject: string, day: string,
  kind: 'split' | 'chat' | 'guide', quotaClass: QuotaClass, role: AllowanceRole) {
  const base = allowanceLimit(kind, quotaClass, role);
  if (kind !== 'split' || quotaClass !== 'member' || role !== 'admin') return base;
  const grant = await db.prepare('SELECT extra_splits FROM admin_testing_grants WHERE subject=? AND day=?')
    .bind(subject, day).first<{ extra_splits: number }>();
  if (!grant) return base;
  if (!Number.isSafeInteger(grant.extra_splits) || grant.extra_splits < 1 || grant.extra_splits > 30) throw new Error('Allowance unavailable');
  return base + grant.extra_splits;
}

export function dailyWindow(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const resetsAt = new Date(`${day}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return { day, resetsAt: resetsAt.toISOString(), retryAfter: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)) };
}

/** Production callers pass the freshly verified role. The default preserves
 * the historical student-tier helper behavior for internal accounting callers. */
export async function splitAllowance(db: D1Database, subject: string, now = new Date(), quotaClass: QuotaClass = 'member', role: AllowanceRole = 'student') {
  return operationAllowance(db, subject, 'split', now, quotaClass, role);
}

export async function operationAllowance(db: D1Database, subject: string, kind: 'split' | 'chat', now = new Date(), quotaClass: QuotaClass = 'member', role: AllowanceRole = 'member') {
  const { day, resetsAt } = dailyWindow(now);
  const row = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state IN ('succeeded','partial') THEN 1 ELSE 0 END),0) AS completed,
    COALESCE(SUM(CASE WHEN state NOT IN ('succeeded','partial','failed','cancelled') THEN 1 ELSE 0 END),0) AS inProgress
    FROM app_operations WHERE kind=? AND day=? AND subject=?`)
    .bind(kind, day, subject).first<{ completed: number; inProgress: number }>();
  // A missing/corrupt read must never present a full allowance as verified.
  if (!row || !Number.isSafeInteger(row.completed) || row.completed < 0 || !Number.isSafeInteger(row.inProgress) || row.inProgress < 0) throw new Error('Allowance unavailable');
  const limit = await effectiveAllowanceLimit(db,subject,day,kind,quotaClass,role);
  return { limit, completed: row.completed, inProgress: row.inProgress, remaining: Math.max(0, limit-row.completed-row.inProgress), resetsAt };
}
