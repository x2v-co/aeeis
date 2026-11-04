-- PR3: relation and rebuildable control projection; audit stays in SessionEvent.
-- Rollback (stop commands/pump and export these tables first):
-- BEGIN; DROP TABLE IF EXISTS aeeis_task_board_controls; DROP TABLE IF EXISTS aeeis_room_tasks; COMMIT;
-- Revert init/TENANT_POLICIES too; retain a reader for channel-task-action/2 audits.
CREATE TABLE IF NOT EXISTS aeeis_room_tasks (
  tenant_id text NOT NULL, owner text NOT NULL, room_id text NOT NULL,
  conversation_id text NOT NULL, task_id text NOT NULL, source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id, conversation_id, task_id)
);
CREATE INDEX IF NOT EXISTS aeeis_room_tasks_task_idx ON aeeis_room_tasks (tenant_id, owner, conversation_id, task_id);
CREATE TABLE IF NOT EXISTS aeeis_task_board_controls (
  tenant_id text NOT NULL, owner text NOT NULL, room_id text NOT NULL,
  conversation_id text NOT NULL, task_id text NOT NULL, version bigint NOT NULL DEFAULT 0,
  observed_run_id text, observed_run_revision bigint,
  override_column text CHECK (override_column IN ('capture','ready','doing','blocked','review','done')),
  accepted_run_id text, last_action_event_id text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id, conversation_id, task_id),
  CHECK ((observed_run_id IS NULL) = (observed_run_revision IS NULL))
);
ALTER TABLE aeeis_room_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_room_tasks;
CREATE POLICY aeeis_tenant ON aeeis_room_tasks
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
ALTER TABLE aeeis_task_board_controls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_task_board_controls;
CREATE POLICY aeeis_tenant ON aeeis_task_board_controls
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
