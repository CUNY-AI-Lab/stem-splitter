/** Human pacing is independent of Gateway spend. Only completed signed-in
 * requests count; active reservations stop simultaneous tabs exceeding five. */
export const LISTENING_TURNS = 5;
export const LISTENING_COOLDOWN_MS = 5 * 60_000;
export const LISTENING_ATTEMPT_WINDOW_MS = 60_000;
export const LISTENING_ATTEMPTS_PER_WINDOW = 10;
const terminal = "'succeeded','partial','failed','cancelled'";
export interface ListeningUsage {
  ok: true; limit: number; successfulTurns: number; remainingTurns: number;
  inProgress: number; cooldownUntil: string | null; serverTime: string; retryAfterSeconds: number;
}
/** Expiry fences the old runner. It never regenerates an uncertain provider call. */
export async function recoverListeningOperations(db: D1Database, subject: string, now=Date.now()) {
  await db.prepare(`UPDATE app_operations SET state=CASE WHEN result_json IS NULL THEN 'failed' ELSE 'partial' END,
    error_code=CASE WHEN result_json IS NULL THEN 'no_usable_response' ELSE 'delivery_uncertain' END,updated_at=?
    WHERE subject=? AND kind IN ('chat','guide') AND ((state IN ('running','starting','reconciling') AND lease_until<=?)
      OR (state='queued' AND created_at<=?))`).bind(now,subject,now,now-90_000).run();
}
export function prepareListeningCycle(db: D1Database, subject: string, now: number) {
  return [
    db.prepare('INSERT OR IGNORE INTO listening_cycles(subject) VALUES(?)').bind(subject),
    db.prepare(`UPDATE listening_cycles SET generation=generation+1,completed=0,cooldown_until=0
      WHERE subject=? AND cooldown_until>0 AND cooldown_until<=?`).bind(subject,now),
  ];
}
export async function listeningUsage(db: D1Database, subject: string, now=Date.now()): Promise<ListeningUsage> {
  const row=await db.prepare(`SELECT c.completed,c.cooldown_until,
    (SELECT COUNT(*) FROM listening_turn_reservations r JOIN app_operations o ON o.id=r.operation_id
      WHERE r.subject=c.subject AND r.generation=c.generation AND o.state NOT IN (${terminal})) AS active
    FROM listening_cycles c WHERE c.subject=?`).bind(subject).first<{completed:number;cooldown_until:number;active:number}>();
  const reset=Boolean(row?.cooldown_until && row.cooldown_until<=now);
  const completed=reset?0:row?.completed??0, inProgress=reset?0:row?.active??0;
  const until=!reset&&row?.cooldown_until ? row.cooldown_until : null;
  return {ok:true,limit:LISTENING_TURNS,successfulTurns:completed,inProgress,
    remainingTurns:Math.max(0,LISTENING_TURNS-completed-inProgress),
    cooldownUntil:until ? new Date(until).toISOString() : null,serverTime:new Date(now).toISOString(),
    retryAfterSeconds:until ? Math.max(0,Math.ceil((until-now)/1000)) : inProgress+completed>=LISTENING_TURNS ? 2 : 0};
}

/** Guest preview stays attached to one saved split across reloads and UTC days.
 * Pending requests hold places, while failed and cached requests release them. */
export async function guestListeningUsage(db: D1Database, subject: string, jobId: string, now=Date.now()) {
  const row=await db.prepare(`SELECT
    SUM(CASE WHEN state IN ('succeeded','partial') THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN state NOT IN (${terminal}) THEN 1 ELSE 0 END) AS active
    FROM app_operations WHERE subject=? AND quota_class='guest' AND job_id=? AND kind IN ('chat','guide')`)
    .bind(subject,jobId).first<{completed:number|null;active:number|null}>();
  const successfulTurns=row?.completed??0,inProgress=row?.active??0;
  return {ok:true,scope:'recording' as const,jobId,limit:LISTENING_TURNS,successfulTurns,inProgress,
    remainingTurns:Math.max(0,LISTENING_TURNS-successfulTurns-inProgress),
    signInRequired:successfulTurns>=LISTENING_TURNS,cooldownUntil:null,serverTime:new Date(now).toISOString(),
    retryAfterSeconds:inProgress>0 && successfulTurns+inProgress>=LISTENING_TURNS?2:0};
}
