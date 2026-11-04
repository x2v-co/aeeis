CREATE TABLE IF NOT EXISTS aeeis_bot_dialogues (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  bot_id text NOT NULL,
  conversation_id text NOT NULL,
  room_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('preparing', 'backfilling', 'ready', 'conflict')),
  version bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, bot_id),
  UNIQUE (tenant_id, owner, conversation_id),
  UNIQUE (tenant_id, owner, room_id)
);
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogue_room_aliases (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  alias_room_id text NOT NULL,
  canonical_room_id text NOT NULL,
  bot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, alias_room_id),
  CHECK (alias_room_id <> canonical_room_id)
);
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogue_operations (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  operation_key text NOT NULL,
  bot_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ensure', 'import', 'delivery')),
  source_id text NOT NULL,
  target_id text,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'conflict')),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, operation_key),
  UNIQUE (tenant_id, owner, bot_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS aeeis_bot_dialogue_operations_pending_idx
  ON aeeis_bot_dialogue_operations (tenant_id, owner, updated_at, operation_key)
  WHERE status = 'pending';
ALTER TABLE aeeis_bot_dialogues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_bot_dialogues;
CREATE POLICY aeeis_tenant ON aeeis_bot_dialogues
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
ALTER TABLE aeeis_bot_dialogue_room_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_bot_dialogue_room_aliases;
CREATE POLICY aeeis_tenant ON aeeis_bot_dialogue_room_aliases
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
ALTER TABLE aeeis_bot_dialogue_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_bot_dialogue_operations;
CREATE POLICY aeeis_tenant ON aeeis_bot_dialogue_operations
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
-- Rollback: disable the professional dialogue entry first; retain/export canonical Conversations.
-- BEGIN; DROP TABLE IF EXISTS aeeis_bot_dialogue_operations; DROP TABLE IF EXISTS aeeis_bot_dialogue_room_aliases; DROP TABLE IF EXISTS aeeis_bot_dialogues; COMMIT;
-- DDL rollback does not copy new Conversation messages back into SessionEvents.
