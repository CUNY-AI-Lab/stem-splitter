/** Request-count guard, not a monetary balance or a substitute for Gateway authorization. */
export const SIGNED_IN_SPLITS_PER_DAY = 10;

export function dailyWindow(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const resetsAt = new Date(`${day}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return { day, resetsAt: resetsAt.toISOString(), retryAfter: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)) };
}

export async function splitAllowance(db: D1Database, subject: string, now = new Date()) {
  const { day, resetsAt } = dailyWindow(now);
  const row = await db.prepare("SELECT COUNT(*) AS used FROM app_request_reservations WHERE scope = 'split' AND day = ? AND subject = ?")
    .bind(day, subject).first<{ used: number }>();
  // A missing/corrupt read must never present a full allowance as verified.
  if (!row || !Number.isSafeInteger(row.used) || row.used < 0) throw new Error('Allowance unavailable');
  return { limit: SIGNED_IN_SPLITS_PER_DAY, used: row.used, remaining: Math.max(0, SIGNED_IN_SPLITS_PER_DAY - row.used), resetsAt };
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
