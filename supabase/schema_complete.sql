-- ============================================================
-- GST BILLING APP — COMPLETE MULTI-TENANT SCHEMA
-- Run this ONCE in Supabase SQL Editor
-- Supports: multi-brand, RLS, triggers, search, bill numbering
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- MULTI-TENANCY: SHOPS & USERS
-- ============================================================

-- ── Shops (one row = one brand/business) ─────────────────────
CREATE TABLE IF NOT EXISTS shops (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT,                          -- url-friendly name
  address          TEXT,
  city             TEXT,
  state            TEXT DEFAULT 'Tamil Nadu',
  state_code       TEXT DEFAULT '33',
  pincode          TEXT,
  phone            TEXT,
  email            TEXT,
  gstin            TEXT,
  logo_url         TEXT,
  footer_text      TEXT DEFAULT 'Thank you for your business!',
  bill_prefix      TEXT DEFAULT 'INV',
  bill_counter     INTEGER DEFAULT 0,
  purchase_prefix  TEXT DEFAULT 'PUR',
  purchase_counter INTEGER DEFAULT 0,
  plan             TEXT DEFAULT 'free' CHECK (plan IN ('free','pro')),
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── User ↔ Shop membership ────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_shops (
  user_id  UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id  UUID REFERENCES shops(id)      ON DELETE CASCADE,
  role     TEXT DEFAULT 'staff' CHECK (role IN ('owner','manager','staff')),
  PRIMARY KEY (user_id, shop_id)
);

-- ============================================================
-- MASTER DATA
-- ============================================================

-- ── Suppliers ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id        UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
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

-- ── Customers ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id        UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name           TEXT,
  phone          TEXT,
  gstin          TEXT,
  address        TEXT,
  notes          TEXT,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_shop_name ON customers (shop_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_shop_active ON customers (shop_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_phone_unique
  ON customers (shop_id, phone)
  WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_gstin_unique
  ON customers (shop_id, gstin)
  WHERE gstin IS NOT NULL;

-- ── Categories ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Products ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id        UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  local_name     TEXT,
  barcode        TEXT,
  brand          TEXT,
  category_id    UUID REFERENCES categories(id)  ON DELETE SET NULL,
  tags           TEXT[] DEFAULT '{}',
  search_aliases TEXT[] DEFAULT '{}',
  hsn_code       TEXT,
  unit           TEXT DEFAULT 'pcs',
  bill_name_mode TEXT NOT NULL DEFAULT 'english'
                 CHECK (bill_name_mode IN ('english','local','both')),

  -- Pricing (all GST-inclusive)
  purchase_price DECIMAL(10,2) DEFAULT 0,
  mrp            DECIMAL(10,2) NOT NULL DEFAULT 0,
  selling_price  DECIMAL(10,2) DEFAULT 0,
  gst_rate       DECIMAL(5,2)  DEFAULT 0   -- 0/3/5/12/18/28

    CHECK (gst_rate IN (0,3,5,12,18,28)),

  -- Stock
  stock_qty      DECIMAL(10,3) DEFAULT 0,
  min_stock      DECIMAL(10,3) DEFAULT 0,   -- reorder level

  -- Relationships
  supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  is_active      BOOLEAN DEFAULT TRUE,

  -- Computed full-text search column (updated via trigger)
  search_text    TEXT,

  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes for product search ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_shop      ON products (shop_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode   ON products (shop_id, barcode);
CREATE INDEX IF NOT EXISTS idx_products_active    ON products (shop_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_search    ON products USING GIN (to_tsvector('simple', COALESCE(search_text,'')));

-- ============================================================
-- SALES
-- ============================================================

-- ── Sales Bills (invoice / quotation / estimate) ─────────────
CREATE TABLE IF NOT EXISTS bills (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_no          TEXT NOT NULL,
  bill_type        TEXT NOT NULL DEFAULT 'invoice'
                     CHECK (bill_type IN ('invoice','quotation','estimate')),
  date             DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Customer
  customer_id      UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_gstin   TEXT,
  customer_address TEXT,

  -- Amounts
  subtotal         DECIMAL(12,2) DEFAULT 0,   -- taxable amount (excl. GST)
  cgst_amount      DECIMAL(12,2) DEFAULT 0,
  sgst_amount      DECIMAL(12,2) DEFAULT 0,
  igst_amount      DECIMAL(12,2) DEFAULT 0,   -- for inter-state
  gst_amount       DECIMAL(12,2) DEFAULT 0,   -- total GST
  discount_amount  DECIMAL(12,2) DEFAULT 0,
  total            DECIMAL(12,2) DEFAULT 0,   -- grand total

  -- Payment
  paid_amount      DECIMAL(12,2) DEFAULT 0,
  payment_mode     TEXT DEFAULT 'cash'
                     CHECK (payment_mode IN ('cash','upi','card','credit','cheque')),
  payment_status   TEXT DEFAULT 'paid'
                     CHECK (payment_status IN ('paid','partial','unpaid')),

  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (shop_id, bill_no)
);

CREATE INDEX IF NOT EXISTS idx_bills_shop_date ON bills (shop_id, date);
CREATE INDEX IF NOT EXISTS idx_bills_shop_type ON bills (shop_id, bill_type);
CREATE INDEX IF NOT EXISTS idx_bills_shop_customer ON bills (shop_id, customer_id);

-- ── Sales Bill Line Items ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS bill_items (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id         UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id         UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  sl_no           INTEGER NOT NULL DEFAULT 1,

  -- Snapshot of product at time of sale
  product_name    TEXT NOT NULL,
  hsn_code        TEXT,
  unit            TEXT DEFAULT 'pcs',

  -- Qty & Pricing
  quantity        DECIMAL(10,3) NOT NULL DEFAULT 1,
  mrp             DECIMAL(10,2) DEFAULT 0,
  cost_price      DECIMAL(10,2) DEFAULT 0,            -- purchase-cost snapshot for profit reporting
  rate            DECIMAL(10,2) NOT NULL DEFAULT 0,   -- selling rate (GST-inclusive)
  base_rate       DECIMAL(10,2) DEFAULT 0,            -- rate excl. GST
  gst_rate        DECIMAL(5,2)  DEFAULT 0,
  gst_amount      DECIMAL(10,2) DEFAULT 0,
  discount_pct    DECIMAL(5,2)  DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  total           DECIMAL(10,2) NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bill_items_bill   ON bill_items (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_shop   ON bill_items (shop_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_product ON bill_items (product_id);

-- ============================================================
-- PURCHASES
-- ============================================================

-- ── Purchase Bills (from supplier) ───────────────────────────
CREATE TABLE IF NOT EXISTS purchase_bills (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id             UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_no             TEXT NOT NULL,
  supplier_id         UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_invoice_no TEXT,                    -- supplier's own invoice number
  date                DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Amounts
  subtotal            DECIMAL(12,2) DEFAULT 0,
  gst_amount          DECIMAL(12,2) DEFAULT 0,
  total               DECIMAL(12,2) DEFAULT 0,
  paid_amount         DECIMAL(12,2) DEFAULT 0,
  payment_mode        TEXT DEFAULT 'credit',
  payment_status      TEXT DEFAULT 'unpaid'
                        CHECK (payment_status IN ('paid','partial','unpaid')),

  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (shop_id, bill_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_bills_shop_date ON purchase_bills (shop_id, date);

-- ── Purchase Bill Line Items ──────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_bill_items (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  purchase_bill_id  UUID NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
  product_id        UUID REFERENCES products(id) ON DELETE SET NULL,
  sl_no             INTEGER NOT NULL DEFAULT 1,

  -- Snapshot
  product_name      TEXT NOT NULL,
  hsn_code          TEXT,
  unit              TEXT DEFAULT 'pcs',

  -- Qty & Pricing
  quantity          DECIMAL(10,3) NOT NULL DEFAULT 1,
  rate              DECIMAL(10,2) NOT NULL DEFAULT 0,   -- purchase rate (GST-inclusive)
  mrp               DECIMAL(10,2) DEFAULT 0,            -- supplier MRP snapshot for this bill
  base_rate         DECIMAL(10,2) DEFAULT 0,
  gst_rate          DECIMAL(5,2)  DEFAULT 0,
  gst_amount        DECIMAL(10,2) DEFAULT 0,
  total             DECIMAL(10,2) NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_bill    ON purchase_bill_items (purchase_bill_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_bill_items (product_id);

-- ============================================================
-- FINANCE
-- ============================================================

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_transactions_source_unique
  ON bank_transactions (shop_id, source_table, source_id);

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

-- ============================================================
-- CREDIT LEDGER
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_accounts (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
  party_name        TEXT NOT NULL,
  phone             TEXT,
  relation_type     TEXT NOT NULL DEFAULT 'borrower'
                      CHECK (relation_type IN ('borrower','lender')),
  settlement_cycle  TEXT NOT NULL DEFAULT 'daily'
                      CHECK (settlement_cycle IN ('daily','weekly','monthly')),
  settlement_day    INTEGER CHECK (settlement_day IS NULL OR settlement_day BETWEEN 1 AND 31),
  opening_balance   DECIMAL(12,2) DEFAULT 0,
  notes             TEXT,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_entries (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
  entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  direction         TEXT NOT NULL CHECK (direction IN ('increase','decrease')),
  amount            DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reference_note    TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_shop ON credit_accounts (shop_id, party_name);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_shop_customer ON credit_accounts (shop_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_entries_shop_account ON credit_entries (shop_id, account_id, entry_date DESC);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- ── 1. Update product search_text on insert/update ───────────
CREATE OR REPLACE FUNCTION fn_update_search_text()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(
    COALESCE(NEW.name,'') || ' ' ||
    COALESCE(NEW.local_name,'') || ' ' ||
    COALESCE(NEW.brand,'') || ' ' ||
    COALESCE(NEW.barcode,'') || ' ' ||
    COALESCE(NEW.hsn_code,'') || ' ' ||
    array_to_string(COALESCE(NEW.tags,'{}'), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.search_aliases,'{}'), ' ')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_search ON products;
CREATE TRIGGER trg_product_search
  BEFORE INSERT OR UPDATE OF name, local_name, brand, barcode, hsn_code, tags, search_aliases
  ON products FOR EACH ROW EXECUTE FUNCTION fn_update_search_text();

-- ── 2. Adjust stock when bill item is inserted/deleted ───────
CREATE OR REPLACE FUNCTION fn_stock_on_sale()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.product_id IS NOT NULL THEN
    UPDATE products SET stock_qty = stock_qty - NEW.quantity,
                        updated_at = NOW()
    WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' AND OLD.product_id IS NOT NULL THEN
    UPDATE products SET stock_qty = stock_qty + OLD.quantity,
                        updated_at = NOW()
    WHERE id = OLD.product_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sale_stock ON bill_items;
CREATE TRIGGER trg_sale_stock
  AFTER INSERT OR DELETE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION fn_stock_on_sale();

-- ── 3. Adjust stock when purchase item is inserted/deleted ────
CREATE OR REPLACE FUNCTION fn_stock_on_purchase()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.product_id IS NOT NULL THEN
    UPDATE products
    SET stock_qty      = stock_qty + NEW.quantity,
        purchase_price = NEW.rate,
        mrp            = COALESCE(NULLIF(NEW.mrp, 0), mrp),
        updated_at     = NOW()
    WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' AND OLD.product_id IS NOT NULL THEN
    UPDATE products SET stock_qty = stock_qty - OLD.quantity,
                        updated_at = NOW()
    WHERE id = OLD.product_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_stock ON purchase_bill_items;
CREATE TRIGGER trg_purchase_stock
  AFTER INSERT OR DELETE ON purchase_bill_items
  FOR EACH ROW EXECUTE FUNCTION fn_stock_on_purchase();

-- ── 4. Auto-update updated_at on shops ───────────────────────
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_shops_updated ON shops;
CREATE TRIGGER trg_shops_updated
  BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated ON customers;
CREATE TRIGGER trg_customers_updated
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_credit_accounts_updated ON credit_accounts;
CREATE TRIGGER trg_credit_accounts_updated
  BEFORE UPDATE ON credit_accounts FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ── 5. Generate next bill number (per shop) ──────────────────
CREATE OR REPLACE FUNCTION get_next_bill_no(p_shop_id UUID, p_prefix TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_counter INTEGER;
BEGIN
  UPDATE shops SET bill_counter = bill_counter + 1
  WHERE id = p_shop_id RETURNING bill_counter INTO v_counter;
  RETURN p_prefix || '-' || LPAD(v_counter::TEXT, 4, '0');
END;
$$;

-- ── 6. Generate next purchase number (per shop) ──────────────
CREATE OR REPLACE FUNCTION get_next_purchase_no(p_shop_id UUID, p_prefix TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_counter INTEGER;
BEGIN
  UPDATE shops SET purchase_counter = purchase_counter + 1
  WHERE id = p_shop_id RETURNING purchase_counter INTO v_counter;
  RETURN p_prefix || '-' || LPAD(v_counter::TEXT, 4, '0');
END;
$$;

-- ── 7. RLS helper: return shop_ids for the current auth user ──
CREATE OR REPLACE FUNCTION auth_shop_ids()
RETURNS SETOF UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT shop_id FROM user_shops WHERE user_id = auth.uid()
$$;

-- ── 8. Onboarding helper: create shop + categories in one call
CREATE OR REPLACE FUNCTION create_shop_with_defaults(
  p_name       TEXT,
  p_gstin      TEXT    DEFAULT NULL,
  p_phone      TEXT    DEFAULT NULL,
  p_address    TEXT    DEFAULT NULL,
  p_city       TEXT    DEFAULT NULL,
  p_state      TEXT    DEFAULT 'Tamil Nadu',
  p_pincode    TEXT    DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_shop_id UUID;
  v_cats    TEXT[] := ARRAY['Staples','Dairy','Beverages','Snacks',
                            'Personal Care','Household','Frozen','Bakery','Others'];
  v_cat     TEXT;
BEGIN
  -- Create shop
  INSERT INTO shops (name, gstin, phone, address, city, state, pincode)
  VALUES (p_name, p_gstin, p_phone, p_address, p_city, p_state, p_pincode)
  RETURNING id INTO v_shop_id;

  -- Link current user as owner
  INSERT INTO user_shops (user_id, shop_id, role)
  VALUES (auth.uid(), v_shop_id, 'owner');

  -- Seed default categories
  FOREACH v_cat IN ARRAY v_cats LOOP
    INSERT INTO categories (shop_id, name) VALUES (v_shop_id, v_cat);
  END LOOP;

  RETURN v_shop_id;
END;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE shops               ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_shops          ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills               ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bills      ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_drawings      ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (idempotent re-run)
DO $$ DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies
           WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ── shops: user sees/edits shops they belong to ──────────────
CREATE POLICY "shops_select" ON shops FOR SELECT
  USING (id = ANY(auth_shop_ids()));
CREATE POLICY "shops_insert" ON shops FOR INSERT
  WITH CHECK (TRUE);   -- handled in create_shop_with_defaults
CREATE POLICY "shops_update" ON shops FOR UPDATE
  USING (id = ANY(auth_shop_ids()));

-- ── user_shops: user sees own memberships; owners manage others
CREATE POLICY "user_shops_select" ON user_shops FOR SELECT
  USING (user_id = auth.uid() OR shop_id = ANY(auth_shop_ids()));
CREATE POLICY "user_shops_insert" ON user_shops FOR INSERT
  WITH CHECK (TRUE);   -- secured in RPC
CREATE POLICY "user_shops_delete" ON user_shops FOR DELETE
  USING (user_id = auth.uid());

-- ── All shop-scoped tables: shared pattern ────────────────────
-- suppliers
CREATE POLICY "suppliers_all" ON suppliers FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- customers
CREATE POLICY "customers_all" ON customers FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- categories
CREATE POLICY "categories_all" ON categories FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- products
CREATE POLICY "products_all" ON products FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- bills
CREATE POLICY "bills_all" ON bills FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- bill_items
CREATE POLICY "bill_items_all" ON bill_items FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- purchase_bills
CREATE POLICY "purchase_bills_all" ON purchase_bills FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- purchase_bill_items
CREATE POLICY "purchase_bill_items_all" ON purchase_bill_items FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- credit_accounts
CREATE POLICY "credit_accounts_all" ON credit_accounts FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- credit_entries
CREATE POLICY "credit_entries_all" ON credit_entries FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- expenses
CREATE POLICY "expenses_all" ON expenses FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- investments
CREATE POLICY "investments_all" ON investments FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- bank_accounts
CREATE POLICY "bank_accounts_all" ON bank_accounts FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- bank_transactions
CREATE POLICY "bank_transactions_all" ON bank_transactions FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- owner_drawings
CREATE POLICY "owner_drawings_all" ON owner_drawings FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- ============================================================
-- FINANCE AUTO-POST TRIGGERS
-- ============================================================

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

-- ============================================================
-- VIEWS (optional helpers)
-- ============================================================

-- ── Sales summary per day ─────────────────────────────────────
CREATE OR REPLACE VIEW v_daily_sales AS
SELECT
  shop_id,
  date,
  COUNT(*)           AS bill_count,
  SUM(subtotal)      AS subtotal,
  SUM(gst_amount)    AS gst_amount,
  SUM(discount_amount) AS discount_amount,
  SUM(total)         AS total
FROM bills
WHERE bill_type = 'invoice'
GROUP BY shop_id, date;

-- ── Low stock alert view ──────────────────────────────────────
CREATE OR REPLACE VIEW v_low_stock AS
SELECT
  id, shop_id, name, brand, barcode, unit,
  stock_qty, min_stock, selling_price, mrp,
  CASE
    WHEN stock_qty <= 0          THEN 'out_of_stock'
    WHEN stock_qty <= min_stock  THEN 'low_stock'
    ELSE 'ok'
  END AS stock_status
FROM products
WHERE is_active = TRUE
  AND (stock_qty <= 0 OR (min_stock > 0 AND stock_qty <= min_stock));

-- ── GST summary view ─────────────────────────────────────────
CREATE OR REPLACE VIEW v_gst_summary AS
SELECT
  bi.shop_id,
  DATE_TRUNC('month', b.date)   AS month,
  bi.gst_rate,
  SUM(bi.total - bi.gst_amount) AS taxable_amount,
  SUM(bi.gst_amount / 2)        AS cgst,
  SUM(bi.gst_amount / 2)        AS sgst,
  SUM(bi.gst_amount)            AS total_gst
FROM bill_items bi
JOIN bills b ON b.id = bi.bill_id
WHERE b.bill_type = 'invoice'
GROUP BY bi.shop_id, DATE_TRUNC('month', b.date), bi.gst_rate;

-- ============================================================
-- USAGE NOTES
-- ============================================================
-- 1. After running this schema, configure Supabase Auth (Email+Password)
-- 2. Users sign up → call create_shop_with_defaults() for onboarding
-- 3. All queries automatically filtered by RLS (user's shop only)
-- 4. Call get_next_bill_no(shop_id, prefix) for auto bill numbers
-- 5. Stock is adjusted automatically via triggers on insert/delete
-- 6. For development/testing: you can temporarily disable RLS with:
--      ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
-- ============================================================
