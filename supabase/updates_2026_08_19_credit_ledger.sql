-- Credit ledger + HSN search update

CREATE TABLE IF NOT EXISTS credit_accounts (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
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
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  shop_id           UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
  entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  direction         TEXT NOT NULL CHECK (direction IN ('increase','decrease')),
  amount            DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reference_note    TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_shop ON credit_accounts (shop_id, party_name);
CREATE INDEX IF NOT EXISTS idx_credit_entries_shop_account ON credit_entries (shop_id, account_id, entry_date DESC);

CREATE OR REPLACE FUNCTION fn_update_search_text()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(
    COALESCE(NEW.name,'')    || ' ' ||
    COALESCE(NEW.brand,'')   || ' ' ||
    COALESCE(NEW.barcode,'') || ' ' ||
    COALESCE(NEW.hsn_code,'') || ' ' ||
    array_to_string(COALESCE(NEW.tags,'{}'), ' ')
  );
  RETURN NEW;
END;
$$;

UPDATE products
SET search_text = lower(
  COALESCE(name,'') || ' ' ||
  COALESCE(brand,'') || ' ' ||
  COALESCE(barcode,'') || ' ' ||
  COALESCE(hsn_code,'') || ' ' ||
  array_to_string(COALESCE(tags,'{}'), ' ')
);

DROP TRIGGER IF EXISTS trg_credit_accounts_updated ON credit_accounts;
CREATE TRIGGER trg_credit_accounts_updated
  BEFORE UPDATE ON credit_accounts FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "credit_accounts_all" ON credit_accounts;
CREATE POLICY "credit_accounts_all" ON credit_accounts FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "credit_entries_all" ON credit_entries;
CREATE POLICY "credit_entries_all" ON credit_entries FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));
