-- Optional ecommerce module for the GST billing app.
-- Run after schema_complete.sql. Billing-only shops are unaffected until ecommerce is enabled.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS ecommerce_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS online_order_prefix TEXT NOT NULL DEFAULT 'WEB',
  ADD COLUMN IF NOT EXISTS online_order_counter INTEGER NOT NULL DEFAULT 0;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sell_online BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS online_name TEXT,
  ADD COLUMN IF NOT EXISTS online_description TEXT,
  ADD COLUMN IF NOT EXISTS online_image_url TEXT,
  ADD COLUMN IF NOT EXISTS online_sort_order INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS online_store_settings (
  shop_id UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  store_name TEXT,
  store_slug TEXT NOT NULL UNIQUE,
  headline TEXT,
  delivery_radius_km DECIMAL(6, 2),
  minimum_order_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  delivery_fee DECIMAL(10, 2) NOT NULL DEFAULT 0,
  accepts_cod BOOLEAN NOT NULL DEFAULT TRUE,
  accepts_upi BOOLEAN NOT NULL DEFAULT FALSE,
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  label TEXT DEFAULT 'Home',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT,
  pincode TEXT,
  landmark TEXT,
  latitude DECIMAL(10, 7),
  longitude DECIMAL(10, 7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  address_id UUID REFERENCES customer_addresses(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed','accepted','packed','out_for_delivery','delivered','cancelled')),
  payment_mode TEXT NOT NULL DEFAULT 'cod'
    CHECK (payment_mode IN ('cod','upi','card')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','paid','failed','refunded')),
  subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0,
  delivery_fee DECIMAL(10, 2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  converted_bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, order_no)
);

CREATE TABLE IF NOT EXISTS online_order_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  online_order_id UUID NOT NULL REFERENCES online_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT DEFAULT 'pcs',
  quantity DECIMAL(10, 3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  rate DECIMAL(10, 2) NOT NULL DEFAULT 0,
  gst_rate DECIMAL(5, 2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS online_delivery_assignments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  online_order_id UUID NOT NULL UNIQUE REFERENCES online_orders(id) ON DELETE CASCADE,
  delivery_person_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted','picked_up','out_for_delivery','delivered','failed')),
  cash_collected BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_products_online
  ON products (shop_id, sell_online, online_sort_order)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_online_orders_shop_status
  ON online_orders (shop_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_online_order_items_order
  ON online_order_items (online_order_id);
CREATE INDEX IF NOT EXISTS idx_online_delivery_shop_status
  ON online_delivery_assignments (shop_id, status);

CREATE OR REPLACE FUNCTION get_next_online_order_no(p_shop_id UUID, p_prefix TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_counter INTEGER;
BEGIN
  UPDATE shops
  SET online_order_counter = online_order_counter + 1
  WHERE id = p_shop_id
  RETURNING online_order_counter INTO v_counter;

  RETURN p_prefix || '-' || LPAD(v_counter::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION convert_online_order_to_bill(p_online_order_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order online_orders%ROWTYPE;
  v_shop shops%ROWTYPE;
  v_bill_id UUID;
  v_bill_no TEXT;
  v_item RECORD;
  v_sl_no INTEGER := 0;
  v_taxable_total DECIMAL(12, 2);
  v_gst_total DECIMAL(12, 2);
BEGIN
  SELECT * INTO v_order
  FROM online_orders
  WHERE id = p_online_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Online order not found';
  END IF;

  IF NOT (v_order.shop_id = ANY(auth_shop_ids())) THEN
    RAISE EXCEPTION 'Not allowed to convert this online order';
  END IF;

  IF v_order.converted_bill_id IS NOT NULL THEN
    RETURN v_order.converted_bill_id;
  END IF;

  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled online order cannot be converted to bill';
  END IF;

  SELECT * INTO v_shop
  FROM shops
  WHERE id = v_order.shop_id;

  v_bill_no := get_next_bill_no(v_order.shop_id, COALESCE(v_shop.bill_prefix, 'INV'));

  SELECT
    COALESCE(SUM(total - gst_amount), 0),
    COALESCE(SUM(gst_amount), 0)
  INTO v_taxable_total, v_gst_total
  FROM online_order_items
  WHERE online_order_id = v_order.id;

  INSERT INTO bills (
    shop_id, bill_no, bill_type, date,
    customer_id, customer_name, customer_phone, customer_address,
    subtotal, cgst_amount, sgst_amount, igst_amount, gst_amount,
    discount_amount, total, paid_amount, payment_mode, payment_status, notes
  )
  VALUES (
    v_order.shop_id, v_bill_no, 'invoice', CURRENT_DATE,
    v_order.customer_id, v_order.customer_name, v_order.customer_phone, v_order.customer_address,
    v_taxable_total,
    ROUND((v_gst_total / 2)::NUMERIC, 2),
    ROUND((v_gst_total / 2)::NUMERIC, 2),
    0,
    v_gst_total,
    v_order.discount_amount,
    v_order.total,
    CASE WHEN v_order.payment_status = 'paid' THEN v_order.total ELSE 0 END,
    CASE
      WHEN v_order.payment_mode = 'cod' THEN 'cash'
      WHEN v_order.payment_mode = 'upi' THEN 'upi'
      WHEN v_order.payment_mode = 'card' THEN 'card'
      ELSE 'cash'
    END,
    CASE WHEN v_order.payment_status = 'paid' THEN 'paid' ELSE 'unpaid' END,
    CONCAT('Converted from online order ', v_order.order_no, COALESCE(': ' || v_order.notes, ''))
  )
  RETURNING id INTO v_bill_id;

  FOR v_item IN
    SELECT *
    FROM online_order_items
    WHERE online_order_id = v_order.id
    ORDER BY created_at, id
  LOOP
    v_sl_no := v_sl_no + 1;

    INSERT INTO bill_items (
      shop_id, bill_id, product_id, sl_no,
      product_name, hsn_code, unit,
      quantity, mrp, cost_price, rate, base_rate,
      gst_rate, gst_amount, discount_pct, discount_amount, total
    )
    SELECT
      v_order.shop_id,
      v_bill_id,
      v_item.product_id,
      v_sl_no,
      v_item.product_name,
      v_item.hsn_code,
      v_item.unit,
      v_item.quantity,
      COALESCE(p.mrp, v_item.rate),
      COALESCE(p.purchase_price, 0),
      v_item.rate,
      CASE
        WHEN COALESCE(v_item.gst_rate, 0) > 0
          THEN ROUND((v_item.rate / (1 + (v_item.gst_rate / 100)))::NUMERIC, 2)
        ELSE v_item.rate
      END,
      v_item.gst_rate,
      v_item.gst_amount,
      0,
      0,
      v_item.total
    FROM products p
    WHERE p.id = v_item.product_id;

    IF v_item.product_id IS NULL THEN
      INSERT INTO bill_items (
        shop_id, bill_id, sl_no, product_name, hsn_code, unit,
        quantity, rate, base_rate, gst_rate, gst_amount, total
      )
      VALUES (
        v_order.shop_id, v_bill_id, v_sl_no, v_item.product_name, v_item.hsn_code, v_item.unit,
        v_item.quantity, v_item.rate,
        CASE
          WHEN COALESCE(v_item.gst_rate, 0) > 0
            THEN ROUND((v_item.rate / (1 + (v_item.gst_rate / 100)))::NUMERIC, 2)
          ELSE v_item.rate
        END,
        v_item.gst_rate, v_item.gst_amount, v_item.total
      );
    END IF;
  END LOOP;

  UPDATE online_orders
  SET converted_bill_id = v_bill_id,
      status = CASE WHEN status = 'placed' THEN 'accepted' ELSE status END,
      updated_at = NOW()
  WHERE id = v_order.id;

  RETURN v_bill_id;
END;
$$;

ALTER TABLE online_store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_delivery_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "online_store_settings_staff_all" ON online_store_settings;
CREATE POLICY "online_store_settings_staff_all" ON online_store_settings FOR ALL
  USING (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "online_store_settings_public_read" ON online_store_settings;
CREATE POLICY "online_store_settings_public_read" ON online_store_settings FOR SELECT
  USING (is_online = TRUE);

DROP POLICY IF EXISTS "customer_addresses_staff_all" ON customer_addresses;
CREATE POLICY "customer_addresses_staff_all" ON customer_addresses FOR ALL
  USING (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "online_orders_staff_all" ON online_orders;
CREATE POLICY "online_orders_staff_all" ON online_orders FOR ALL
  USING (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "online_orders_public_insert" ON online_orders;
CREATE POLICY "online_orders_public_insert" ON online_orders FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM online_store_settings oss
      WHERE oss.shop_id = online_orders.shop_id
        AND oss.is_online = TRUE
    )
  );

DROP POLICY IF EXISTS "online_order_items_staff_all" ON online_order_items;
CREATE POLICY "online_order_items_staff_all" ON online_order_items FOR ALL
  USING (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "online_order_items_public_insert" ON online_order_items;
CREATE POLICY "online_order_items_public_insert" ON online_order_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM online_orders oo
      JOIN online_store_settings oss ON oss.shop_id = oo.shop_id
      WHERE oo.id = online_order_items.online_order_id
        AND oo.shop_id = online_order_items.shop_id
        AND oss.is_online = TRUE
    )
  );

DROP POLICY IF EXISTS "online_delivery_assignments_staff_all" ON online_delivery_assignments;
CREATE POLICY "online_delivery_assignments_staff_all" ON online_delivery_assignments FOR ALL
  USING (shop_id = ANY(auth_shop_ids()))
  WITH CHECK (shop_id = ANY(auth_shop_ids()));

DROP POLICY IF EXISTS "shops_public_online_read" ON shops;
CREATE POLICY "shops_public_online_read" ON shops FOR SELECT
  USING (is_active = TRUE AND ecommerce_enabled = TRUE);

DROP POLICY IF EXISTS "categories_public_online_read" ON categories;
CREATE POLICY "categories_public_online_read" ON categories FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM products p
      JOIN online_store_settings oss ON oss.shop_id = p.shop_id
      WHERE p.category_id = categories.id
        AND p.shop_id = categories.shop_id
        AND p.is_active = TRUE
        AND p.sell_online = TRUE
        AND oss.is_online = TRUE
    )
  );

DROP POLICY IF EXISTS "products_public_online_read" ON products;
CREATE POLICY "products_public_online_read" ON products FOR SELECT
  USING (
    is_active = TRUE
    AND sell_online = TRUE
    AND EXISTS (
      SELECT 1
      FROM online_store_settings oss
      WHERE oss.shop_id = products.shop_id
        AND oss.is_online = TRUE
    )
  );
