-- Customer master + strong linkage across billing and credit book
-- Run once in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS customers (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name        TEXT,
  phone       TEXT,
  gstin       TEXT,
  address     TEXT,
  notes       TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_phone_unique
  ON customers (shop_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_gstin_unique
  ON customers (shop_id, gstin);
CREATE INDEX IF NOT EXISTS idx_customers_shop_name
  ON customers (shop_id, name);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_all" ON customers;
CREATE POLICY "customers_all" ON customers FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP TRIGGER IF EXISTS trg_customers_updated ON customers;
CREATE TRIGGER trg_customers_updated
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bills_shop_customer
  ON bills (shop_id, customer_id);

ALTER TABLE credit_accounts
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_credit_accounts_shop_customer
  ON credit_accounts (shop_id, customer_id);

CREATE OR REPLACE FUNCTION normalize_phone(value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN regexp_replace(COALESCE(value, ''), '\D', '', 'g') ~ '^[0-9]{10}$'
      THEN regexp_replace(COALESCE(value, ''), '\D', '', 'g')
    ELSE NULL
  END
$$;

-- 1) Seed customer master from bills using strongest identifiers first.
INSERT INTO customers (shop_id, name, phone, gstin, address, created_at, updated_at)
SELECT
  b.shop_id,
  NULLIF(TRIM(b.customer_name), ''),
  regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g'),
  NULLIF(UPPER(TRIM(b.customer_gstin)), ''),
  NULLIF(TRIM(b.customer_address), ''),
  COALESCE(b.created_at, NOW()),
  COALESCE(b.updated_at, NOW())
FROM bills b
WHERE b.shop_id IS NOT NULL
  AND regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g') ~ '^[0-9]{10}$'
ON CONFLICT (shop_id, phone) DO UPDATE
SET
  name = COALESCE(customers.name, EXCLUDED.name),
  gstin = COALESCE(customers.gstin, EXCLUDED.gstin),
  address = COALESCE(customers.address, EXCLUDED.address),
  updated_at = NOW();

INSERT INTO customers (shop_id, name, phone, gstin, address, created_at, updated_at)
SELECT
  b.shop_id,
  NULLIF(TRIM(b.customer_name), ''),
  CASE
    WHEN regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g') ~ '^[0-9]{10}$'
      THEN regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g')
    ELSE NULL
  END,
  NULLIF(UPPER(TRIM(b.customer_gstin)), ''),
  NULLIF(TRIM(b.customer_address), ''),
  COALESCE(b.created_at, NOW()),
  COALESCE(b.updated_at, NOW())
FROM bills b
WHERE b.shop_id IS NOT NULL
  AND NULLIF(UPPER(TRIM(b.customer_gstin)), '') IS NOT NULL
ON CONFLICT (shop_id, gstin) DO UPDATE
SET
  name = COALESCE(customers.name, EXCLUDED.name),
  phone = COALESCE(customers.phone, EXCLUDED.phone),
  address = COALESCE(customers.address, EXCLUDED.address),
  updated_at = NOW();

-- Name/address-only rows (no phone/gstin) are best-effort seeded.
INSERT INTO customers (shop_id, name, phone, gstin, address, created_at, updated_at)
SELECT src.shop_id, src.name, NULL, NULL, src.address, src.created_at, src.updated_at
FROM (
  SELECT DISTINCT ON (
    b.shop_id,
    LOWER(TRIM(COALESCE(b.customer_name, ''))),
    LOWER(TRIM(COALESCE(b.customer_address, '')))
  )
    b.shop_id,
    NULLIF(TRIM(b.customer_name), '') AS name,
    NULLIF(TRIM(b.customer_address), '') AS address,
    COALESCE(b.created_at, NOW()) AS created_at,
    COALESCE(b.updated_at, NOW()) AS updated_at
  FROM bills b
  WHERE b.shop_id IS NOT NULL
    AND NULLIF(TRIM(b.customer_name), '') IS NOT NULL
    AND regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g') !~ '^[0-9]{10}$'
    AND NULLIF(UPPER(TRIM(b.customer_gstin)), '') IS NULL
  ORDER BY
    b.shop_id,
    LOWER(TRIM(COALESCE(b.customer_name, ''))),
    LOWER(TRIM(COALESCE(b.customer_address, ''))),
    b.updated_at DESC NULLS LAST
) src
WHERE NOT EXISTS (
  SELECT 1
  FROM customers c
  WHERE c.shop_id = src.shop_id
    AND COALESCE(LOWER(TRIM(c.name)), '') = COALESCE(LOWER(TRIM(src.name)), '')
    AND COALESCE(LOWER(TRIM(c.address)), '') = COALESCE(LOWER(TRIM(src.address)), '')
    AND c.phone IS NULL
    AND c.gstin IS NULL
);

-- 2) Link bills -> customers
UPDATE bills b
SET customer_id = c.id
FROM customers c
WHERE b.shop_id = c.shop_id
  AND b.customer_id IS NULL
  AND (
    (
      regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g') ~ '^[0-9]{10}$'
      AND c.phone = regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g')
    )
    OR (
      NULLIF(UPPER(TRIM(b.customer_gstin)), '') IS NOT NULL
      AND c.gstin = NULLIF(UPPER(TRIM(b.customer_gstin)), '')
    )
    OR (
      regexp_replace(COALESCE(b.customer_phone, ''), '\D', '', 'g') !~ '^[0-9]{10}$'
      AND NULLIF(UPPER(TRIM(b.customer_gstin)), '') IS NULL
      AND COALESCE(LOWER(TRIM(c.name)), '') = COALESCE(LOWER(TRIM(b.customer_name)), '')
      AND COALESCE(LOWER(TRIM(c.address)), '') = COALESCE(LOWER(TRIM(b.customer_address)), '')
    )
  );

-- 3) Link borrower credit accounts -> customers
UPDATE credit_accounts ca
SET customer_id = c.id
FROM customers c
WHERE ca.shop_id = c.shop_id
  AND ca.customer_id IS NULL
  AND ca.relation_type = 'borrower'
  AND normalize_phone(ca.phone) = c.phone;

UPDATE credit_accounts ca
SET customer_id = c.id
FROM customers c
WHERE ca.shop_id = c.shop_id
  AND ca.customer_id IS NULL
  AND ca.relation_type = 'borrower'
  AND normalize_phone(ca.phone) IS NULL
  AND COALESCE(LOWER(TRIM(ca.party_name)), '') = COALESCE(LOWER(TRIM(c.name)), '');

-- 4) Keep existing customer text fields filled from master where empty.
UPDATE bills b
SET
  customer_name = COALESCE(b.customer_name, c.name),
  customer_phone = COALESCE(b.customer_phone, c.phone),
  customer_gstin = COALESCE(b.customer_gstin, c.gstin),
  customer_address = COALESCE(b.customer_address, c.address)
FROM customers c
WHERE b.shop_id = c.shop_id
  AND b.customer_id = c.id;
