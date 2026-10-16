CREATE TABLE IF NOT EXISTS account_display_names (
  subject TEXT PRIMARY KEY REFERENCES app_users(subject),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
  updated_at INTEGER NOT NULL
);
