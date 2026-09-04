-- Diagnostic only: checks which 2026-08-31 migrations are applied.
-- Safe to run anytime in Supabase SQL Editor. It does not change data/schema.

WITH checks AS (
  SELECT
    'updates_2026_08_31_product_local_names.sql' AS migration_file,
    'products.local_name column' AS check_name,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'products'
        AND column_name = 'local_name'
    ) AS is_applied
  UNION ALL
  SELECT
    'updates_2026_08_31_product_local_names.sql',
    'products.search_aliases column',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'products'
        AND column_name = 'search_aliases'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_product_local_names.sql',
    'products.bill_name_mode column',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'products'
        AND column_name = 'bill_name_mode'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_product_local_names.sql',
    'trg_product_search trigger',
    EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_product_search'
        AND NOT tgisinternal
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_product_name_suggestions.sql',
    'product_name_suggestions table',
    EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'product_name_suggestions'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_product_name_suggestions.sql',
    'product_name_suggestions active/language index',
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'product_name_suggestions'
        AND indexname = 'idx_product_name_suggestions_active'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_product_name_suggestions.sql',
    'product_name_suggestions aliases index',
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'product_name_suggestions'
        AND indexname = 'idx_product_name_suggestions_aliases'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_shop_product_name_suggestions.sql',
    'product_name_suggestions.shop_id column',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'product_name_suggestions'
        AND column_name = 'shop_id'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_shop_product_name_suggestions.sql',
    'shop-specific suggestion policies',
    EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'product_name_suggestions'
        AND policyname = 'product_name_suggestions_read_accessible'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_product_name_suggestion_scope.sql',
    'shops.use_global_name_suggestions column',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'shops'
        AND column_name = 'use_global_name_suggestions'
    )
  UNION ALL
  SELECT
    'updates_2026_08_31_print_templates.sql',
    'shops.print_template column',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'shops'
        AND column_name = 'print_template'
    )
)
SELECT
  migration_file,
  CASE
    WHEN bool_and(is_applied) THEN 'APPLIED'
    ELSE 'MISSING / PARTIAL'
  END AS status,
  string_agg(check_name, ', ' ORDER BY check_name) FILTER (WHERE NOT is_applied) AS missing_items
FROM checks
GROUP BY migration_file
ORDER BY migration_file;

