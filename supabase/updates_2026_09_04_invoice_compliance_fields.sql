-- Add mandatory GST invoice fields: place of supply & reverse charge declaration

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS place_of_supply TEXT,
  ADD COLUMN IF NOT EXISTS reverse_charge  BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing rows with the shop's own state (assume intra-state sales for history)
UPDATE bills b
SET place_of_supply = s.state
FROM shops s
WHERE b.shop_id = s.id
  AND b.place_of_supply IS NULL;
