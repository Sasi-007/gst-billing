-- Database-managed Tamil/local product name suggestion dictionary.
-- Run after updates_2026_08_31_product_local_names.sql.

CREATE TABLE IF NOT EXISTS product_name_suggestions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  english_name TEXT NOT NULL,
  local_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  language TEXT NOT NULL DEFAULT 'ta',
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_name_suggestions_active
  ON product_name_suggestions (is_active, language);

CREATE INDEX IF NOT EXISTS idx_product_name_suggestions_aliases
  ON product_name_suggestions USING GIN (aliases);

ALTER TABLE product_name_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_name_suggestions_read_active" ON product_name_suggestions;
CREATE POLICY "product_name_suggestions_read_active" ON product_name_suggestions FOR SELECT
  USING (is_active = TRUE);

INSERT INTO product_name_suggestions (english_name, local_name, aliases, language, category)
VALUES
  ('Toor Dal', 'துவரம் பருப்பு', ARRAY['toor dal','toor dall','tuvar dal','thuvaram paruppu','thuravam paruppu','toor paruppu'], 'ta', 'Dal'),
  ('Urad Dal', 'உளுந்தம் பருப்பு', ARRAY['urad dal','ulundhu','uluntham paruppu','black gram'], 'ta', 'Dal'),
  ('Moong Dal', 'பாசிப்பருப்பு', ARRAY['moong dal','paasi paruppu','pasi paruppu','green gram'], 'ta', 'Dal'),
  ('Chana Dal', 'கடலை பருப்பு', ARRAY['chana dal','kadalai paruppu','bengal gram'], 'ta', 'Dal'),
  ('Masoor Dal', 'மசூர் பருப்பு', ARRAY['masoor dal','masur dal','red lentil'], 'ta', 'Dal'),
  ('Rice', 'அரிசி', ARRAY['rice','arisi','ponni rice','sona masoori'], 'ta', 'Staples'),
  ('Sugar', 'சர்க்கரை', ARRAY['sugar','sakkarai','white sugar'], 'ta', 'Staples'),
  ('Salt', 'உப்பு', ARRAY['salt','uppu'], 'ta', 'Staples'),
  ('Tamarind', 'புளி', ARRAY['tamarind','puli'], 'ta', 'Spices'),
  ('Mustard Seeds', 'கடுகு', ARRAY['mustard','kadugu','mustard seeds'], 'ta', 'Spices'),
  ('Cumin', 'சீரகம்', ARRAY['cumin','seeragam','jeera'], 'ta', 'Spices'),
  ('Black Pepper', 'மிளகு', ARRAY['pepper','milagu','black pepper'], 'ta', 'Spices'),
  ('Turmeric Powder', 'மஞ்சள் தூள்', ARRAY['turmeric powder','manjal thool','manjal powder'], 'ta', 'Spices'),
  ('Chilli Powder', 'மிளகாய் தூள்', ARRAY['chilli powder','milagai thool','red chilli powder'], 'ta', 'Spices'),
  ('Wheat Flour', 'கோதுமை மாவு', ARRAY['wheat flour','atta','godhumai maavu'], 'ta', 'Flour'),
  ('Rava', 'ரவை', ARRAY['rava','sooji','suji'], 'ta', 'Staples'),
  ('Cooking Oil', 'எண்ணெய்', ARRAY['oil','ennai','cooking oil'], 'ta', 'Oil'),
  ('Ghee', 'நெய்', ARRAY['ghee','nei'], 'ta', 'Dairy')
ON CONFLICT DO NOTHING;
