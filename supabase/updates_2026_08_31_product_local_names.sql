-- Product local-language names and Tanglish search aliases.
-- Safe to run after schema_complete.sql.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS local_name TEXT,
  ADD COLUMN IF NOT EXISTS search_aliases TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS bill_name_mode TEXT NOT NULL DEFAULT 'english'
    CHECK (bill_name_mode IN ('english','local','both'));

CREATE OR REPLACE FUNCTION fn_update_search_text()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(
    COALESCE(NEW.name,'') || ' ' ||
    COALESCE(NEW.local_name,'') || ' ' ||
    COALESCE(NEW.brand,'') || ' ' ||
    COALESCE(NEW.barcode,'') || ' ' ||
    COALESCE(NEW.hsn_code,'') || ' ' ||
    array_to_string(COALESCE(NEW.tags,'{}'), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.search_aliases,'{}'), ' ')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_search ON products;
CREATE TRIGGER trg_product_search
  BEFORE INSERT OR UPDATE OF name, local_name, brand, barcode, hsn_code, tags, search_aliases
  ON products FOR EACH ROW EXECUTE FUNCTION fn_update_search_text();

UPDATE products
SET search_text = lower(
  COALESCE(name,'') || ' ' ||
  COALESCE(local_name,'') || ' ' ||
  COALESCE(brand,'') || ' ' ||
  COALESCE(barcode,'') || ' ' ||
  COALESCE(hsn_code,'') || ' ' ||
  array_to_string(COALESCE(tags,'{}'), ' ') || ' ' ||
  array_to_string(COALESCE(search_aliases,'{}'), ' ')
);
