-- Add supplier-invoice-accurate purchase line fields: base rate breakdown,
-- scheme & cash discounts, taxable amount, CGST/SGST/IGST split, net amount.
-- These let the app trust the actual supplier invoice (most authoritative
-- source for GST rate/split on a purchased product) instead of external
-- HSN lookup tables.

ALTER TABLE purchase_bills
  ADD COLUMN IF NOT EXISTS is_interstate BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS round_off_amount DECIMAL(6,2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_bill_items
  ADD COLUMN IF NOT EXISTS sch_disc_pct     DECIMAL(5,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sch_disc_amount  DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_disc_pct    DECIMAL(5,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_disc_amount DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxable_amount   DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_amount      DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount      DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount      DECIMAL(10,2) DEFAULT 0;

-- Backfill taxable_amount / cgst / sgst from existing base_amount / gst_amount
-- (assume intra-state historically, matching current default calculation)
UPDATE purchase_bill_items
SET taxable_amount = COALESCE(NULLIF(taxable_amount, 0), base_rate * quantity, 0),
    cgst_amount     = COALESCE(NULLIF(cgst_amount, 0), gst_amount / 2, 0),
    sgst_amount     = COALESCE(NULLIF(sgst_amount, 0), gst_amount - (gst_amount / 2), 0)
WHERE taxable_amount = 0 AND gst_amount IS NOT NULL;
