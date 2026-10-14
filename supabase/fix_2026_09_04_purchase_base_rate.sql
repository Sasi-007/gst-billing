-- One-time correction: some purchase_bill_items saved between the GST-formula
-- fix and the base_rate fix have an incorrectly shrunk `base_rate`
-- (it was computed as rate / (1 + gst_rate/100) instead of using rate as-is,
-- since rate is the GST-exclusive base rate typed on the purchase page).
--
-- This recomputes base_rate = taxable_amount / quantity wherever taxable_amount
-- and quantity are present (i.e. rows created with the new purchase breakdown
-- feature), which is the correct GST-exclusive per-unit rate.
-- Rows without taxable_amount (older purchases, pre-dating this feature) are
-- left untouched since their base_rate was already correct.

UPDATE purchase_bill_items
SET base_rate = ROUND((taxable_amount / quantity)::numeric, 2)
WHERE quantity > 0
  AND taxable_amount > 0
  AND ABS(base_rate - (taxable_amount / quantity)) > 0.01;
