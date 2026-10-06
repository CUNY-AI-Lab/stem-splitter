/** App allowances are independent of provider spend and Gateway authorization. */
export const SIGNED_IN_SPLITS_PER_DAY = 15;
export const HUMAN_INPUTS_PER_DAY = 50;

export function dailyWindow(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const resetsAt = new Date(`${day}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return { day, resetsAt: resetsAt.toISOString(), retryAfter: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)) };
}

export async function splitAllowance(db: D1Database, subject: string, now = new Date()) {
  return operationAllowance(db, subject, 'split', now);
}

export async function operationAllowance(db: D1Database, subject: string, kind: 'split' | 'chat', now = new Date()) {
  const { day, resetsAt } = dailyWindow(now);
  const row = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state IN ('succeeded','partial') THEN 1 ELSE 0 END),0) AS completed,
    COALESCE(SUM(CASE WHEN state NOT IN ('succeeded','partial','failed','cancelled') THEN 1 ELSE 0 END),0) AS inProgress
    FROM app_operations WHERE kind=? AND day=? AND subject=?`)
    .bind(kind, day, subject).first<{ completed: number; inProgress: number }>();
  // A missing/corrupt read must never present a full allowance as verified.
  if (!row || !Number.isSafeInteger(row.completed) || row.completed < 0 || !Number.isSafeInteger(row.inProgress) || row.inProgress < 0) throw new Error('Allowance unavailable');
  const limit = kind === 'split' ? SIGNED_IN_SPLITS_PER_DAY : HUMAN_INPUTS_PER_DAY;
  return { limit, completed: row.completed, inProgress: row.inProgress, remaining: Math.max(0, limit-row.completed-row.inProgress), resetsAt };
}

/** One atomic insert: parallel requests and different isolates share the same count.
 * Reserve before imports/provider work; uncertain or failed attempts are not refunded.
 * Only call after verified CAIL identity, Admission and local suspension checks.
 */
export async function reserveDailyRequest(db: D1Database, subject: string, scope: 'split' | 'guide', now = new Date()) {
  const window = dailyWindow(now);
  const personalLimit = scope === 'split' ? SIGNED_IN_SPLITS_PER_DAY : 100;
  // No shared/class split ceiling. Preserve the legacy non-Gateway guide guard.
  const sharedGuard = scope === 'guide'
    ? 'AND (SELECT COUNT(*) FROM app_request_reservations WHERE scope = ? AND day = ?) < ?' : '';
  const bindings: (string | number)[] = [crypto.randomUUID(), subject, scope, window.day, scope, window.day, subject, personalLimit];
  if (scope === 'guide') bindings.push(scope, window.day, 500);
  const reservation = await db.prepare(`INSERT INTO app_request_reservations (id, subject, scope, day)
    SELECT ?, ?, ?, ? WHERE
    (SELECT COUNT(*) FROM app_request_reservations WHERE scope = ? AND day = ? AND subject = ?) < ? ${sharedGuard}`)
    .bind(...bindings).run();
  return { allowed: reservation.meta.changes === 1, ...window, limit: personalLimit };
}
