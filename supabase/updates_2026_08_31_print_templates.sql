-- Per-shop print template selection.
-- "standard" keeps the original A4/GST invoice layout.
-- "thermal_80mm" uses the narrow grocery receipt layout.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS print_template TEXT NOT NULL DEFAULT 'standard'
    CHECK (print_template IN ('standard','thermal_80mm'));
