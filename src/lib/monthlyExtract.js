/**
 * Monthly extract pack.
 *
 * Shops file GST after the month closes, so once a period is finalised the
 * owner needs one self-contained bundle of that month's books: GST registers,
 * stock held, and the master data needed to rebuild the shop. This module
 * gathers the period's data in one pass and turns it into the files that go
 * into the downloadable archive.
 *
 * All reads are paged/batched because a month easily exceeds PostgREST's
 * 1000-row cap and its practical `.in()` URL length limit.
 */

import { supabase } from './supabase'
import { fetchAllRows, fetchAllRowsByIds } from './supabaseBatch'
import { buildGstRegisters, formatReportDate, num, round2 } from './gstRegisters'
import { fetchPriceHistoryForPeriod, sourceLabel } from './priceHistory'

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** First day of `year`-`month` (1-based month) as an ISO date string. */
export function monthStart(year, month) {
  return `${year}-${pad2(month)}-01`
}

/** Last day of `year`-`month`; day 0 of the next month rolls back one day. */
export function monthEnd(year, month) {
  const date = new Date(year, month, 0)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`
}

function todayStr() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/**
 * Stock quantities as they stood at the close of `asOnDate`.
 *
 * `products.stock_qty` is always *live*, but an extract is normally taken well
 * after the period closed (GST filing runs to the 20th of the following
 * month), so using it verbatim would report next month's stock against last
 * month's books. Movements dated after the period are therefore rewound:
 * purchases that arrived later are subtracted, sales made later are added
 * back.
 *
 * Returns a Map of product_id → quantity, plus what was rewound so the figure
 * can be explained in the README rather than silently differing from the
 * Inventory screen.
 */
export async function fetchStockAsOn({ shopId, asOnDate, products }) {
  const quantities = new Map(products.map((product) => [product.id, num(product.stock_qty)]))
  const result = {
    quantities,
    asOnDate,
    isHistorical: false,
    laterPurchaseUnits: 0,
    laterSaleUnits: 0,
    laterBills: 0,
  }

  // Nothing to rewind for a period that ends today or later.
  if (!asOnDate || asOnDate >= todayStr()) return result
  result.isHistorical = true

  const [laterPurchaseBills, laterSalesBills] = await Promise.all([
    fetchAllRows(() => supabase
      .from('purchase_bills')
      .select('id')
      .eq('shop_id', shopId)
      .gt('date', asOnDate)),
    // Only invoices move stock; quotations and estimates do not.
    fetchAllRows(() => supabase
      .from('bills')
      .select('id')
      .eq('shop_id', shopId)
      .eq('bill_type', 'invoice')
      .gt('date', asOnDate)),
  ])

  result.laterBills = laterPurchaseBills.length + laterSalesBills.length
  if (result.laterBills === 0) return result

  const [laterPurchaseItems, laterSalesItems] = await Promise.all([
    fetchAllRowsByIds(
      () => supabase.from('purchase_bill_items').select('product_id,quantity').eq('shop_id', shopId),
      'purchase_bill_id',
      laterPurchaseBills.map((bill) => bill.id)
    ),
    fetchAllRowsByIds(
      () => supabase.from('bill_items').select('product_id,quantity').eq('shop_id', shopId),
      'bill_id',
      laterSalesBills.map((bill) => bill.id)
    ),
  ])

  laterPurchaseItems.forEach((row) => {
    if (!row.product_id || !quantities.has(row.product_id)) return
    result.laterPurchaseUnits += num(row.quantity)
    quantities.set(row.product_id, quantities.get(row.product_id) - num(row.quantity))
  })
  laterSalesItems.forEach((row) => {
    if (!row.product_id || !quantities.has(row.product_id)) return
    result.laterSaleUnits += num(row.quantity)
    quantities.set(row.product_id, quantities.get(row.product_id) + num(row.quantity))
  })

  return result
}

/**
 * Finds the earliest and latest dated records so the period picker can offer
 * only months the shop actually traded in. Returns `[]` when there is no data.
 */
export async function fetchAvailableMonths(shopId) {
  const pickDate = async (table, ascending) => {
    const { data, error } = await supabase
      .from(table)
      .select('date')
      .eq('shop_id', shopId)
      .order('date', { ascending })
      .limit(1)
    if (error) throw error
    return data?.[0]?.date || null
  }

  const [firstBill, lastBill, firstPurchase, lastPurchase] = await Promise.all([
    pickDate('bills', true),
    pickDate('bills', false),
    pickDate('purchase_bills', true),
    pickDate('purchase_bills', false),
  ])

  const earliest = [firstBill, firstPurchase].filter(Boolean).sort()[0]
  const latest = [lastBill, lastPurchase].filter(Boolean).sort().slice(-1)[0]
  if (!earliest || !latest) return []

  const months = []
  const start = new Date(`${earliest.slice(0, 7)}-01T00:00:00`)
  const end = new Date(`${latest.slice(0, 7)}-01T00:00:00`)
  for (let cursor = start; cursor <= end; cursor.setMonth(cursor.getMonth() + 1)) {
    months.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 })
  }

  // Newest first — the month just closed is the one being filed.
  return months.reverse().map((entry) => ({
    ...entry,
    value: `${entry.year}-${pad2(entry.month)}`,
    label: monthLabel(entry.year, entry.month),
    dateFrom: monthStart(entry.year, entry.month),
    dateTo: monthEnd(entry.year, entry.month),
  }))
}

/** Loads every record needed to build the pack for one period. */
export async function fetchPeriodDataset({ shopId, dateFrom, dateTo }) {
  const [allBills, purchaseBills, expenses, products, suppliers, customers] = await Promise.all([
    fetchAllRows(() => supabase
      .from('bills')
      .select('*')
      .eq('shop_id', shopId)
      .gte('date', dateFrom)
      .lte('date', dateTo)),
    fetchAllRows(() => supabase
      .from('purchase_bills')
      .select('*, suppliers(name,gstin,phone)')
      .eq('shop_id', shopId)
      .gte('date', dateFrom)
      .lte('date', dateTo)),
    fetchAllRows(() => supabase
      .from('expenses')
      .select('*')
      .eq('shop_id', shopId)
      .gte('expense_date', dateFrom)
      .lte('expense_date', dateTo)),
    fetchAllRows(() => supabase
      .from('products')
      .select('id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,hsn_code,purchase_price,mrp,selling_price,gst_rate,stock_qty,min_stock,is_active,categories(name),suppliers(name,phone)')
      .eq('shop_id', shopId)),
    fetchAllRows(() => supabase
      .from('suppliers')
      .select('*')
      .eq('shop_id', shopId)),
    fetchAllRows(() => supabase
      .from('customers')
      .select('*')
      .eq('shop_id', shopId)),
  ])

  const salesInvoices = allBills.filter((bill) => bill.bill_type === 'invoice')
  const otherBills = allBills.filter((bill) => bill.bill_type !== 'invoice')

  const [salesItems, purchaseItems] = await Promise.all([
    fetchAllRowsByIds(
      () => supabase
        .from('bill_items')
        .select('id,bill_id,sl_no,product_name,hsn_code,unit,quantity,mrp,rate,base_rate,gst_rate,gst_amount,discount_amount,total')
        .eq('shop_id', shopId),
      'bill_id',
      salesInvoices.map((bill) => bill.id)
    ),
    fetchAllRowsByIds(
      () => supabase
        .from('purchase_bill_items')
        .select('id,purchase_bill_id,sl_no,product_name,hsn_code,unit,quantity,mrp,rate,base_rate,taxable_amount,gst_rate,gst_amount,cgst_amount,sgst_amount,igst_amount,total')
        .eq('shop_id', shopId),
      'purchase_bill_id',
      purchaseBills.map((bill) => bill.id)
    ),
  ])

  const byDateThenNo = (a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.bill_no || '').localeCompare(String(b.bill_no || ''), undefined, { numeric: true })

  // Stock as at period end, and rate revisions made during the period. Both
  // are tolerated as missing: a shop that has not run the rate-history
  // migration must still get its registers.
  const [stockAsOn, rateChanges] = await Promise.all([
    fetchStockAsOn({ shopId, asOnDate: dateTo, products }),
    fetchPriceHistoryForPeriod(shopId, dateFrom, dateTo).catch(() => null),
  ])

  return {
    dateFrom,
    dateTo,
    salesInvoices: salesInvoices.sort(byDateThenNo),
    otherBills: otherBills.sort(byDateThenNo),
    purchaseBills: purchaseBills.sort(byDateThenNo),
    salesItems,
    purchaseItems,
    stockAsOn,
    rateChanges,
    expenses: expenses.sort((a, b) => String(a.expense_date || '').localeCompare(String(b.expense_date || ''))),
    products: products.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    suppliers: suppliers.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    customers: customers.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
  }
}

// ── CSV helpers ─────────────────────────────────────────────────────────────

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Serialises rows to CSV. A UTF-8 BOM is prepended because Excel on Windows
 * otherwise renders ₹ and Tamil product names as mojibake.
 */
export function toCsv(headers, rows) {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ]
  return `\ufeff${lines.join('\r\n')}\r\n`
}

/** Headers come from the first row, falling back to a fixed shape when empty. */
function csvFor(rows, fallbackHeaders) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : (fallbackHeaders || [])
  return toCsv(headers, rows)
}

function dueAmount(bill) {
  return round2(Math.max(0, num(bill.total) - num(bill.paid_amount)))
}

// ── Row builders for the non-GST files ──────────────────────────────────────

function buildInvoiceSummaryRows(salesInvoices) {
  return salesInvoices.map((bill) => ({
    Date: formatReportDate(bill.date),
    'Invoice No': bill.bill_no,
    Customer: bill.customer_name || 'B2C Customer',
    Phone: bill.customer_phone || '',
    GSTIN: bill.customer_gstin || '',
    Type: bill.customer_gstin ? 'B2B' : 'B2C',
    'Taxable Value': round2(bill.subtotal),
    CGST: round2(bill.cgst_amount),
    SGST: round2(bill.sgst_amount),
    IGST: round2(bill.igst_amount),
    'Total GST': round2(bill.gst_amount),
    Discount: round2(bill.discount_amount),
    'Invoice Total': round2(bill.total),
    Paid: round2(bill.paid_amount),
    Due: dueAmount(bill),
    'Payment Mode': bill.payment_mode || '',
    'Payment Status': bill.payment_status || '',
    Notes: bill.notes || '',
  }))
}

function buildPurchaseSummaryRows(purchaseBills) {
  return purchaseBills.map((bill) => ({
    Date: formatReportDate(bill.date),
    'Purchase No': bill.bill_no,
    'Supplier Invoice No': bill.supplier_invoice_no || '',
    Supplier: bill.suppliers?.name || '',
    'Supplier GSTIN': bill.suppliers?.gstin || '',
    Interstate: bill.is_interstate ? 'Yes' : 'No',
    'Taxable Value': round2(bill.subtotal),
    'Input GST': round2(bill.gst_amount),
    'Invoice Total': round2(bill.total),
    Paid: round2(bill.paid_amount),
    Due: dueAmount(bill),
    'Payment Mode': bill.payment_mode || '',
    'Payment Status': bill.payment_status || '',
    Notes: bill.notes || '',
  }))
}

function buildOtherBillRows(otherBills) {
  return otherBills.map((bill) => ({
    Date: formatReportDate(bill.date),
    'Bill No': bill.bill_no,
    Type: bill.bill_type || '',
    Customer: bill.customer_name || '',
    Phone: bill.customer_phone || '',
    'Taxable Value': round2(bill.subtotal),
    GST: round2(bill.gst_amount),
    Total: round2(bill.total),
    Paid: round2(bill.paid_amount),
    Due: dueAmount(bill),
    'Payment Status': bill.payment_status || '',
  }))
}

/**
 * Stock still held, valued at cost and at selling price.
 *
 * `quantities` (product_id → qty) overrides the live `stock_qty` so the file
 * reports the position at period end. Rates are necessarily the current ones:
 * only quantities can be rewound, not historical cost.
 */
export function buildStockOnHand(products, quantities = null) {
  const qtyFor = (product) => (
    quantities && quantities.has(product.id) ? num(quantities.get(product.id)) : num(product.stock_qty)
  )

  return products
    .filter((product) => qtyFor(product) > 0)
    .map((product) => {
      const qty = round2(qtyFor(product))
      const cost = num(product.purchase_price)
      const sell = num(product.selling_price) || num(product.mrp)
      return {
        Product: product.name || '',
        'Local Name': product.local_name || '',
        Brand: product.brand || '',
        Category: product.categories?.name || '',
        Barcode: product.barcode || '',
        HSN: product.hsn_code || '',
        Unit: product.unit || '',
        'GST Rate': `${num(product.gst_rate)}%`,
        Quantity: qty,
        'Purchase Price': round2(cost),
        'Selling Price': round2(product.selling_price),
        MRP: round2(product.mrp),
        'Stock Value (Cost)': round2(qty * cost),
        'Stock Value (Selling)': round2(qty * sell),
        'Min Stock': round2(product.min_stock),
        'Below Min': qty <= num(product.min_stock) ? 'Yes' : 'No',
        Supplier: product.suppliers?.name || '',
        Active: product.is_active === false ? 'No' : 'Yes',
      }
    })
    .sort((a, b) => b['Stock Value (Cost)'] - a['Stock Value (Cost)'])
}

/** Rate revisions made during the period, oldest first. */
function buildRateChangeRows(rateChanges) {
  return (rateChanges || []).map((row) => {
    const prevSell = row.prev_selling_price
    const changeAmount = prevSell === null || prevSell === undefined
      ? null
      : round2(num(row.selling_price) - num(prevSell))

    return {
      Date: formatReportDate(row.effective_date),
      Product: row.products?.name || '',
      'Local Name': row.products?.local_name || '',
      Unit: row.products?.unit || '',
      HSN: row.products?.hsn_code || '',
      'Old Purchase Price': row.prev_purchase_price === null || row.prev_purchase_price === undefined ? '' : round2(row.prev_purchase_price),
      'New Purchase Price': round2(row.purchase_price),
      'Old Selling Price': prevSell === null || prevSell === undefined ? '' : round2(prevSell),
      'New Selling Price': round2(row.selling_price),
      'Old MRP': row.prev_mrp === null || row.prev_mrp === undefined ? '' : round2(row.prev_mrp),
      'New MRP': round2(row.mrp),
      'Selling Change': changeAmount === null ? '' : changeAmount,
      Direction: changeAmount === null ? 'Opening' : changeAmount > 0 ? 'Increase' : changeAmount < 0 ? 'Decrease' : 'No change',
      'GST Rate': `${num(row.gst_rate)}%`,
      Source: sourceLabel(row.source),
      Reason: row.note || '',
    }
  })
}

/**
 * Full product master in the exact column order the Inventory page imports,
 * so this file can be re-uploaded to restore the catalogue.
 */
function buildInventoryBackupRows(products) {
  return products.map((product) => ({
    name: product.name || '',
    local_name: product.local_name || '',
    search_aliases: Array.isArray(product.search_aliases) ? product.search_aliases.join(', ') : (product.search_aliases || ''),
    bill_name_mode: product.bill_name_mode || 'english',
    brand: product.brand || '',
    barcode: product.barcode || '',
    category: product.categories?.name || '',
    unit: product.unit || '',
    purchase_price: num(product.purchase_price),
    mrp: num(product.mrp),
    selling_price: num(product.selling_price),
    gst_rate: num(product.gst_rate),
    stock_qty: num(product.stock_qty),
    min_stock: num(product.min_stock),
    hsn_code: product.hsn_code || '',
    is_active: product.is_active === false ? 'false' : 'true',
  }))
}

function buildSupplierRows(suppliers, purchaseBills) {
  const totalsBySupplier = new Map()
  purchaseBills.forEach((bill) => {
    if (!bill.supplier_id) return
    const current = totalsBySupplier.get(bill.supplier_id) || { bills: 0, value: 0, due: 0 }
    current.bills += 1
    current.value += num(bill.total)
    current.due += num(dueAmount(bill))
    totalsBySupplier.set(bill.supplier_id, current)
  })

  return suppliers.map((supplier) => {
    const stats = totalsBySupplier.get(supplier.id) || { bills: 0, value: 0, due: 0 }
    return {
      Supplier: supplier.name || '',
      'Contact Person': supplier.contact_person || '',
      Phone: supplier.phone || '',
      Email: supplier.email || '',
      GSTIN: supplier.gstin || '',
      Address: supplier.address || '',
      City: supplier.city || '',
      State: supplier.state || '',
      Pincode: supplier.pincode || '',
      'Purchases (Period)': stats.bills,
      'Purchase Value (Period)': round2(stats.value),
      'Outstanding Due (Period)': round2(stats.due),
      Active: supplier.is_active === false ? 'No' : 'Yes',
    }
  })
}

function buildCustomerRows(customers, salesInvoices) {
  const totalsByCustomer = new Map()
  salesInvoices.forEach((bill) => {
    if (!bill.customer_id) return
    const current = totalsByCustomer.get(bill.customer_id) || { bills: 0, value: 0, due: 0 }
    current.bills += 1
    current.value += num(bill.total)
    current.due += num(dueAmount(bill))
    totalsByCustomer.set(bill.customer_id, current)
  })

  return customers.map((customer) => {
    const stats = totalsByCustomer.get(customer.id) || { bills: 0, value: 0, due: 0 }
    return {
      Customer: customer.name || '',
      Phone: customer.phone || '',
      GSTIN: customer.gstin || '',
      Address: customer.address || '',
      'Invoices (Period)': stats.bills,
      'Sales Value (Period)': round2(stats.value),
      'Outstanding Due (Period)': round2(stats.due),
      Notes: customer.notes || '',
      Active: customer.is_active === false ? 'No' : 'Yes',
    }
  })
}

function buildOutstandingRows(salesInvoices, purchaseBills) {
  const receivables = salesInvoices
    .filter((bill) => dueAmount(bill) > 0)
    .map((bill) => ({
      Type: 'Receivable',
      Date: formatReportDate(bill.date),
      'Bill No': bill.bill_no,
      Party: bill.customer_name || 'B2C Customer',
      Phone: bill.customer_phone || '',
      Total: round2(bill.total),
      Paid: round2(bill.paid_amount),
      Due: dueAmount(bill),
      Status: bill.payment_status || '',
    }))

  const payables = purchaseBills
    .filter((bill) => dueAmount(bill) > 0)
    .map((bill) => ({
      Type: 'Payable',
      Date: formatReportDate(bill.date),
      'Bill No': bill.bill_no,
      Party: bill.suppliers?.name || '',
      Phone: bill.suppliers?.phone || '',
      Total: round2(bill.total),
      Paid: round2(bill.paid_amount),
      Due: dueAmount(bill),
      Status: bill.payment_status || '',
    }))

  return [...receivables, ...payables]
}

// ── Pack assembly ───────────────────────────────────────────────────────────

const FALLBACK_HEADERS = {
  sales: ['Date', 'Invoice No', 'Customer', 'GSTIN', 'Type', 'GST Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total GST', 'Invoice Total', 'Payment Status'],
  purchases: ['Date', 'Purchase No', 'Supplier Invoice No', 'Supplier', 'Supplier GSTIN', 'Interstate', 'GST Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Input GST', 'Invoice Total', 'Payment Status'],
  stock: ['Product', 'Local Name', 'Brand', 'Category', 'Barcode', 'HSN', 'Unit', 'GST Rate', 'Quantity', 'Purchase Price', 'Selling Price', 'MRP', 'Stock Value (Cost)', 'Stock Value (Selling)', 'Min Stock', 'Below Min', 'Supplier', 'Active'],
  inventory: ['name', 'local_name', 'search_aliases', 'bill_name_mode', 'brand', 'barcode', 'category', 'unit', 'purchase_price', 'mrp', 'selling_price', 'gst_rate', 'stock_qty', 'min_stock', 'hsn_code', 'is_active'],
  suppliers: ['Supplier', 'Contact Person', 'Phone', 'Email', 'GSTIN', 'Address', 'City', 'State', 'Pincode', 'Purchases (Period)', 'Purchase Value (Period)', 'Outstanding Due (Period)', 'Active'],
  customers: ['Customer', 'Phone', 'GSTIN', 'Address', 'Invoices (Period)', 'Sales Value (Period)', 'Outstanding Due (Period)', 'Notes', 'Active'],
  outstanding: ['Type', 'Date', 'Bill No', 'Party', 'Phone', 'Total', 'Paid', 'Due', 'Status'],
  expenses: ['Date', 'Title', 'Category', 'Amount', 'Payment Mode', 'Notes'],
  otherBills: ['Date', 'Bill No', 'Type', 'Customer', 'Phone', 'Taxable Value', 'GST', 'Total', 'Paid', 'Due', 'Payment Status'],
  rateChanges: ['Date', 'Product', 'Local Name', 'Unit', 'HSN', 'Old Purchase Price', 'New Purchase Price', 'Old Selling Price', 'New Selling Price', 'Old MRP', 'New MRP', 'Selling Change', 'Direction', 'GST Rate', 'Source', 'Reason'],
}

/**
 * Turns a fetched dataset into the complete set of pack files plus the summary
 * figures the UI shows before download.
 */
export function buildExtractPack({ dataset, shop, periodLabel }) {
  const {
    dateFrom, dateTo, salesInvoices, otherBills, purchaseBills,
    salesItems, purchaseItems, expenses, products, suppliers, customers,
    stockAsOn, rateChanges,
  } = dataset

  const registers = buildGstRegisters({
    salesBills: salesInvoices,
    purchaseBills,
    salesItems,
    purchaseItems,
    expenses,
  })

  const stockRows = buildStockOnHand(products, stockAsOn?.quantities)
  const rateChangeRows = buildRateChangeRows(rateChanges)
  const inventoryRows = buildInventoryBackupRows(products)
  const supplierRows = buildSupplierRows(suppliers, purchaseBills)
  const customerRows = buildCustomerRows(customers, salesInvoices)
  const outstandingRows = buildOutstandingRows(salesInvoices, purchaseBills)
  const invoiceSummaryRows = buildInvoiceSummaryRows(salesInvoices)
  const purchaseSummaryRows = buildPurchaseSummaryRows(purchaseBills)
  const otherBillRows = buildOtherBillRows(otherBills)

  const stockValueCost = stockRows.reduce((sum, row) => sum + row['Stock Value (Cost)'], 0)
  const stockValueSelling = stockRows.reduce((sum, row) => sum + row['Stock Value (Selling)'], 0)
  const totalExpenses = expenses.reduce((sum, expense) => sum + num(expense.amount), 0)
  const receivable = outstandingRows.filter((r) => r.Type === 'Receivable').reduce((s, r) => s + r.Due, 0)
  const payable = outstandingRows.filter((r) => r.Type === 'Payable').reduce((s, r) => s + r.Due, 0)

  const summary = {
    periodLabel,
    dateFrom,
    dateTo,
    invoiceCount: salesInvoices.length,
    purchaseCount: purchaseBills.length,
    otherBillCount: otherBills.length,
    expenseCount: expenses.length,
    stockItemCount: stockRows.length,
    stockAsOn: stockAsOn || null,
    rateChangeCount: rateChangeRows.length,
    rateHistoryAvailable: rateChanges !== null && rateChanges !== undefined,
    productCount: products.length,
    supplierCount: suppliers.length,
    customerCount: customers.length,
    totalSales: registers.totals.totalSales,
    totalPurchases: registers.totals.totalPurchases,
    outputGst: registers.totals.outputGst,
    inputGst: registers.totals.inputGst,
    netPayable: registers.totals.netPayable,
    totalExpenses,
    stockValueCost,
    stockValueSelling,
    receivable,
    payable,
  }

  const files = [
    { name: '01-sales-register.csv', content: csvFor(registers.salesRegisterRows, FALLBACK_HEADERS.sales) },
    { name: '02-sales-b2b.csv', content: csvFor(registers.b2bRegisterRows, FALLBACK_HEADERS.sales) },
    { name: '03-sales-b2c.csv', content: csvFor(registers.b2cRegisterRows, FALLBACK_HEADERS.sales) },
    { name: '04-sales-b2c-rate-summary.csv', content: csvFor(registers.b2cSummaryRows, ['GST Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total GST', 'Sales Value']) },
    { name: '05-sales-line-items.csv', content: csvFor(registers.salesItemRows, ['Date', 'Invoice No', 'Customer', 'GSTIN', 'Product', 'HSN', 'Quantity', 'GST Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total GST', 'Line Total']) },
    { name: '06-invoice-summary.csv', content: csvFor(invoiceSummaryRows, FALLBACK_HEADERS.sales) },
    { name: '07-purchase-register.csv', content: csvFor(registers.purchaseRegisterRows, FALLBACK_HEADERS.purchases) },
    { name: '08-purchase-line-items.csv', content: csvFor(registers.purchaseItemRows, ['Date', 'Purchase No', 'Supplier Invoice No', 'Supplier', 'Supplier GSTIN', 'Product', 'HSN', 'Quantity', 'GST Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Input GST', 'Line Total']) },
    { name: '09-purchase-summary.csv', content: csvFor(purchaseSummaryRows, FALLBACK_HEADERS.purchases) },
    { name: '10-gst-tax-summary.csv', content: csvFor(registers.taxSummaryRows, ['GST Rate', 'Outward Taxable', 'Outward CGST', 'Outward SGST', 'Outward GST', 'Inward Taxable', 'Input GST', 'Net GST Payable']) },
    { name: '11-hsn-summary.csv', content: csvFor(registers.hsnSummaryRows, ['HSN', 'GST Rate', 'Quantity', 'Taxable Value', 'GST', 'Sales Value']) },
    { name: '12-expenses.csv', content: csvFor(registers.expenseRows, FALLBACK_HEADERS.expenses) },
    { name: '13-stock-on-hand.csv', content: csvFor(stockRows, FALLBACK_HEADERS.stock) },
    { name: '14-inventory-backup.csv', content: csvFor(inventoryRows, FALLBACK_HEADERS.inventory) },
    { name: '15-suppliers.csv', content: csvFor(supplierRows, FALLBACK_HEADERS.suppliers) },
    { name: '16-customers.csv', content: csvFor(customerRows, FALLBACK_HEADERS.customers) },
    { name: '17-outstanding-dues.csv', content: csvFor(outstandingRows, FALLBACK_HEADERS.outstanding) },
    { name: '18-quotations-estimates.csv', content: csvFor(otherBillRows, FALLBACK_HEADERS.otherBills) },
    { name: '19-rate-changes.csv', content: csvFor(rateChangeRows, FALLBACK_HEADERS.rateChanges) },
    { name: 'README.txt', content: buildReadme({ summary, shop }) },
  ]

  return { files, summary, registers, stockRows, supplierRows }
}

function inr(value) {
  return `Rs ${round2(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function stockNote(summary) {
  const stock = summary.stockAsOn
  if (!stock?.isHistorical) {
    return '  * Stock figures are the live quantities, which match the period end\r\n'
      + '    because no movements are dated after it.'
  }
  return `  * Stock is rewound to ${formatReportDate(summary.dateTo)}: ${stock.laterPurchaseUnits} units purchased\r\n`
    + `    and ${stock.laterSaleUnits} units sold across ${stock.laterBills} later bill(s) were reversed out,\r\n`
    + '    so these figures will differ from the live Inventory screen.'
}

function buildReadme({ summary, shop }) {
  return [
    `MONTHLY EXTRACT - ${summary.periodLabel}`,
    `${shop?.name || 'Shop'}${shop?.gstin ? ` (GSTIN ${shop.gstin})` : ''}`,
    `Period: ${formatReportDate(summary.dateFrom)} to ${formatReportDate(summary.dateTo)}`,
    `Generated: ${new Date().toLocaleString('en-IN')}`,
    '',
    'FIGURES',
    `  Sales turnover        ${inr(summary.totalSales)}  (${summary.invoiceCount} GST invoices)`,
    `  Purchase value        ${inr(summary.totalPurchases)}  (${summary.purchaseCount} purchase bills)`,
    `  Output GST            ${inr(summary.outputGst)}`,
    `  Input GST credit      ${inr(summary.inputGst)}`,
    `  Net GST payable       ${inr(summary.netPayable)}`,
    `  Expenses              ${inr(summary.totalExpenses)}  (${summary.expenseCount} entries)`,
    `  Receivable (unpaid)   ${inr(summary.receivable)}`,
    `  Payable (unpaid)      ${inr(summary.payable)}`,
    `  Closing stock (cost)  ${inr(summary.stockValueCost)}  (${summary.stockItemCount} products in stock)`,
    `  Closing stock (sell)  ${inr(summary.stockValueSelling)}`,
    summary.rateHistoryAvailable
      ? `  Rate revisions        ${summary.rateChangeCount} recorded in this period`
      : '  Rate revisions        not tracked (rate-history setup not applied)',
    '',
    'FILES',
    '  01-sales-register.csv          GST sales, one row per invoice per GST rate (GSTR-1 layout)',
    '  02-sales-b2b.csv               Sales to GSTIN-registered customers',
    '  03-sales-b2c.csv               Sales to customers without a GSTIN',
    '  04-sales-b2c-rate-summary.csv  B2C totals grouped by GST rate',
    '  05-sales-line-items.csv        Every sold line item',
    '  06-invoice-summary.csv         One row per invoice with payment status',
    '  07-purchase-register.csv       Purchases, one row per bill per GST rate',
    '  08-purchase-line-items.csv     Every purchased line item',
    '  09-purchase-summary.csv        One row per purchase bill with payment status',
    '  10-gst-tax-summary.csv         Output vs input GST by rate, net payable',
    '  11-hsn-summary.csv             HSN-wise summary for GSTR-1 table 12',
    '  12-expenses.csv                Business expenses in the period',
    '  13-stock-on-hand.csv           Stock above zero as at the period end, valued',
    '  14-inventory-backup.csv        Full product master, re-importable in Inventory > Upload CSV',
    '  15-suppliers.csv               Supplier master with period purchase totals',
    '  16-customers.csv               Customer master with period sales totals',
    '  17-outstanding-dues.csv        Unpaid invoices (receivable) and purchase bills (payable)',
    '  18-quotations-estimates.csv    Non-GST bills (quotations/estimates) in the period',
    '  19-rate-changes.csv            Rate revisions recorded during the period',
    '',
    'NOTES',
    '  * Sum "Taxable Value" or "Total GST" for period figures. "Invoice Total"',
    '    repeats on every rate row of the same invoice, so summing it overstates.',
    stockNote(summary),
    '  * Rates in the stock file are the current ones; only quantities are',
    '    rewound to the period end.',
    '  * CSVs are UTF-8 with a BOM so Excel shows the rupee sign and Tamil names.',
    '  * The consolidated invoice PDF is produced separately from the Extracts',
    '    page using "Open invoice PDF", then "Download PDF".',
  ].join('\r\n')
}
