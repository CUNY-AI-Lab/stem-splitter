-- Operator-issued, dated capacity grants. No public mutation endpoint.
CREATE TABLE IF NOT EXISTS admin_testing_grants (
  subject TEXT NOT NULL REFERENCES app_users(subject),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  extra_splits INTEGER NOT NULL CHECK(typeof(extra_splits)='integer' AND extra_splits BETWEEN 1 AND 30),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(subject,day)
);
