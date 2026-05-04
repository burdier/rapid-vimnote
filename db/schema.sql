CREATE TABLE IF NOT EXISTS notes (
  topic_id TEXT PRIMARY KEY,
  body_cipher TEXT NOT NULL,
  iv TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  topic_id TEXT,
  body_cipher TEXT NOT NULL,
  iv TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares (expires_at);
