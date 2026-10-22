-- Purchase stock trigger: adjust stock only, never prices.
--
-- Why
-- ---
-- fn_stock_on_purchase used to also write product prices on every inserted
-- purchase line:
--
--   purchase_price = NEW.rate
--   mrp            = COALESCE(NULLIF(NEW.mrp, 0), mrp)
--
-- That fought the application, which writes the same two columns straight
-- afterwards via syncProductPricingFromLatestPurchases(), and caused three
-- defects that only showed up some of the time:
--
--   1. products.purchase_price is GST-INCLUSIVE landing cost per unit, but the
--      trigger stored NEW.rate, the GST-EXCLUSIVE base rate. The app then
--      corrected it to net ÷ qty — so a product showed the wrong cost whenever
--      that follow-up call did not run (offline save, network error, a purchase
--      row inserted from SQL or any other client).
--   2. A manually corrected MRP was silently replaced by the MRP printed on the
--      purchase bill.
--   3. The price-history trigger saw an update carrying no last_price_source,
--      so purchase-driven price moves were logged as 'manual' edits.
--
-- Stock is different: it must stay in the trigger, because it has to move
-- atomically with the line item.
--
-- Run once in the Supabase SQL editor. Idempotent and wrapped in a transaction.
BEGIN;

CREATE OR REPLACE FUNCTION fn_stock_on_purchase()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.product_id IS NOT NULL THEN
    UPDATE products
    SET stock_qty  = stock_qty + NEW.quantity,
        updated_at = NOW()
    WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' AND OLD.product_id IS NOT NULL THEN
    UPDATE products
    SET stock_qty  = stock_qty - OLD.quantity,
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

COMMIT;

-- ── Optional repair ──────────────────────────────────────────────
-- Products whose cost was left at the GST-exclusive base rate by the old
-- trigger. Review the list first, then run the UPDATE if it looks right.
--
-- SELECT p.id, p.name, p.purchase_price AS stored_cost,
--        ROUND(i.total / NULLIF(i.quantity, 0), 2) AS landing_cost
-- FROM products p
-- JOIN LATERAL (
--   SELECT pbi.quantity, pbi.total
--   FROM purchase_bill_items pbi
--   JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
--   WHERE pbi.product_id = p.id
--   ORDER BY pb.date DESC, pbi.created_at DESC
--   LIMIT 1
-- ) i ON TRUE
-- WHERE i.quantity > 0
--   AND p.purchase_price IS DISTINCT FROM ROUND(i.total / i.quantity, 2);
--
-- UPDATE products p
-- SET purchase_price    = ROUND(i.total / i.quantity, 2),
--     last_price_source = 'purchase',
--     last_price_note   = 'Recalculated from latest purchase landing cost'
-- FROM LATERAL (
--   SELECT pbi.quantity, pbi.total
--   FROM purchase_bill_items pbi
--   JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
--   WHERE pbi.product_id = p.id
--   ORDER BY pb.date DESC, pbi.created_at DESC
--   LIMIT 1
-- ) i
-- WHERE i.quantity > 0
--   AND p.purchase_price IS DISTINCT FROM ROUND(i.total / i.quantity, 2);
