-- Signed-in Listening Guy pacing, separate from provider spend and guest quotas.
-- No historical turns are inferred or backfilled. Apply before the new worker.
CREATE TABLE IF NOT EXISTS listening_cycles (
  subject TEXT PRIMARY KEY REFERENCES app_users(subject) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed BETWEEN 0 AND 5),
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS listening_turn_reservations (
  operation_id TEXT PRIMARY KEY REFERENCES app_operations(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES listening_cycles(subject) ON DELETE CASCADE,
  generation INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listening_reservations_subject ON listening_turn_reservations(subject,generation);
CREATE INDEX IF NOT EXISTS listening_attempt_window ON app_operations(subject,created_at) WHERE kind IN ('chat','guide');
-- Completion and the fifth-turn cooldown commit with the operation itself.
-- Terminal-operation fencing makes repeated receipts and late runners harmless.
CREATE TRIGGER IF NOT EXISTS listening_success AFTER UPDATE OF state ON app_operations
WHEN NEW.state='succeeded' AND OLD.state<>'succeeded' AND NEW.quota_class='member' AND NEW.kind IN ('chat','guide')
BEGIN
  UPDATE listening_cycles SET completed=completed+1,
    cooldown_until=CASE WHEN completed=4 THEN NEW.updated_at+300000 ELSE cooldown_until END
    WHERE subject=NEW.subject AND completed<5 AND EXISTS(
      SELECT 1 FROM listening_turn_reservations r WHERE r.operation_id=NEW.id
        AND r.subject=listening_cycles.subject AND r.generation=listening_cycles.generation);
END;
-- Private, short-lived personal reply readback; never copied to accounting or
-- instructor APIs. Course replies remain in their existing conversation tables.
CREATE TABLE IF NOT EXISTS listening_reply_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES app_operations(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES app_users(subject) ON DELETE CASCADE,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listening_reply_expiry ON listening_reply_receipts(expires_at);
