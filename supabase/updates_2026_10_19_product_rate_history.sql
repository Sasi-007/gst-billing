-- Rate (price) history for products.
--
-- The shop maintains inventory primarily for rate upkeep rather than for
-- purchase-bill uploads, so a product's rate changes several times a year with
-- no purchase document behind it. Without this table the old rate is simply
-- overwritten and lost.
--
-- Logging is done by a trigger rather than by the app because product prices
-- are written from five different places (product form, price check, inventory
-- CSV upload, purchase import, quick add). A trigger is the only way to
-- guarantee no path can silently bypass the history.
--
-- Run once in the Supabase SQL editor.
--
-- Wrapped in a transaction: if any statement fails, the whole migration rolls
-- back and the database is left exactly as it was. It is also idempotent
-- (IF NOT EXISTS / OR REPLACE throughout), so re-running it is harmless.
BEGIN;

-- ── Staging columns ──────────────────────────────────────────────
-- The trigger cannot tell *why* a price changed, so writers may tag the
-- update in the same payload. Both are cleared after each log so a stale
-- value can never be attributed to a later, unrelated change.
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_price_source TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_price_note   TEXT;

CREATE TABLE IF NOT EXISTS product_price_history (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id         UUID NOT NULL REFERENCES shops(id)    ON DELETE CASCADE,

  -- Deferrable so the log row may be written from a BEFORE INSERT trigger,
  -- i.e. before the product row itself physically exists. The constraint is
  -- still enforced, just at commit time.
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE
                  DEFERRABLE INITIALLY DEFERRED,

  -- Date the rate took effect. Rates apply immediately, so this is the day
  -- the change was made.
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Rate in force from effective_date onward (all GST-inclusive, matching products).
  purchase_price  DECIMAL(10,2) DEFAULT 0,
  selling_price   DECIMAL(10,2) DEFAULT 0,
  mrp             DECIMAL(10,2) DEFAULT 0,
  gst_rate        DECIMAL(5,2)  DEFAULT 0,

  -- Rate it replaced. Denormalised deliberately: every screen shows
  -- "₹100 → ₹110", and keeping the previous value on the row makes that a
  -- plain SELECT instead of a window function over the whole table.
  prev_purchase_price DECIMAL(10,2),
  prev_selling_price  DECIMAL(10,2),
  prev_mrp            DECIMAL(10,2),

  source          TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('initial','manual','bulk','price-check','import','purchase')),
  note            TEXT,
  changed_by      UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Product timeline (newest first) is the dominant read.
CREATE INDEX IF NOT EXISTS idx_price_history_product
  ON product_price_history (product_id, effective_date DESC, created_at DESC);

-- "What changed across the shop this month" for the inventory list and extracts.
CREATE INDEX IF NOT EXISTS idx_price_history_shop_date
  ON product_price_history (shop_id, effective_date DESC);

ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_price_history_all" ON product_price_history;
CREATE POLICY "product_price_history_all" ON product_price_history FOR ALL
  USING  (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

-- ── Logging trigger ──────────────────────────────────────────────
-- Runs BEFORE so it can both read the caller's source tag and clear it on the
-- same row in one pass. Clearing in a separate trigger would not work: a
-- BEFORE trigger would blank the tag before an AFTER logger could read it.
CREATE OR REPLACE FUNCTION fn_log_product_price_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_source TEXT := COALESCE(NULLIF(NEW.last_price_source, ''), 'manual');
  v_changed BOOLEAN;
BEGIN
  -- last_price_source arrives from the client, so an unexpected value would
  -- otherwise trip the CHECK constraint and fail the whole product save.
  IF v_source NOT IN ('initial','manual','bulk','price-check','import','purchase') THEN
    v_source := 'manual';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Only record an opening rate when the product actually has one; a blank
    -- product created to be filled in later would otherwise log a 0 → 0 row.
    v_changed := COALESCE(NEW.purchase_price,0) <> 0
              OR COALESCE(NEW.selling_price,0) <> 0
              OR COALESCE(NEW.mrp,0) <> 0;
    IF v_source = 'manual' THEN v_source := 'initial'; END IF;
  ELSE
    -- IS DISTINCT FROM so a NULL → 0 transition is not mistaken for a change.
    v_changed := NEW.purchase_price IS DISTINCT FROM OLD.purchase_price
              OR NEW.selling_price  IS DISTINCT FROM OLD.selling_price
              OR NEW.mrp            IS DISTINCT FROM OLD.mrp;
  END IF;

  IF v_changed THEN
    INSERT INTO product_price_history (
      shop_id, product_id, purchase_price, selling_price, mrp, gst_rate,
      prev_purchase_price, prev_selling_price, prev_mrp,
      source, note, changed_by
    ) VALUES (
      NEW.shop_id, NEW.id,
      COALESCE(NEW.purchase_price,0), COALESCE(NEW.selling_price,0),
      COALESCE(NEW.mrp,0), COALESCE(NEW.gst_rate,0),
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.purchase_price END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.selling_price  END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.mrp            END,
      v_source, NULLIF(NEW.last_price_note, ''), auth.uid()
    );
  END IF;

  -- Always clear, even when nothing changed, so a tag can never be inherited
  -- by a later unrelated price change.
  NEW.last_price_source := NULL;
  NEW.last_price_note   := NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_price_history ON products;
CREATE TRIGGER trg_products_price_history
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION fn_log_product_price_change();

-- ── Backfill ─────────────────────────────────────────────────────
-- Seed one opening row per existing priced product so the timeline does not
-- start empty. Uses the product's own creation date, not today.
INSERT INTO product_price_history (
  shop_id, product_id, effective_date,
  purchase_price, selling_price, mrp, gst_rate, source, note
)
SELECT
  p.shop_id, p.id, COALESCE(p.created_at::DATE, CURRENT_DATE),
  COALESCE(p.purchase_price,0), COALESCE(p.selling_price,0),
  COALESCE(p.mrp,0), COALESCE(p.gst_rate,0), 'initial',
  'Opening rate recorded when rate history was enabled'
FROM products p
WHERE (COALESCE(p.purchase_price,0) <> 0
    OR COALESCE(p.selling_price,0) <> 0
    OR COALESCE(p.mrp,0) <> 0)
  AND NOT EXISTS (
    SELECT 1 FROM product_price_history h WHERE h.product_id = p.id
  );

COMMIT;

-- ── Verify (safe to run on its own afterwards) ───────────────────
-- Expect: one row per already-priced product, all tagged 'initial'.
-- SELECT source, COUNT(*) FROM product_price_history GROUP BY source;
