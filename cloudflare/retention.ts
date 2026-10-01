export async function purgeExpiredListeningConversations(db: D1Database): Promise<number> {
  const result = await db.prepare("DELETE FROM listening_conversations WHERE expires_at <= datetime('now')").run();
  return result.meta.changes ?? 0;
}
