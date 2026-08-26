-- Advanced finance support:
-- 1) owner drawings / withdrawals
-- 2) bank accounts
-- 3) bank transactions for manual inflow/outflow tracking

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                   UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id              UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  account_name         TEXT NOT NULL,
  bank_name            TEXT,
  account_type         TEXT NOT NULL DEFAULT 'bank'
                         CHECK (account_type IN ('bank','cash','wallet','upi')),
  opening_balance      DECIMAL(12,2) NOT NULL DEFAULT 0,
  account_number_last4 TEXT,
  notes                TEXT,
  is_active            BOOLEAN DEFAULT TRUE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_shop
  ON bank_accounts (shop_id, account_name);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  transaction_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  direction         TEXT NOT NULL CHECK (direction IN ('in','out')),
  entry_type        TEXT NOT NULL DEFAULT 'other'
                     CHECK (entry_type IN ('deposit','withdrawal','expense','investment','drawing','sale_receipt','purchase_payment','other')),
  amount            DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reference_note    TEXT,
  notes             TEXT,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_shop_date
  ON bank_transactions (shop_id, transaction_date DESC);

CREATE TABLE IF NOT EXISTS owner_drawings (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  drawing_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  title            TEXT NOT NULL DEFAULT 'Owner withdrawal',
  amount           DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode     TEXT DEFAULT 'cash'
                    CHECK (payment_mode IN ('cash','upi','card','bank','cheque')),
  bank_account_id  UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  notes            TEXT,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_drawings_shop_date
  ON owner_drawings (shop_id, drawing_date DESC);

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_drawings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bank_accounts_all" ON bank_accounts;
CREATE POLICY "bank_accounts_all" ON bank_accounts FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "bank_transactions_all" ON bank_transactions;
CREATE POLICY "bank_transactions_all" ON bank_transactions FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "owner_drawings_all" ON owner_drawings;
CREATE POLICY "owner_drawings_all" ON owner_drawings FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));
