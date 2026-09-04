import { supabase } from '@/lib/supabase'

export async function loadOnlineStoreSummary(shopId) {
  const [
    settingsRes,
    productsRes,
    ordersRes,
  ] = await Promise.all([
    supabase.from('online_store_settings').select('*').eq('shop_id', shopId).maybeSingle(),
    supabase.from('products').select('id,name,local_name,online_name,selling_price,stock_qty,sell_online').eq('shop_id', shopId).eq('is_active', true).order('name'),
    supabase.from('online_orders').select('id,order_no,status,total,converted_bill_id,created_at').eq('shop_id', shopId).order('created_at', { ascending: false }).limit(20),
  ])

  if (settingsRes.error) throw settingsRes.error
  if (productsRes.error) throw productsRes.error
  if (ordersRes.error) throw ordersRes.error

  return {
    settings: settingsRes.data,
    products: productsRes.data || [],
    orders: ordersRes.data || [],
  }
}

export async function loadPublicStore(storeSlug) {
  const { data: settings, error: settingsError } = await supabase
    .from('online_store_settings')
    .select('*, shops(id,name,city,phone)')
    .eq('store_slug', storeSlug)
    .eq('is_online', true)
    .maybeSingle()

  if (settingsError) throw settingsError
  if (!settings?.shop_id) return { settings: null, products: [] }

  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id,name,local_name,online_name,online_description,online_image_url,unit,selling_price,mrp,stock_qty,category_id,categories(name)')
    .eq('shop_id', settings.shop_id)
    .eq('is_active', true)
    .eq('sell_online', true)
    .order('online_sort_order', { ascending: true })
    .order('name', { ascending: true })

  if (productsError) throw productsError

  return {
    settings,
    products: products || [],
  }
}
