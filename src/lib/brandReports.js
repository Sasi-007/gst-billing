import { supabase } from '@/lib/supabase'
import { cleanBrandName } from '@/lib/brands'

const CHUNK = 100

function chunk(items, size = CHUNK) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function monthKey(date) {
  return String(date || '').slice(0, 7)
}

export function monthLabel(key) {
  if (!key) return '—'
  const [year, month] = key.split('-')
  const date = new Date(Number(year), Number(month) - 1, 1)
  return date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function fetchByProductIds(table, select, productIds) {
  const rows = []
  for (const ids of chunk(productIds, 50)) {
    // A chunk can exceed the 1000-row response cap, so page within it.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .in('product_id', ids)
        .order('id')
        .range(from, from + 999)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < 1000) break
    }
  }
  return rows
}

/**
 * Pulls every product, sale line and purchase line for one brand and rolls them
 * into a month-wise audit sheet.
 *
 * Closing stock is derived by walking the current on-hand quantity backwards
 * through each month's net movement, because stock levels are not snapshotted.
 */
export async function loadBrandReport(shopId, brandName) {
  const brand = cleanBrandName(brandName)
  const empty = { brand, products: [], months: [], totals: null, topProducts: [] }
  if (!shopId || !brand) return empty

  const { data: productRows, error: productErr } = await supabase
    .from('products')
    .select('id,name,local_name,unit,stock_qty,purchase_price,selling_price,mrp,min_stock,is_active,categories(name),suppliers(name)')
    .eq('shop_id', shopId)
    .eq('brand', brand)
    .order('name')
  if (productErr) throw productErr

  const products = productRows || []
  if (!products.length) return empty

  const productIds = products.map((product) => product.id)
  const [saleRows, purchaseRows] = await Promise.all([
    fetchByProductIds(
      'bill_items',
      'product_id,quantity,total,cost_price,base_rate,gst_amount,bills!inner(date,bill_type)',
      productIds,
    ),
    fetchByProductIds(
      'purchase_bill_items',
      'product_id,quantity,total,rate,base_rate,gst_amount,purchase_bills!inner(date)',
      productIds,
    ),
  ])

  const sales = saleRows.filter((row) => (row.bills?.bill_type || 'invoice') === 'invoice')
  const byMonth = new Map()

  function bucket(key) {
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        key,
        label: monthLabel(key),
        purchaseValue: 0,
        purchaseQty: 0,
        purchaseGst: 0,
        salesValue: 0,
        salesQty: 0,
        salesGst: 0,
        cogs: 0,
      })
    }
    return byMonth.get(key)
  }

  for (const row of sales) {
    const key = monthKey(row.bills?.date)
    if (!key) continue
    const entry = bucket(key)
    const qty = num(row.quantity)
    entry.salesQty += qty
    entry.salesValue += num(row.total)
    entry.salesGst += num(row.gst_amount)
    entry.cogs += qty * num(row.cost_price)
  }

  for (const row of purchaseRows) {
    const key = monthKey(row.purchase_bills?.date)
    if (!key) continue
    const entry = bucket(key)
    entry.purchaseQty += num(row.quantity)
    entry.purchaseValue += num(row.total)
    entry.purchaseGst += num(row.gst_amount)
  }

  const months = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))

  const currentStockQty = products.reduce((sum, product) => sum + num(product.stock_qty), 0)
  const avgCost = (() => {
    const withStock = products.filter((product) => num(product.stock_qty) > 0)
    const qty = withStock.reduce((sum, product) => sum + num(product.stock_qty), 0)
    const value = withStock.reduce((sum, product) => sum + num(product.stock_qty) * num(product.purchase_price), 0)
    if (qty > 0) return value / qty
    const prices = products.map((product) => num(product.purchase_price)).filter(Boolean)
    return prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0
  })()

  // Walk backwards: the latest month closes at today's on-hand quantity.
  let closing = currentStockQty
  for (let i = months.length - 1; i >= 0; i -= 1) {
    const month = months[i]
    month.closingQty = closing
    month.closingValue = closing * avgCost
    month.openingQty = closing - (month.purchaseQty - month.salesQty)
    month.openingValue = month.openingQty * avgCost
    month.grossProfit = month.salesValue - month.cogs
    closing = month.openingQty
  }

  const totals = months.reduce((acc, month) => ({
    purchaseValue: acc.purchaseValue + month.purchaseValue,
    purchaseQty: acc.purchaseQty + month.purchaseQty,
    salesValue: acc.salesValue + month.salesValue,
    salesQty: acc.salesQty + month.salesQty,
    cogs: acc.cogs + month.cogs,
    grossProfit: acc.grossProfit + month.grossProfit,
  }), { purchaseValue: 0, purchaseQty: 0, salesValue: 0, salesQty: 0, cogs: 0, grossProfit: 0 })

  totals.closingQty = currentStockQty
  totals.closingValue = currentStockQty * avgCost
  totals.avgCost = avgCost
  totals.productCount = products.length
  totals.activeCount = products.filter((product) => product.is_active !== false).length
  totals.lowStockCount = products.filter((product) => (
    num(product.min_stock) > 0 && num(product.stock_qty) <= num(product.min_stock)
  )).length

  const perProduct = new Map(products.map((product) => [product.id, {
    ...product,
    salesQty: 0,
    salesValue: 0,
    cogs: 0,
    purchaseQty: 0,
    purchaseValue: 0,
  }]))

  for (const row of sales) {
    const entry = perProduct.get(row.product_id)
    if (!entry) continue
    entry.salesQty += num(row.quantity)
    entry.salesValue += num(row.total)
    entry.cogs += num(row.quantity) * num(row.cost_price)
  }
  for (const row of purchaseRows) {
    const entry = perProduct.get(row.product_id)
    if (!entry) continue
    entry.purchaseQty += num(row.quantity)
    entry.purchaseValue += num(row.total)
  }

  const productStats = [...perProduct.values()].map((entry) => ({
    ...entry,
    grossProfit: entry.salesValue - entry.cogs,
    stockValue: num(entry.stock_qty) * num(entry.purchase_price),
  }))

  return {
    brand,
    products: productStats,
    months: months.slice().reverse(),
    totals,
    topProducts: productStats.slice().sort((a, b) => b.salesValue - a.salesValue).slice(0, 5),
  }
}

export function brandReportToCsvRows(report) {
  const rows = [['Month', 'Purchase ₹', 'Purchase Qty', 'Sales ₹', 'Sales Qty', 'COGS ₹', 'Gross Profit ₹', 'Closing Stock Qty', 'Closing Stock ₹']]
  for (const month of report.months) {
    rows.push([
      month.label,
      month.purchaseValue.toFixed(2),
      month.purchaseQty,
      month.salesValue.toFixed(2),
      month.salesQty,
      month.cogs.toFixed(2),
      month.grossProfit.toFixed(2),
      month.closingQty,
      month.closingValue.toFixed(2),
    ])
  }
  return rows
}
