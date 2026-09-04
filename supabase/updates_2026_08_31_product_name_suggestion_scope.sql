-- Per-shop control for product name suggestions.
-- Run after updates_2026_08_31_shop_product_name_suggestions.sql.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS use_global_name_suggestions BOOLEAN NOT NULL DEFAULT TRUE;
