/** Accounting keeps minimal non-content evidence; source/request metadata may
 * never outlive the audio. Even an uncertain provider start loses private input
 * at the original 90-day boundary. It remains fenced for operator reconciliation. */
export async function purgeOperationContent(db: D1Database, now=Date.now()) {
  const cutoff=now-90*86400000;
  await db.batch([
    db.prepare('DELETE FROM import_cache WHERE expires_at<=?').bind(now),
    db.prepare(`UPDATE app_operations SET request_json='{}',result_json=NULL,cancel_requested=1,updated_at=?
      WHERE created_at<=? AND (request_json<>'{}' OR result_json IS NOT NULL)`).bind(now,cutoff),
    db.prepare(`UPDATE jobs SET status='failed',error='This split expired before it finished.'
      WHERE id IN(SELECT job_id FROM app_operations WHERE kind='split' AND state='queued' AND created_at<=?)`).bind(cutoff),
  ]);
}
