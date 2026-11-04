CREATE TABLE IF NOT EXISTS aeeis_channel_metadata (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  room_id text NOT NULL,
  category text NOT NULL DEFAULT 'general' CHECK (category IN ('product', 'topic', 'general')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id)
);
-- Freeze legacy types without guessing from titles. Repeated init never changes an explicit type.
UPDATE aeeis_rooms SET state = state || jsonb_build_object('chat', CASE
  WHEN state->>'description' = '私聊' THEN 'direct'
  WHEN state->>'description' = '群聊' THEN 'group' ELSE 'unclassified' END)
WHERE state->>'chat' IS NULL;
ALTER TABLE aeeis_channel_metadata ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_channel_metadata;
CREATE POLICY aeeis_tenant ON aeeis_channel_metadata
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
-- Rollback: stop metadata writes and export classifications before running as owner:
-- BEGIN; DROP TABLE IF EXISTS aeeis_channel_metadata; COMMIT;
-- Keep Room chat, titles, status, messages and ids. Disable this init in the rollback binary.
