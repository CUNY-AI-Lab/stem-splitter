/** Accounting keeps minimal non-content evidence; source/request metadata may
 * never outlive the audio. Even an uncertain provider start loses private input
 * at the original 90-day boundary. It remains fenced for operator reconciliation. */
export async function purgeOperationContent(db: D1Database, now=Date.now()) {
  const cutoff=now-90*86400000;
  await db.batch([
    db.prepare('DELETE FROM usage_events WHERE at<?').bind(now-30*86400000),
    db.prepare('DELETE FROM operation_events WHERE at<?').bind(now-30*86400000),
    db.prepare('DELETE FROM import_cache WHERE expires_at<=?').bind(now),
    db.prepare(`DELETE FROM listening_reply_receipts WHERE expires_at<=? OR job_id IN
      (SELECT id FROM jobs WHERE created_at<=datetime(? / 1000,'unixepoch','-90 days'))`).bind(now,now),
    db.prepare(`DELETE FROM guest_listening_reply_receipts WHERE expires_at<=? OR subject IN
      (SELECT subject FROM guest_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL) OR job_id IN
      (SELECT id FROM jobs WHERE created_at<=datetime(? / 1000,'unixepoch','-90 days'))`).bind(now,now,now),
    db.prepare(`UPDATE app_operations SET request_json='{}',result_json=NULL,cancel_requested=1,updated_at=?
      WHERE created_at<=? AND (request_json<>'{}' OR result_json IS NOT NULL)`).bind(now,cutoff),
    db.prepare(`UPDATE jobs SET status='failed',error='This split expired before it finished.'
      WHERE id IN(SELECT job_id FROM app_operations WHERE kind='split' AND state='queued' AND created_at<=?)`).bind(cutoff),
  ]);
}
