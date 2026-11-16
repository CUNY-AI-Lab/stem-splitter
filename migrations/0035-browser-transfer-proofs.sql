-- Short-lived, single-use authorization for explicit browser-local state
-- recovery between the original Worker and the authenticated Tools mount.
CREATE TABLE IF NOT EXISTS browser_transfer_proofs (
  proof_hash TEXT PRIMARY KEY CHECK(length(proof_hash)=64),
  subject TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('member','guest')),
  source_origin TEXT NOT NULL,
  destination_origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('issued','source_verified','staged','consumed')),
  created_at INTEGER NOT NULL,
  source_verified_at INTEGER,
  consumed_at INTEGER,
  CHECK(source_origin<>destination_origin),
  CHECK((state IN ('issued') AND source_verified_at IS NULL AND consumed_at IS NULL)
    OR (state IN ('source_verified','staged') AND source_verified_at IS NOT NULL AND consumed_at IS NULL)
    OR (state='consumed' AND source_verified_at IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS browser_transfer_proofs_expiry ON browser_transfer_proofs(expires_at);

CREATE TRIGGER IF NOT EXISTS browser_transfer_proofs_transition BEFORE UPDATE ON browser_transfer_proofs
WHEN NEW.proof_hash<>OLD.proof_hash OR NEW.subject<>OLD.subject OR NEW.actor_kind<>OLD.actor_kind
  OR NEW.source_origin<>OLD.source_origin OR NEW.destination_origin<>OLD.destination_origin
  OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at
  OR NOT ((OLD.state='issued' AND NEW.state='source_verified')
    OR (OLD.state='source_verified' AND NEW.state='staged')
    OR (OLD.state='staged' AND NEW.state='consumed'))
BEGIN SELECT RAISE(ABORT,'invalid browser transfer transition'); END;

CREATE TRIGGER IF NOT EXISTS browser_transfer_proofs_no_delete BEFORE DELETE ON browser_transfer_proofs
WHEN OLD.expires_at>(julianday('now')-2440587.5)*86400000
BEGIN SELECT RAISE(ABORT,'unexpired browser transfer proof'); END;
