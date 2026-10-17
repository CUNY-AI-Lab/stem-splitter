import type { Env } from '../env';

// A job whose provider can no longer answer (a self-hosted service that went
// down mid-split, or a row whose start never recorded an id) would otherwise
// poll as "processing" forever. Past this age the next poll fails it, so the
// student sees a clear retry message instead of a spinner. The poll route
// applies it only when the provider did not answer that poll: a provider that
// still reports the job as running is never overruled, so a slow but live split
// (a long queue, a long song) is not failed while it is still being billed.

export const DEFAULT_SEPARATION_STALL_MINUTES = 60;
export const STALLED_JOB_MESSAGE = 'This split took too long and was stopped. Start the split again.';

/** Whole minutes from SEPARATION_STALL_MINUTES; 0 disables the deadline. */
export function separationStallMinutes(env: Pick<Env, 'SEPARATION_STALL_MINUTES'>): number {
  // String(): a numeric Wrangler var arrives as a number, not a string.
  const raw = String(env.SEPARATION_STALL_MINUTES ?? '').trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return DEFAULT_SEPARATION_STALL_MINUTES;
  return Number(raw);
}

/** Same text format as SQLite datetime('now'), which fills jobs.created_at (UTC). */
function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** True when a jobs.created_at value is older than the deadline (no database write). */
export function stallDeadlinePassed(createdAt: string, minutes: number, now: Date = new Date()): boolean {
  if (minutes <= 0) return false;
  const created = Date.parse(`${createdAt.replace(' ', 'T')}Z`);
  return Number.isFinite(created) && now.getTime() - created >= minutes * 60_000;
}

/**
 * Fail one pending or processing job older than the deadline. Returns true when
 * it changed the row. Rows that are ingesting belong to the lease logic in
 * src/index.ts and are never touched here.
 */
export async function expireStalledJob(
  db: Env['DB'],
  jobId: string,
  minutes: number,
  now: Date = new Date()
): Promise<boolean> {
  if (minutes <= 0) return false;
  const cutoff = sqliteUtc(new Date(now.getTime() - minutes * 60_000));
  const result = await db
    .prepare(
      "UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND status IN ('pending', 'processing') AND created_at <= ?"
    )
    .bind(STALLED_JOB_MESSAGE, jobId, cutoff)
    .run();
  return Boolean(result.meta.changes);
}
