-- Shop-specific product name suggestions.
-- Run after updates_2026_08_31_product_name_suggestions.sql.

ALTER TABLE product_name_suggestions
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_product_name_suggestions_shop
  ON product_name_suggestions (shop_id, is_active);

DROP POLICY IF EXISTS "product_name_suggestions_read_active" ON product_name_suggestions;
CREATE POLICY "product_name_suggestions_read_accessible" ON product_name_suggestions FOR SELECT
  USING (
    is_active = TRUE
    AND (
      shop_id IS NULL
      OR shop_id = ANY(auth_shop_ids())
    )
  );

DROP POLICY IF EXISTS "product_name_suggestions_shop_insert" ON product_name_suggestions;
CREATE POLICY "product_name_suggestions_shop_insert" ON product_name_suggestions FOR INSERT
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "product_name_suggestions_shop_update" ON product_name_suggestions;
CREATE POLICY "product_name_suggestions_shop_update" ON product_name_suggestions FOR UPDATE
  USING (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));
