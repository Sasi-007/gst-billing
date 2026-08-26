-- ============================================================
-- GST BILLING — SQL UPDATES  (2026-08-11)
-- Run in Supabase SQL Editor AFTER applying schema_complete.sql
-- ============================================================

-- ── 1. Backfill search_text for products inserted before the trigger existed ─
UPDATE products
SET search_text = lower(
  COALESCE(name,'')    || ' ' ||
  COALESCE(brand,'')   || ' ' ||
  COALESCE(barcode,'') || ' ' ||
  array_to_string(COALESCE(tags,'{}'), ' ')
)
WHERE search_text IS NULL OR search_text = '';

-- ── 2. Add refreshed superadmin RLS policies ─────────────────────────────────
-- These allow users listed in NEXT_PUBLIC_SUPERADMIN_EMAILS to be managed via
-- the service-role API route (/api/admin) without additional DB changes.
-- No SQL changes required — superadmin access is enforced at the API route level.

-- ── 3. Ensure gst_rate constraint allows common Indian GST slabs ──────────────
-- If you added gst_rate CHECK constraint in schema_complete.sql and need to
-- relax it for custom rates, run:
-- ALTER TABLE products DROP CONSTRAINT IF EXISTS products_gst_rate_check;
-- ALTER TABLE products ADD CONSTRAINT products_gst_rate_check
--   CHECK (gst_rate >= 0 AND gst_rate <= 28);

-- ── 4. Add is_superadmin metadata support via SQL (optional) ─────────────────
-- If you prefer DB-level superadmin flag over env var, set it in Supabase
-- Auth dashboard: Authentication → Users → click user → Edit Metadata:
--   { "is_superadmin": true }
-- OR via SQL (replace USER_UUID with actual uuid from auth.users):
-- UPDATE auth.users
-- SET raw_user_meta_data = raw_user_meta_data || '{"is_superadmin": true}'
-- WHERE id = 'USER_UUID';

-- ── 5. Fix products table: ensure gst_rate accepts 3% (common grocery slab) ──
-- The CHECK constraint in schema_complete.sql already includes 3.
-- If your DB was created before that constraint was added:
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_gst_rate_check;

-- ── 6. Verify triggers are active ────────────────────────────────────────────
-- Run these SELECT statements to confirm triggers exist:
SELECT tgname, tgrelid::regclass AS table_name, tgenabled
FROM pg_trigger
WHERE tgname IN (
  'trg_product_search',
  'trg_sale_stock',
  'trg_purchase_stock',
  'trg_shops_updated'
)
ORDER BY tgname;

-- Expected: 4 rows, all with tgenabled = 'O' (origin/enabled)

-- ── 7. Index for bill lookups by date range (if missing) ─────────────────────
CREATE INDEX IF NOT EXISTS idx_bills_shop_date_type
  ON bills (shop_id, date, bill_type);

CREATE INDEX IF NOT EXISTS idx_purchase_bills_supplier
  ON purchase_bills (shop_id, supplier_id);

-- ── 8. View: outstanding payments from suppliers ─────────────────────────────
CREATE OR REPLACE VIEW v_supplier_outstanding AS
SELECT
  pb.shop_id,
  pb.supplier_id,
  s.name AS supplier_name,
  COUNT(*)                             AS bill_count,
  SUM(pb.total)                        AS total_amount,
  SUM(pb.paid_amount)                  AS paid_amount,
  SUM(pb.total - pb.paid_amount)       AS outstanding
FROM purchase_bills pb
JOIN suppliers s ON s.id = pb.supplier_id
WHERE pb.payment_status <> 'paid'
GROUP BY pb.shop_id, pb.supplier_id, s.name;

-- ── 9. Ensure free-text bill items (product_id IS NULL) don't break triggers ──
-- The stock trigger skips rows where product_id IS NULL, which is correct.
-- Verify:
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_sale_stock';
-- (Trigger function fn_stock_on_sale checks: IF NEW.product_id IS NOT NULL)
