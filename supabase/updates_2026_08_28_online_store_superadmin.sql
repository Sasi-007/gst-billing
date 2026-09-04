-- Follow-up hardening for ecommerce module access.
-- Run after updates_2026_08_28_online_store.sql.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS ecommerce_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE;

DROP POLICY IF EXISTS "online_store_settings_public_read" ON online_store_settings;
CREATE POLICY "online_store_settings_public_read" ON online_store_settings FOR SELECT
  USING (
    is_online = TRUE
    AND EXISTS (
      SELECT 1
      FROM shops s
      WHERE s.id = online_store_settings.shop_id
        AND s.is_active = TRUE
        AND s.ecommerce_enabled = TRUE
    )
  );

DROP POLICY IF EXISTS "categories_public_online_read" ON categories;
CREATE POLICY "categories_public_online_read" ON categories FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM products p
      JOIN online_store_settings oss ON oss.shop_id = p.shop_id
      JOIN shops s ON s.id = p.shop_id
      WHERE p.category_id = categories.id
        AND p.shop_id = categories.shop_id
        AND p.is_active = TRUE
        AND p.sell_online = TRUE
        AND oss.is_online = TRUE
        AND s.is_active = TRUE
        AND s.ecommerce_enabled = TRUE
    )
  );

DROP POLICY IF EXISTS "products_public_online_read" ON products;
CREATE POLICY "products_public_online_read" ON products FOR SELECT
  USING (
    is_active = TRUE
    AND sell_online = TRUE
    AND EXISTS (
      SELECT 1
      FROM online_store_settings oss
      JOIN shops s ON s.id = oss.shop_id
      WHERE oss.shop_id = products.shop_id
        AND oss.is_online = TRUE
        AND s.is_active = TRUE
        AND s.ecommerce_enabled = TRUE
    )
  );
