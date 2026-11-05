import { supabase } from '@/lib/supabase'

const PAGE = 1000

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function monthKey(date) {
  return String(date || '').slice(0, 7)
}

export function monthLabel(key) {
  if (!key) return '—'
  const [year, month] = key.split('-')
  const date = new Date(Number(year), Number(month) - 1, 1)
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

export function financialYearOf(key) {
  if (!key) return ''
  const [year, month] = key.split('-').map(Number)
  const startYear = month >= 4 ? year : year - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

async function fetchAll(table, select, applyFilters) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from(table).select(select).range(from, from + PAGE - 1)
    query = applyFilters(query)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * Shop-wide month-wise balance sheet: sales, purchases and remaining stock.
 *
 * Stock levels are not snapshotted per month, so each month's closing stock
 * value is derived by rolling the current stock value backwards through that
 * month's purchase inflow and cost-of-goods outflow. Both sides use the
 * GST-inclusive purchase rate, which is the same basis the product stock value
 * is held at, so the roll-back stays consistent.
 */
export async function loadMonthlyBalanceSheet(shopId) {
  if (!shopId) return { months: [], totals: null, openingStockValue: 0 }

  const [bills, purchases, products] = await Promise.all([
    fetchAll(
      'bills',
      'id,date,total,subtotal,gst_amount,discount_amount,paid_amount',
      (query) => query.eq('shop_id', shopId).eq('bill_type', 'invoice').order('id'),
    ),
    fetchAll(
      'purchase_bills',
      'id,date,total,subtotal,gst_amount,paid_amount',
      (query) => query.eq('shop_id', shopId).order('id'),
    ),
    fetchAll(
      'products',
      'id,stock_qty,purchase_price',
      (query) => query.eq('shop_id', shopId).order('id'),
    ),
  ])

  const billDateById = new Map(bills.map((bill) => [bill.id, bill.date]))
  const billIds = bills.map((bill) => bill.id)

  const billItems = []
  for (let i = 0; i < billIds.length; i += 50) {
    const slice = billIds.slice(i, i + 50)
    // A slice of bills can exceed the 1000-row response cap, so page within it.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('bill_items')
        .select('bill_id,quantity,total,cost_price')
        .eq('shop_id', shopId)
        .in('bill_id', slice)
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) throw error
      billItems.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  }

  const byMonth = new Map()
  function bucket(key) {
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        key,
        label: monthLabel(key),
        financialYear: financialYearOf(key),
        salesValue: 0,
        salesTaxable: 0,
        salesGst: 0,
        salesCollected: 0,
        billCount: 0,
        purchaseValue: 0,
        purchaseTaxable: 0,
        purchaseGst: 0,
        purchasePaid: 0,
        purchaseCount: 0,
        cogs: 0,
      })
    }
    return byMonth.get(key)
  }

  for (const bill of bills) {
    const key = monthKey(bill.date)
    if (!key) continue
    const entry = bucket(key)
    entry.billCount += 1
    entry.salesValue += num(bill.total)
    entry.salesTaxable += num(bill.subtotal)
    entry.salesGst += num(bill.gst_amount)
    entry.salesCollected += num(bill.paid_amount)
  }

  for (const purchase of purchases) {
    const key = monthKey(purchase.date)
    if (!key) continue
    const entry = bucket(key)
    entry.purchaseCount += 1
    entry.purchaseValue += num(purchase.total)
    entry.purchaseTaxable += num(purchase.subtotal)
    entry.purchaseGst += num(purchase.gst_amount)
    entry.purchasePaid += num(purchase.paid_amount)
  }

  for (const item of billItems) {
    const key = monthKey(billDateById.get(item.bill_id))
    if (!key) continue
    bucket(key).cogs += num(item.quantity) * num(item.cost_price)
  }

  const months = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))

  const currentStockValue = products.reduce(
    (sum, product) => sum + Math.max(0, num(product.stock_qty)) * num(product.purchase_price),
    0,
  )

  let closing = currentStockValue
  for (let i = months.length - 1; i >= 0; i -= 1) {
    const month = months[i]
    month.closingStockValue = closing
    month.openingStockValue = closing - (month.purchaseValue - month.cogs)
    month.grossProfit = month.salesValue - month.cogs
    month.marginPct = month.salesValue > 0 ? (month.grossProfit / month.salesValue) * 100 : 0
    month.netGst = month.salesGst - month.purchaseGst
    closing = month.openingStockValue
  }

  const openingStockValue = months.length ? months[0].openingStockValue : currentStockValue

  const totals = months.reduce((acc, month) => ({
    salesValue: acc.salesValue + month.salesValue,
    salesTaxable: acc.salesTaxable + month.salesTaxable,
    salesGst: acc.salesGst + month.salesGst,
    billCount: acc.billCount + month.billCount,
    purchaseValue: acc.purchaseValue + month.purchaseValue,
    purchaseTaxable: acc.purchaseTaxable + month.purchaseTaxable,
    purchaseGst: acc.purchaseGst + month.purchaseGst,
    purchaseCount: acc.purchaseCount + month.purchaseCount,
    cogs: acc.cogs + month.cogs,
  }), {
    salesValue: 0, salesTaxable: 0, salesGst: 0, billCount: 0,
    purchaseValue: 0, purchaseTaxable: 0, purchaseGst: 0, purchaseCount: 0, cogs: 0,
  })

  totals.grossProfit = totals.salesValue - totals.cogs
  totals.marginPct = totals.salesValue > 0 ? (totals.grossProfit / totals.salesValue) * 100 : 0
  totals.netGst = totals.salesGst - totals.purchaseGst
  totals.closingStockValue = currentStockValue
  totals.openingStockValue = openingStockValue
  totals.productCount = products.length

  return { months: months.reverse(), totals, openingStockValue }
}

export function balanceSheetToCsv(months) {
  const rows = [[
    'Month', 'Opening Stock', 'Purchases', 'Sales', 'Cost of Goods Sold',
    'Gross Profit', 'Margin %', 'Remaining Stock', 'Sales GST', 'Purchase GST', 'Net GST', 'Bills', 'Purchase Bills',
  ]]
  for (const month of months) {
    rows.push([
      month.label,
      month.openingStockValue.toFixed(2),
      month.purchaseValue.toFixed(2),
      month.salesValue.toFixed(2),
      month.cogs.toFixed(2),
      month.grossProfit.toFixed(2),
      month.marginPct.toFixed(1),
      month.closingStockValue.toFixed(2),
      month.salesGst.toFixed(2),
      month.purchaseGst.toFixed(2),
      month.netGst.toFixed(2),
      month.billCount,
      month.purchaseCount,
    ])
  }
  return rows
}
