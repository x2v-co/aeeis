CREATE TABLE IF NOT EXISTS aeeis_thread_followups (
  thread_id text NOT NULL REFERENCES aeeis_threads(id),
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  run_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('reserved', 'completed')),
  request jsonb NOT NULL,
  parent_run_id text REFERENCES aeeis_runs(id),
  parent_revision integer,
  context_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (thread_id, key_hash)
);
CREATE INDEX IF NOT EXISTS aeeis_thread_followups_pending_idx ON aeeis_thread_followups(thread_id, key_hash) WHERE state='reserved';
