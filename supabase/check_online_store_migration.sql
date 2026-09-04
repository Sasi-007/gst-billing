-- Diagnostic only: checks which online-store migration objects exist.
-- Safe to run anytime in Supabase SQL Editor.

SELECT
  'shops.ecommerce_enabled column' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'ecommerce_enabled'
  ) AS exists;

SELECT
  'shops.delivery_enabled column' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shops'
      AND column_name = 'delivery_enabled'
  ) AS exists;

SELECT
  'products.sell_online column' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'sell_online'
  ) AS exists;

SELECT
  table_name,
  EXISTS (
    SELECT 1
    FROM information_schema.tables t
    WHERE t.table_schema = 'public'
      AND t.table_name = required.table_name
  ) AS exists
FROM (
  VALUES
    ('online_store_settings'),
    ('customer_addresses'),
    ('online_orders'),
    ('online_order_items'),
    ('online_delivery_assignments')
) AS required(table_name);

SELECT
  routine_name,
  EXISTS (
    SELECT 1
    FROM information_schema.routines r
    WHERE r.specific_schema = 'public'
      AND r.routine_name = required.routine_name
  ) AS exists
FROM (
  VALUES
    ('get_next_online_order_no'),
    ('convert_online_order_to_bill')
) AS required(routine_name);

SELECT
  tablename,
  policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN (
    'online_store_settings_staff_all',
    'online_store_settings_public_read',
    'customer_addresses_staff_all',
    'online_orders_staff_all',
    'online_orders_public_insert',
    'online_order_items_staff_all',
    'online_order_items_public_insert',
    'online_delivery_assignments_staff_all',
    'shops_public_online_read',
    'categories_public_online_read',
    'products_public_online_read'
  )
ORDER BY tablename, policyname;
