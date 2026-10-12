CREATE TABLE IF NOT EXISTS aeeis_threads (
  id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL,
  title text, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS aeeis_threads_owner_idx ON aeeis_threads(tenant_id, owner, created_at, id);
ALTER TABLE aeeis_runs
  ADD COLUMN IF NOT EXISTS thread_id text REFERENCES aeeis_threads(id),
  ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES aeeis_runs(id),
  ADD COLUMN IF NOT EXISTS thread_sequence integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='aeeis_runs_thread_membership_check' AND conrelid='aeeis_runs'::regclass) THEN
    ALTER TABLE aeeis_runs ADD CONSTRAINT aeeis_runs_thread_membership_check CHECK (
      (thread_id IS NULL AND parent_run_id IS NULL AND thread_sequence IS NULL)
      OR (thread_id IS NOT NULL AND thread_sequence IS NOT NULL AND thread_sequence > 0
        AND (parent_run_id IS NULL OR parent_run_id <> id))
    ) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS aeeis_runs_thread_sequence_idx ON aeeis_runs(thread_id, thread_sequence) WHERE thread_id IS NOT NULL;
