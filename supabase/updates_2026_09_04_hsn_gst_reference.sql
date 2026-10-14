-- HSN → GST rate reference table (SUGGESTION ONLY, not a certified source)
-- Curated for common retail/grocery/general-store items. Always verify against
-- current CBIC notifications before relying on this for compliance purposes.

CREATE TABLE IF NOT EXISTS hsn_gst_reference (
  hsn_code     TEXT PRIMARY KEY,
  description  TEXT,
  gst_rate     DECIMAL(5,2) NOT NULL CHECK (gst_rate IN (0,3,5,12,18,28)),
  source       TEXT DEFAULT 'manual-curated',
  as_of        DATE DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hsn_gst_reference_prefix ON hsn_gst_reference (hsn_code text_pattern_ops);

-- Seed: common items for a general retail / grocery / kirana shop.
-- Rates as commonly published; VERIFY before trusting for filing/compliance.
INSERT INTO hsn_gst_reference (hsn_code, description, gst_rate) VALUES
  ('10063020', 'Basmati rice', 5),
  ('10064000', 'Broken rice', 5),
  ('11010000', 'Wheat/meslin flour (branded)', 5),
  ('11022000', 'Maize (corn) flour', 5),
  ('17019900', 'Refined sugar', 5),
  ('17041000', 'Chewing gum / bubble gum', 18),
  ('18069000', 'Chocolates and other cocoa preparations', 18),
  ('19011010', 'Milk based baby food', 18),
  ('19019090', 'Malt extract / food preparations of flour (residual)', 18),
  ('19021900', 'Pasta (uncooked)', 12),
  ('19041000', 'Corn flakes / breakfast cereals', 18),
  ('19053100', 'Sweet biscuits', 18),
  ('19059090', 'Bread, pastry, cakes (other)', 18),
  ('20079900', 'Jams, fruit jellies, marmalades', 12),
  ('21011100', 'Instant coffee', 18),
  ('21012000', 'Tea/coffee extracts, essences', 18),
  ('21032000', 'Tomato ketchup and sauces', 12),
  ('21050000', 'Ice cream', 18),
  ('21069099', 'Food preparations not elsewhere specified', 18),
  ('22011010', 'Mineral water (packaged drinking water)', 18),
  ('22021010', 'Aerated water / soft drinks', 28),
  ('22029020', 'Fruit pulp/juice based drinks', 12),
  ('25010000', 'Salt (edible)', 5),
  ('27101990', 'Lubricating oils', 18),
  ('30049099', 'Medicaments (other, retail)', 12),
  ('33049900', 'Cosmetics / skin care preparations', 18),
  ('33051000', 'Shampoos', 18),
  ('33061000', 'Toothpaste', 18),
  ('33072000', 'Deodorants / antiperspirants', 18),
  ('34011190', 'Soap (toilet, bar)', 18),
  ('34029090', 'Detergents / washing preparations', 18),
  ('39241090', 'Plastic tableware/kitchenware', 18),
  ('40151900', 'Rubber gloves', 18),
  ('48201000', 'Registers, notebooks, exercise books', 12),
  ('48202000', 'Exercise books', 12),
  ('49011010', 'Printed books', 0),
  ('61091000', 'T-shirts (cotton, knitted)', 5),
  ('62034200', 'Mens trousers (cotton, not knitted)', 5),
  ('63026000', 'Toilet linen / kitchen linen (cotton terry)', 12),
  ('64029990', 'Footwear (other, value based rate may vary)', 18),
  ('69120010', 'Tableware / kitchenware of ceramic', 12),
  ('70134100', 'Glassware for table/kitchen use', 18),
  ('73239390', 'Kitchenware/tableware of stainless steel', 12),
  ('82119200', 'Knives (other than fixed blade)', 18),
  ('84151010', 'Air conditioners (window/split)', 28),
  ('84181000', 'Refrigerators (combined fridge-freezer)', 18),
  ('84501100', 'Washing machines (fully automatic, <=10kg)', 18),
  ('85161010', 'Electric water heaters (immersion)', 18),
  ('85166000', 'Ovens, cookers, cooking plates (electric)', 18),
  ('85167900', 'Electro-thermic appliances (other)', 18),
  ('85173000', 'Telephone sets, smartphones', 18),
  ('85182100', 'Single loudspeakers', 18),
  ('85287200', 'Television receivers (color)', 18),
  ('85361090', 'Fuses / electrical switches', 18),
  ('85392200', 'LED bulbs / lamps', 12),
  ('85443000', 'Wiring sets / electrical cables', 18),
  ('90032900', 'Spectacle frames', 12),
  ('90031100', 'Spectacle frames (plastic)', 12),
  ('94017900', 'Chairs (other)', 18),
  ('94032000', 'Metal furniture', 18),
  ('94036000', 'Wooden furniture', 18),
  ('96032100', 'Toothbrushes', 18),
  ('96081010', 'Ball point pens', 12),
  ('96082000', 'Felt tipped / marker pens', 12)
ON CONFLICT (hsn_code) DO NOTHING;

-- Reference data only (no shop-specific or sensitive info) — allow all
-- authenticated app users to read it. No write policy is defined, so it
-- can only be modified via the SQL editor / service role.
ALTER TABLE hsn_gst_reference ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hsn_gst_reference_select" ON hsn_gst_reference;
CREATE POLICY "hsn_gst_reference_select" ON hsn_gst_reference FOR SELECT
  USING (true);
