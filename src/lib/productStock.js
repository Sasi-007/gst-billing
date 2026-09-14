import { supabase } from '@/lib/supabase'
import { applyLocalStockDeltaMap } from '@/lib/offlineBilling'
import { clearPageCacheByPrefix } from '@/lib/pageCache'

export function buildQuantityMap(items) {
  return (items || []).reduce((map, item) => {
    if (!item?.product_id) return map
    const qty = parseFloat(item.quantity) || 0
    map[item.product_id] = (map[item.product_id] || 0) + qty
    return map
  }, {})
}

export async function applyProductStockDeltaMap(shopId, deltaMap) {
  if (!shopId) return

  for (const [productId, delta] of Object.entries(deltaMap || {})) {
    if (!productId || !delta) continue

    const { data: productRow, error: productErr } = await supabase
      .from('products')
      .select('id,stock_qty')
      .eq('id', productId)
      .eq('shop_id', shopId)
      .single()
    if (productErr) throw productErr

    const nextStock = Number(productRow.stock_qty || 0) + Number(delta || 0)
    const { error: stockErr } = await supabase
      .from('products')
      .update({ stock_qty: nextStock })
      .eq('id', productId)
      .eq('shop_id', shopId)
    if (stockErr) throw stockErr
  }
}

export async function applyLocalProductStockDeltaMap(shopId, deltaMap) {
  await applyLocalStockDeltaMap(shopId, deltaMap)
}

function isRowNewer(nextRow, currentRow, billMap) {
  if (!currentRow) return true

  const nextBillDate = billMap.get(nextRow.purchase_bill_id)?.date || ''
  const currentBillDate = billMap.get(currentRow.purchase_bill_id)?.date || ''
  if (nextBillDate !== currentBillDate) return nextBillDate > currentBillDate

  const nextCreatedAt = new Date(nextRow.created_at || 0).getTime()
  const currentCreatedAt = new Date(currentRow.created_at || 0).getTime()
  return nextCreatedAt > currentCreatedAt
}

export async function syncProductPricingFromLatestPurchases(shopId, productIds) {
  const uniqueProductIds = [...new Set((productIds || []).filter(Boolean))]
  if (!shopId || uniqueProductIds.length === 0) return

  const { data: itemRows, error: itemErr } = await supabase
    .from('purchase_bill_items')
    .select('product_id,purchase_bill_id,rate,mrp,quantity,total,created_at')
    .eq('shop_id', shopId)
    .in('product_id', uniqueProductIds)
  if (itemErr) throw itemErr
  if (!itemRows?.length) return

  const purchaseBillIds = [...new Set(itemRows.map((row) => row.purchase_bill_id).filter(Boolean))]
  const { data: billRows, error: billErr } = await supabase
    .from('purchase_bills')
    .select('id,date')
    .in('id', purchaseBillIds)
  if (billErr) throw billErr

  const billMap = new Map((billRows || []).map((bill) => [bill.id, bill]))
  const latestByProduct = new Map()
  itemRows.forEach((row) => {
    const currentRow = latestByProduct.get(row.product_id)
    if (isRowNewer(row, currentRow, billMap)) {
      latestByProduct.set(row.product_id, row)
    }
  })

  for (const productId of uniqueProductIds) {
    const latestRow = latestByProduct.get(productId)
    if (!latestRow) continue

    const qty = Number(latestRow.quantity || 0)
    const netTotal = Number(latestRow.total || 0)
    const netPerUnit = qty > 0 ? netTotal / qty : Number(latestRow.rate || 0)

    const { error: updateErr } = await supabase
      .from('products')
      .update({
        purchase_price: Math.round(netPerUnit * 100) / 100,
        mrp: Number(latestRow.mrp || 0),
      })
      .eq('id', productId)
      .eq('shop_id', shopId)
    if (updateErr) throw updateErr
  }
}

export function invalidatePurchaseImpactCache(shopId) {
  if (!shopId) return

  clearPageCacheByPrefix([
    `dashboard:${shopId}`,
    `inventory:${shopId}:`,
    `summary:${shopId}:`,
    `reports:${shopId}:`,
    `purchases:${shopId}:`,
  ])
}
