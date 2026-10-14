-- Binary (ZIP / image / PDF …) support for the Files page.
-- Run AFTER updates_2026_10_13_shop_files.sql.
--
-- Text/code files stay inline in shop_files.content, where TEXT preserves
-- indentation, tabs, unicode and special characters exactly as uploaded.
-- Binary files cannot live in a TEXT column because Postgres rejects NUL
-- bytes, so their bytes go to the private "shop-files" Storage bucket and
-- the row keeps only a pointer in storage_path.
--
-- Safe to re-run.

-- 'text'   → editable in the browser, content held in shop_files.content
-- 'binary' → download only, bytes held in Storage at storage_path
ALTER TABLE shop_files
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';

DO $$
BEGIN
  ALTER TABLE shop_files
    ADD CONSTRAINT shop_files_kind_check CHECK (kind IN ('text','binary'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE shop_files
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

-- ── Storage bucket for binary uploads ────────────────────────
-- Private bucket; the app reads through short-lived signed URLs.
-- file_size_limit matches the Supabase free-tier per-file cap (50 MB).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('shop-files', 'shop-files', FALSE, 52428800)
ON CONFLICT (id) DO UPDATE
  SET public = FALSE,
      file_size_limit = EXCLUDED.file_size_limit;

-- Objects are keyed as "<shop_id>/<uuid>-<filename>", so the first path
-- segment decides which shop the object belongs to.
DROP POLICY IF EXISTS "shop_files_objects_all" ON storage.objects;
CREATE POLICY "shop_files_objects_all" ON storage.objects FOR ALL
  USING (
    bucket_id = 'shop-files'
    AND (storage.foldername(name))[1]::uuid = ANY(auth_shop_ids())
  )
  WITH CHECK (
    bucket_id = 'shop-files'
    AND (storage.foldername(name))[1]::uuid = ANY(auth_shop_ids())
  );
