-- Smart Credit Card planner (/smart).
--
-- Deliberately standalone. Unlike every other table in this schema these rows
-- are scoped to the *user* (auth.uid()), not to a shop, and there is no foreign
-- key to shops, bills, expenses or bank_accounts. A credit card is personal
-- finance; tying it to shop_id would make the data follow shop switching and
-- would leak a personal balance to every staff account that shares the shop.
--
-- Nothing in this migration touches an existing table: no ALTER on shop tables,
-- no trigger on an existing table, no change to any existing policy. It is
-- purely additive, so the billing app behaves exactly as before.
--
-- Run once in the Supabase SQL editor.
--
-- Wrapped in a transaction: if any statement fails the whole migration rolls
-- back. It is also idempotent (IF NOT EXISTS / OR REPLACE throughout), so
-- re-running it is harmless.
BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Card ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_cards (
  id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id            UUID NOT NULL DEFAULT auth.uid()
                     REFERENCES auth.users(id) ON DELETE CASCADE,

  card_name          TEXT NOT NULL DEFAULT 'My Card',
  issuer             TEXT,

  -- Last four digits only. The full number is never accepted by the UI and
  -- must never be stored: it is card-holder data, and storing it would drag
  -- this app into PCI-DSS scope for no functional gain.
  last4              TEXT CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),

  credit_limit       DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),

  -- Day of month the statement is generated. This is the date the issuer
  -- reports the balance to the bureau, so it -- not the due date -- is what
  -- the whole planner optimises around.
  statement_day      SMALLINT NOT NULL DEFAULT 1  CHECK (statement_day BETWEEN 1 AND 31),

  -- Day of month the payment is due. Interpreted as the following month when
  -- it is not after statement_day (e.g. statement 25th, due 14th).
  due_day            SMALLINT NOT NULL DEFAULT 20 CHECK (due_day BETWEEN 1 AND 31),

  -- Utilisation the planner aims to have reported, as a percentage of limit.
  -- Default 10: bureaus treat 1-10% as the top band, and a figure in that band
  -- scores better than a nil balance, which can read as a dormant card.
  target_utilization DECIMAL(5,2) NOT NULL DEFAULT 10
                     CHECK (target_utilization >= 0 AND target_utilization <= 100),

  -- Balance already outstanding when the card was added, so the first cycle
  -- does not have to be reconstructed from historic spends.
  opening_balance    DECIMAL(12,2) NOT NULL DEFAULT 0,

  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- The planner models one card at a time: cross-card utilisation changes the
-- advice, so allowing a second active card would silently make every
-- recommendation wrong rather than merely incomplete. Partial index, so
-- de-activated cards are kept as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_cards_one_active
  ON credit_cards (user_id) WHERE is_active;

-- ── Spends ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_card_spends (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID NOT NULL DEFAULT auth.uid()
              REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id     UUID NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,

  spend_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  amount      DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  label       TEXT,
  category    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Every read is "this card, ordered by date" while building cycles.
CREATE INDEX IF NOT EXISTS idx_cc_spends_card_date
  ON credit_card_spends (card_id, spend_date DESC);

-- ── Payments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_card_payments (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID NOT NULL DEFAULT auth.uid()
              REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id     UUID NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,

  pay_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  amount      DECIMAL(12,2) NOT NULL CHECK (amount > 0),

  -- Which leg of the plan this payment was: a pre-statement top-up lowers the
  -- utilisation that gets reported, a clearance payment avoids interest. Kept
  -- so the history can show whether the plan was actually followed.
  kind        TEXT NOT NULL DEFAULT 'clearance'
              CHECK (kind IN ('pre_statement','clearance','other')),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_payments_card_date
  ON credit_card_payments (card_id, pay_date DESC);

-- ── Row level security ───────────────────────────────────────────
-- Owner-only. Note this intentionally does NOT use auth_shop_ids(): a shop
-- colleague must never see these rows, even on a shared shop.
ALTER TABLE credit_cards         ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card_spends   ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_card_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "credit_cards_own" ON credit_cards;
CREATE POLICY "credit_cards_own" ON credit_cards FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "credit_card_spends_own" ON credit_card_spends;
CREATE POLICY "credit_card_spends_own" ON credit_card_spends FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "credit_card_payments_own" ON credit_card_payments;
CREATE POLICY "credit_card_payments_own" ON credit_card_payments FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── Cross-user card ownership guard ──────────────────────────────
-- RLS alone is not enough here. The policies above only check that the *new
-- row's* user_id is mine; they say nothing about card_id. A caller who learned
-- another user's card UUID could therefore insert a spend owned by themselves
-- but pointing at that foreign card. It would stay invisible to the victim,
-- but any query that grouped by card_id alone would mix two users' money.
--
-- A CHECK constraint cannot run a subquery, so this has to be a trigger.
CREATE OR REPLACE FUNCTION fn_cc_assert_card_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT user_id INTO v_owner FROM credit_cards WHERE id = NEW.card_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Card % does not exist', NEW.card_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Pin the row to the card's owner rather than trusting the payload.
  NEW.user_id := v_owner;

  IF v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Card % belongs to another user', NEW.card_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cc_spends_owner ON credit_card_spends;
CREATE TRIGGER trg_cc_spends_owner
  BEFORE INSERT OR UPDATE ON credit_card_spends
  FOR EACH ROW EXECUTE FUNCTION fn_cc_assert_card_owner();

DROP TRIGGER IF EXISTS trg_cc_payments_owner ON credit_card_payments;
CREATE TRIGGER trg_cc_payments_owner
  BEFORE INSERT OR UPDATE ON credit_card_payments
  FOR EACH ROW EXECUTE FUNCTION fn_cc_assert_card_owner();

-- ── updated_at upkeep ────────────────────────────────────────────
-- Named with a cc_ prefix rather than reusing any existing touch function, so
-- this migration cannot redefine a function the billing tables depend on.
CREATE OR REPLACE FUNCTION fn_cc_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cc_cards_touch ON credit_cards;
CREATE TRIGGER trg_cc_cards_touch BEFORE UPDATE ON credit_cards
  FOR EACH ROW EXECUTE FUNCTION fn_cc_touch_updated_at();

DROP TRIGGER IF EXISTS trg_cc_spends_touch ON credit_card_spends;
CREATE TRIGGER trg_cc_spends_touch BEFORE UPDATE ON credit_card_spends
  FOR EACH ROW EXECUTE FUNCTION fn_cc_touch_updated_at();

DROP TRIGGER IF EXISTS trg_cc_payments_touch ON credit_card_payments;
CREATE TRIGGER trg_cc_payments_touch BEFORE UPDATE ON credit_card_payments
  FOR EACH ROW EXECUTE FUNCTION fn_cc_touch_updated_at();

COMMIT;

-- ── Verify (safe to run on its own afterwards) ───────────────────
-- Expect three rows, all with rowsecurity = true.
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE tablename IN ('credit_cards','credit_card_spends','credit_card_payments');
--
-- Expect zero rows: no spend or payment may ever sit under a different owner
-- than its card.
-- SELECT s.id FROM credit_card_spends s
--   JOIN credit_cards c ON c.id = s.card_id WHERE c.user_id <> s.user_id
-- UNION ALL
-- SELECT p.id FROM credit_card_payments p
--   JOIN credit_cards c ON c.id = p.card_id WHERE c.user_id <> p.user_id;
