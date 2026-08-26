-- Auto-post expense / investment / drawing entries to bank ledger

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS source_table TEXT;

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS source_id UUID;

DO $$ BEGIN
  ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_source_unique UNIQUE (shop_id, source_table, source_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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
