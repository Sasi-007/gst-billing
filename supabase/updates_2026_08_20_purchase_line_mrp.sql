-- Preserve purchase-bill MRP per line and refresh latest product defaults

ALTER TABLE purchase_bill_items
  ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2) DEFAULT 0;

UPDATE purchase_bill_items
SET mrp = rate
WHERE mrp IS NULL OR mrp = 0;

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
    UPDATE products
    SET stock_qty  = stock_qty - OLD.quantity,
        updated_at = NOW()
    WHERE id = OLD.product_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
