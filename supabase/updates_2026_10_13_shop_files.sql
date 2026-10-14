-- Shop-scoped file upload/view/edit feature.
-- Stores uploaded text/code content as-is (TEXT has no practical size
-- limit here, and Postgres never reformats or truncates the value).
-- Run once in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS shop_files (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_files_shop_name
  ON shop_files (shop_id, name);

ALTER TABLE shop_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_files_all" ON shop_files;
CREATE POLICY "shop_files_all" ON shop_files FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP TRIGGER IF EXISTS trg_shop_files_updated ON shop_files;
CREATE TRIGGER trg_shop_files_updated
  BEFORE UPDATE ON shop_files
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
