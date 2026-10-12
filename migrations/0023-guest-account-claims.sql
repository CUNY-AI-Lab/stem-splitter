-- Ownership provenance only. Never rewrite or recount operation usage.
CREATE TABLE IF NOT EXISTS guest_account_claims (
  guest_subject TEXT PRIMARY KEY REFERENCES guest_sessions(subject),
  member_subject TEXT NOT NULL REFERENCES app_users(subject),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS guest_account_claim_immutable BEFORE UPDATE ON guest_account_claims
BEGIN
  SELECT RAISE(ABORT,'immutable guest account claim');
END;
CREATE TABLE IF NOT EXISTS guest_job_claims (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  guest_subject TEXT NOT NULL REFERENCES guest_account_claims(guest_subject),
  member_subject TEXT NOT NULL REFERENCES app_users(subject)
);
CREATE TRIGGER IF NOT EXISTS guest_job_claim_immutable BEFORE UPDATE ON guest_job_claims
BEGIN
  SELECT RAISE(ABORT,'immutable guest job claim');
END;
