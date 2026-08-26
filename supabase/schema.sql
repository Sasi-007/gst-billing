-- ============================================================
-- GST BILLING APP - SUPABASE SCHEMA
-- Run this in your Supabase SQL Editor
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Settings (shop info, bill counter) ──────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_name     TEXT NOT NULL DEFAULT 'My Shop',
  address       TEXT,
  city          TEXT,
  state         TEXT DEFAULT 'Tamil Nadu',
  state_code    TEXT DEFAULT '33',
  pincode       TEXT,
  phone         TEXT,
  email         TEXT,
  gstin         TEXT,
  logo_url      TEXT,
  footer_text   TEXT DEFAULT 'Thank you for your business!',
  bill_prefix   TEXT DEFAULT 'INV',
  bill_counter  INTEGER DEFAULT 0,
  purchase_prefix TEXT DEFAULT 'PUR',
  purchase_counter INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO settings (shop_name) VALUES ('My Shop') ON CONFLICT DO NOTHING;

-- ── Suppliers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name           TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  gstin          TEXT,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  pincode        TEXT,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Categories ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO categories (name) VALUES
  ('Staples'),('Dairy'),('Beverages'),('Snacks'),
  ('Personal Care'),('Household'),('Frozen'),('Bakery'),('Others')
ON CONFLICT DO NOTHING;

-- ── Products ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name           TEXT NOT NULL,
  barcode        TEXT,
  brand          TEXT,
  category_id    UUID REFERENCES categories(id),
  tags           TEXT[] DEFAULT '{}',
  hsn_code       TEXT,
  unit           TEXT DEFAULT 'pcs',
  purchase_price DECIMAL(10,2) DEFAULT 0,
  mrp            DECIMAL(10,2) NOT NULL DEFAULT 0,
  selling_price  DECIMAL(10,2) DEFAULT 0,
  gst_rate       DECIMAL(5,2) DEFAULT 0,
  stock_qty      DECIMAL(10,3) DEFAULT 0,
  min_stock      DECIMAL(10,3) DEFAULT 0,
  supplier_id    UUID REFERENCES suppliers(id),
  is_active      BOOLEAN DEFAULT TRUE,
  -- computed column for fast multi-field search
  search_text    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Update search_text whenever product is inserted/updated
CREATE OR REPLACE FUNCTION fn_update_search_text()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_text := lower(
    NEW.name || ' ' ||
    COALESCE(NEW.brand, '') || ' ' ||
    COALESCE(NEW.barcode, '') || ' ' ||
    array_to_string(COALESCE(NEW.tags, '{}'), ' ')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_search_text ON products;
CREATE TRIGGER trg_product_search_text
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION fn_update_search_text();

CREATE INDEX IF NOT EXISTS idx_products_search ON products USING GIN (to_tsvector('english', search_text));
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode);
CREATE INDEX IF NOT EXISTS idx_products_active  ON products (is_active);

-- ── Sales Bills ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  bill_no          TEXT NOT NULL UNIQUE,
  bill_type        TEXT NOT NULL DEFAULT 'invoice'
                     CHECK (bill_type IN ('invoice','quotation','estimate')),
  date             DATE NOT NULL DEFAULT CURRENT_DATE,
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_gstin   TEXT,
  customer_address TEXT,
  subtotal         DECIMAL(12,2) DEFAULT 0,
  cgst_amount      DECIMAL(12,2) DEFAULT 0,
  sgst_amount      DECIMAL(12,2) DEFAULT 0,
  igst_amount      DECIMAL(12,2) DEFAULT 0,
  gst_amount       DECIMAL(12,2) DEFAULT 0,
  discount_amount  DECIMAL(12,2) DEFAULT 0,
  total            DECIMAL(12,2) DEFAULT 0,
  paid_amount      DECIMAL(12,2) DEFAULT 0,
  payment_mode     TEXT DEFAULT 'cash'
                     CHECK (payment_mode IN ('cash','upi','card','credit','cheque')),
  payment_status   TEXT DEFAULT 'paid'
                     CHECK (payment_status IN ('paid','partial','unpaid')),
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bills_date ON bills (date);
CREATE INDEX IF NOT EXISTS idx_bills_type ON bills (bill_type);

-- ── Sales Bill Items ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bill_items (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  bill_id         UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id),
  sl_no           INTEGER NOT NULL DEFAULT 1,
  product_name    TEXT NOT NULL,
  hsn_code        TEXT,
  unit            TEXT DEFAULT 'pcs',
  quantity        DECIMAL(10,3) NOT NULL DEFAULT 1,
  mrp             DECIMAL(10,2) DEFAULT 0,
  cost_price      DECIMAL(10,2) DEFAULT 0,
  rate            DECIMAL(10,2) NOT NULL DEFAULT 0,
  base_rate       DECIMAL(10,2) DEFAULT 0,
  gst_rate        DECIMAL(5,2)  DEFAULT 0,
  gst_amount      DECIMAL(10,2) DEFAULT 0,
  discount_pct    DECIMAL(5,2)  DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  total           DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Purchase Bills ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_bills (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  bill_no             TEXT NOT NULL UNIQUE,
  supplier_id         UUID REFERENCES suppliers(id),
  supplier_invoice_no TEXT,
  date                DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal            DECIMAL(12,2) DEFAULT 0,
  gst_amount          DECIMAL(12,2) DEFAULT 0,
  total               DECIMAL(12,2) DEFAULT 0,
  paid_amount         DECIMAL(12,2) DEFAULT 0,
  payment_mode        TEXT DEFAULT 'credit',
  payment_status      TEXT DEFAULT 'unpaid'
                        CHECK (payment_status IN ('paid','partial','unpaid')),
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_bills_date ON purchase_bills (date);

-- ── Purchase Bill Items ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_bill_items (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  purchase_bill_id  UUID NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
  product_id        UUID REFERENCES products(id),
  sl_no             INTEGER NOT NULL DEFAULT 1,
  product_name      TEXT NOT NULL,
  hsn_code          TEXT,
  unit              TEXT DEFAULT 'pcs',
  quantity          DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate              DECIMAL(10,2) NOT NULL DEFAULT 0,
  mrp               DECIMAL(10,2) DEFAULT 0,
  base_rate         DECIMAL(10,2) DEFAULT 0,
  gst_rate          DECIMAL(5,2)  DEFAULT 0,
  gst_amount        DECIMAL(10,2) DEFAULT 0,
  total             DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id       UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  title         TEXT NOT NULL,
  category      TEXT,
  amount        DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode  TEXT DEFAULT 'cash'
                 CHECK (payment_mode IN ('cash','upi','card','bank','cheque','credit')),
  bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  notes         TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_shop_date ON expenses (shop_id, expense_date DESC);

CREATE TABLE IF NOT EXISTS investments (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  investment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  source_name      TEXT NOT NULL DEFAULT 'Owner',
  amount           DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_mode     TEXT DEFAULT 'bank'
                    CHECK (payment_mode IN ('cash','upi','card','bank','cheque')),
  bank_account_id  UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  reference_note   TEXT,
  notes            TEXT,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investments_shop_date ON investments (shop_id, investment_date DESC);

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

CREATE INDEX IF NOT EXISTS idx_bank_accounts_shop ON bank_accounts (shop_id, account_name);

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
  source_table      TEXT,
  source_id         UUID,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_shop_date ON bank_transactions (shop_id, transaction_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transactions_source_unique ON bank_transactions (shop_id, source_table, source_id);

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

CREATE INDEX IF NOT EXISTS idx_owner_drawings_shop_date ON owner_drawings (shop_id, drawing_date DESC);

-- ── Auto-adjust stock on sale ────────────────────────────────
CREATE OR REPLACE FUNCTION fn_stock_on_sale()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.product_id IS NOT NULL THEN
    UPDATE products SET stock_qty = stock_qty - NEW.quantity WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' AND OLD.product_id IS NOT NULL THEN
    UPDATE products SET stock_qty = stock_qty + OLD.quantity WHERE id = OLD.product_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sale_stock ON bill_items;
CREATE TRIGGER trg_sale_stock
  AFTER INSERT OR DELETE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION fn_stock_on_sale();

-- ── Auto-adjust stock on purchase ───────────────────────────
CREATE OR REPLACE FUNCTION fn_stock_on_purchase()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.product_id IS NOT NULL THEN
    UPDATE products
    SET stock_qty = stock_qty + NEW.quantity,
        purchase_price = NEW.rate,
        mrp = COALESCE(NULLIF(NEW.mrp, 0), mrp)
    WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' AND OLD.product_id IS NOT NULL THEN
    UPDATE products SET stock_qty = stock_qty - OLD.quantity WHERE id = OLD.product_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_purchase_stock ON purchase_bill_items;
CREATE TRIGGER trg_purchase_stock
  AFTER INSERT OR DELETE ON purchase_bill_items
  FOR EACH ROW EXECUTE FUNCTION fn_stock_on_purchase();

-- ── Next bill number function ────────────────────────────────
CREATE OR REPLACE FUNCTION get_next_bill_no(p_prefix TEXT)
RETURNS TEXT AS $$
DECLARE
  v_counter INTEGER;
BEGIN
  UPDATE settings
  SET bill_counter = bill_counter + 1
  RETURNING bill_counter INTO v_counter;
  RETURN p_prefix || '-' || LPAD(v_counter::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_next_purchase_no(p_prefix TEXT)
RETURNS TEXT AS $$
DECLARE
  v_counter INTEGER;
BEGIN
  UPDATE settings
  SET purchase_counter = purchase_counter + 1
  RETURNING purchase_counter INTO v_counter;
  RETURN p_prefix || '-' || LPAD(v_counter::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ── Disable RLS for single-user local app ───────────────────
-- Auto-post finance entries into bank ledger
CREATE OR REPLACE FUNCTION fn_sync_bank_transaction(
  p_source_table TEXT,
  p_source_id UUID,
  p_shop_id UUID,
  p_account_id UUID,
  p_transaction_date DATE,
  p_direction TEXT,
  p_entry_type TEXT,
  p_amount DECIMAL,
  p_reference_note TEXT,
  p_notes TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_account_id IS NULL OR COALESCE(p_amount, 0) <= 0 THEN
    DELETE FROM bank_transactions
    WHERE shop_id = p_shop_id
      AND source_table = p_source_table
      AND source_id = p_source_id;
    RETURN;
  END IF;

  INSERT INTO bank_transactions (
    shop_id, account_id, transaction_date, direction, entry_type,
    amount, reference_note, notes, source_table, source_id, is_active
  )
  VALUES (
    p_shop_id, p_account_id, p_transaction_date, p_direction, p_entry_type,
    p_amount, p_reference_note, p_notes, p_source_table, p_source_id, TRUE
  )
  ON CONFLICT (shop_id, source_table, source_id) DO UPDATE SET
    account_id       = EXCLUDED.account_id,
    transaction_date  = EXCLUDED.transaction_date,
    direction        = EXCLUDED.direction,
    entry_type       = EXCLUDED.entry_type,
    amount           = EXCLUDED.amount,
    reference_note   = EXCLUDED.reference_note,
    notes            = EXCLUDED.notes,
    is_active        = TRUE,
    updated_at       = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION fn_delete_bank_transaction(
  p_source_table TEXT,
  p_source_id UUID,
  p_shop_id UUID
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM bank_transactions
  WHERE shop_id = p_shop_id
    AND source_table = p_source_table
    AND source_id = p_source_id;
END;
$$;

CREATE OR REPLACE FUNCTION trg_sync_expenses_to_bank()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM fn_delete_bank_transaction('expenses', OLD.id, OLD.shop_id);
    RETURN OLD;
  END IF;

  PERFORM fn_sync_bank_transaction(
    'expenses', NEW.id, NEW.shop_id, NEW.bank_account_id, NEW.expense_date,
    'out', 'expense', NEW.amount, NEW.title, NEW.notes
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trg_sync_investments_to_bank()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM fn_delete_bank_transaction('investments', OLD.id, OLD.shop_id);
    RETURN OLD;
  END IF;

  PERFORM fn_sync_bank_transaction(
    'investments', NEW.id, NEW.shop_id, NEW.bank_account_id, NEW.investment_date,
    'in', 'investment', NEW.amount, NEW.source_name, NEW.notes
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trg_sync_drawings_to_bank()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM fn_delete_bank_transaction('owner_drawings', OLD.id, OLD.shop_id);
    RETURN OLD;
  END IF;

  PERFORM fn_sync_bank_transaction(
    'owner_drawings', NEW.id, NEW.shop_id, NEW.bank_account_id, NEW.drawing_date,
    'out', 'drawing', NEW.amount, NEW.title, NEW.notes
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_expenses_bank_sync ON expenses;
CREATE TRIGGER trg_expenses_bank_sync
  AFTER INSERT OR UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION trg_sync_expenses_to_bank();

DROP TRIGGER IF EXISTS trg_investments_bank_sync ON investments;
CREATE TRIGGER trg_investments_bank_sync
  AFTER INSERT OR UPDATE OR DELETE ON investments
  FOR EACH ROW EXECUTE FUNCTION trg_sync_investments_to_bank();

DROP TRIGGER IF EXISTS trg_owner_drawings_bank_sync ON owner_drawings;
CREATE TRIGGER trg_owner_drawings_bank_sync
  AFTER INSERT OR UPDATE OR DELETE ON owner_drawings
  FOR EACH ROW EXECUTE FUNCTION trg_sync_drawings_to_bank();

ALTER TABLE settings         DISABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers        DISABLE ROW LEVEL SECURITY;
ALTER TABLE categories       DISABLE ROW LEVEL SECURITY;
ALTER TABLE products         DISABLE ROW LEVEL SECURITY;
ALTER TABLE bills            DISABLE ROW LEVEL SECURITY;
ALTER TABLE bill_items       DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bills   DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bill_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE expenses         DISABLE ROW LEVEL SECURITY;
ALTER TABLE investments      DISABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts    DISABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE owner_drawings   DISABLE ROW LEVEL SECURITY;
