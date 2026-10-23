-- Short-lived guest reply recovery stays separate from member identity and accounting.
CREATE TABLE IF NOT EXISTS guest_listening_reply_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES app_operations(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES guest_sessions(subject) ON DELETE CASCADE,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guest_listening_reply_expiry ON guest_listening_reply_receipts(expires_at);
