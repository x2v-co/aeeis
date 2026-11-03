CREATE TABLE IF NOT EXISTS aeeis_channel_noise_settings (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  room_id text NOT NULL,
  settings jsonb NOT NULL,
  PRIMARY KEY (tenant_id, owner, room_id)
);
ALTER TABLE aeeis_channel_noise_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_channel_noise_settings;
CREATE POLICY aeeis_tenant ON aeeis_channel_noise_settings
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
