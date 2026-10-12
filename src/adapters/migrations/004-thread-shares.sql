CREATE TABLE IF NOT EXISTS aeeis_thread_shares (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  thread_id text NOT NULL REFERENCES aeeis_threads(id) ON DELETE CASCADE,
  through_sequence integer NOT NULL CHECK (through_sequence >= 0),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS aeeis_thread_shares_thread_idx ON aeeis_thread_shares(thread_id, created_at);
