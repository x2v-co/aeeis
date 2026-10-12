CREATE TABLE IF NOT EXISTS aeeis_run_shares (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  run_id text NOT NULL REFERENCES aeeis_runs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS aeeis_run_shares_run_idx ON aeeis_run_shares(run_id, created_at);
