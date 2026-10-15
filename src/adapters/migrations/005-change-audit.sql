CREATE TABLE IF NOT EXISTS aeeis_change_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream text NOT NULL,
  id text NOT NULL,
  entry jsonb NOT NULL,
  UNIQUE(stream, id),
  CHECK (entry->>'id' = id),
  CHECK (entry->>'subjectKind' IN ('memory', 'skill')),
  CHECK (entry->>'op' IN ('create', 'update', 'delete', 'rollback'))
);
CREATE INDEX IF NOT EXISTS aeeis_change_audit_stream_idx ON aeeis_change_audit(stream, sequence);
CREATE OR REPLACE FUNCTION aeeis_change_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Change audit entries are append-only';
END;
$$;
DROP TRIGGER IF EXISTS aeeis_change_audit_immutable ON aeeis_change_audit;
CREATE TRIGGER aeeis_change_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON aeeis_change_audit
FOR EACH STATEMENT EXECUTE FUNCTION aeeis_change_audit_append_only();
