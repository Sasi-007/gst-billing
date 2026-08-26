-- Finance module support:
-- 1) snapshot product cost on sales lines for historical profit reports
-- 2) track business expenses separately
-- 3) track owner investments separately

ALTER TABLE bill_items
  ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2) DEFAULT 0;

UPDATE bill_items AS bi
SET cost_price = COALESCE(p.purchase_price, 0)
FROM products AS p
WHERE bi.product_id = p.id
  AND (bi.cost_price IS NULL OR bi.cost_price = 0);

CREATE TABLE IF NOT EXISTS expenses (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id       UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  title         TEXT NOT NULL,
  category      TEXT,
  amount        DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode  TEXT DEFAULT 'cash'
                 CHECK (payment_mode IN ('cash','upi','card','bank','cheque','credit')),
  notes         TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_shop_date
  ON expenses (shop_id, expense_date DESC);

CREATE TABLE IF NOT EXISTS investments (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  investment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  source_name      TEXT NOT NULL DEFAULT 'Owner',
  amount           DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode     TEXT DEFAULT 'bank'
                    CHECK (payment_mode IN ('cash','upi','card','bank','cheque')),
  reference_note   TEXT,
  notes            TEXT,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investments_shop_date
  ON investments (shop_id, investment_date DESC);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expenses_all" ON expenses;
CREATE POLICY "expenses_all" ON expenses FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "investments_all" ON investments;
CREATE POLICY "investments_all" ON investments FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));
