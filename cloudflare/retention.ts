export async function purgeExpiredListeningConversations(db: D1Database): Promise<number> {
  const result = await db.prepare("DELETE FROM listening_conversations WHERE expires_at <= datetime('now')").run();
  await db.batch([
    db.prepare("DELETE FROM guest_listening_conversations WHERE expires_at<=datetime('now') OR EXISTS(SELECT 1 FROM guest_sessions s WHERE s.subject=guest_listening_conversations.subject AND (s.revoked_at IS NOT NULL OR s.expires_at<=CAST(strftime('%s','now') AS INTEGER)*1000))"),
    db.prepare("DELETE FROM course_messages WHERE EXISTS(SELECT 1 FROM course_conversations c WHERE c.job_id=course_messages.job_id AND c.subject=course_messages.subject AND c.expires_at<=datetime('now')) OR NOT EXISTS(SELECT 1 FROM jobs WHERE id=course_messages.job_id AND created_at>datetime('now','-90 days'))"),
    db.prepare("DELETE FROM course_turns WHERE EXISTS(SELECT 1 FROM course_conversations c WHERE c.job_id=course_turns.job_id AND c.subject=course_turns.subject AND c.expires_at<=datetime('now')) OR NOT EXISTS(SELECT 1 FROM jobs WHERE id=course_turns.job_id AND created_at>datetime('now','-90 days'))"),
    db.prepare("DELETE FROM course_conversations WHERE expires_at<=datetime('now') OR NOT EXISTS(SELECT 1 FROM jobs WHERE id=course_conversations.job_id AND created_at>datetime('now','-90 days'))"),
    db.prepare("DELETE FROM course_guides WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE id=course_guides.job_id AND created_at>datetime('now','-90 days'))"),
  ]);
  return result.meta.changes ?? 0;
}
