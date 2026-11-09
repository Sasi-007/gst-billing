// Sales-side analysis helpers shared by the invoice history filters, the GST
// Recon report and the Profit by Slab report.
//
// Everything here is pure: callers fetch the rows and pass them in, which keeps
// the same maths usable from the billing page (already-loaded bills) and from
// the reports page (period fetch) without duplicating logic.

import { round2 } from './gst'

export const GST_SLABS = [0, 3, 5, 12, 18, 28]

export function num(value) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// bill_items store a GST-inclusive line total, so the taxable value is the
// total minus the GST that was actually charged on it.
export function itemTaxableValue(item) {
  return round2(num(item?.total) - num(item?.gst_amount))
}

// Gross profit on a line: what was received minus the purchase-cost snapshot
// taken at billing time. Matches calculateGrossProfitFromItems() in finance.js.
export function itemProfit(item) {
  return num(item?.total) - num(item?.cost_price) * num(item?.quantity)
}

export function itemCost(item) {
  return num(item?.cost_price) * num(item?.quantity)
}

export function slabKey(rate) {
  return String(round2(num(rate)))
}

export function slabLabel(rate) {
  return `${slabKey(rate)}%`
}

export function groupItemsByBillId(items = []) {
  const map = new Map()
  for (const item of items) {
    if (!item?.bill_id) continue
    if (!map.has(item.bill_id)) map.set(item.bill_id, [])
    map.get(item.bill_id).push(item)
  }
  return map
}

// ── Invoice history advanced filters ────────────────────────────────────────

export function emptyAdvancedFilters() {
  return {
    gstRates: [],          // slab values the bill is tested against
    gstMode: 'any',        // 'any' | 'all' | 'none'
    itemSearch: '',        // product name / HSN contains
    minTotal: '',
    maxTotal: '',
    minProfit: '',
    maxProfit: '',
    lossOnly: false,
    mixedRatesOnly: false, // bills carrying more than one GST slab
    paymentMode: '',
    paymentStatus: '',
    hasDueOnly: false,
  }
}

export function isAdvancedFilterActive(filters) {
  const base = emptyAdvancedFilters()
  if (!filters) return false
  return Object.keys(base).some((key) => {
    const value = filters[key]
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'boolean') return value
    if (key === 'gstMode') return false
    return String(value ?? '').trim() !== ''
  })
}

// Item-level filters need the bill's line items; the bill-level ones do not.
export function advancedFiltersNeedItems(filters) {
  if (!filters) return false
  return (
    filters.gstRates?.length > 0 ||
    String(filters.itemSearch || '').trim() !== '' ||
    filters.mixedRatesOnly === true ||
    String(filters.minProfit ?? '').trim() !== '' ||
    String(filters.maxProfit ?? '').trim() !== '' ||
    filters.lossOnly === true
  )
}

function itemMatchesText(item, term) {
  if (!term) return true
  const haystack = `${item?.product_name || ''} ${item?.hsn_code || ''}`.toLowerCase()
  return haystack.includes(term)
}

// Returns { matched, matchedItems } so the UI can expand a bill row and show
// exactly the lines that caused it to match (the row-wise 0% view).
export function evaluateBillAgainstFilters(bill, items = [], filters = emptyAdvancedFilters()) {
  const noMatch = { matched: false, matchedItems: [] }
  const lines = Array.isArray(items) ? items : []

  const minTotal = parseFloat(filters.minTotal)
  if (Number.isFinite(minTotal) && num(bill?.total) < minTotal) return noMatch
  const maxTotal = parseFloat(filters.maxTotal)
  if (Number.isFinite(maxTotal) && num(bill?.total) > maxTotal) return noMatch

  const mode = String(filters.paymentMode || '').toLowerCase()
  if (mode && String(bill?.payment_mode || '').toLowerCase() !== mode) return noMatch

  const status = String(filters.paymentStatus || '').toLowerCase()
  if (status && String(bill?.payment_status || '').toLowerCase() !== status) return noMatch

  if (filters.hasDueOnly && num(bill?.total) - num(bill?.paid_amount) <= 0) return noMatch

  const term = String(filters.itemSearch || '').trim().toLowerCase()
  const selectedRates = (filters.gstRates || []).map(slabKey)

  if (selectedRates.length || term) {
    if (!lines.length) return noMatch
  }

  if (filters.mixedRatesOnly) {
    const distinct = new Set(lines.map((line) => slabKey(line.gst_rate)))
    if (distinct.size < 2) return noMatch
  }

  let matchedItems = lines
  if (selectedRates.length) {
    const rateMatches = lines.filter((line) => selectedRates.includes(slabKey(line.gst_rate)))
    const gstMode = filters.gstMode || 'any'
    if (gstMode === 'any' && rateMatches.length === 0) return noMatch
    if (gstMode === 'all' && (rateMatches.length === 0 || rateMatches.length !== lines.length)) return noMatch
    if (gstMode === 'none' && rateMatches.length > 0) return noMatch
    matchedItems = gstMode === 'none' ? lines : rateMatches
  }

  if (term) {
    const textMatches = matchedItems.filter((line) => itemMatchesText(line, term))
    if (!textMatches.length) return noMatch
    matchedItems = textMatches
  }

  const profit = lines.reduce((sum, line) => sum + itemProfit(line), 0)
  const hasCostData = lines.some((line) => num(line.cost_price) > 0)

  if (filters.lossOnly) {
    if (!hasCostData || profit >= 0) return noMatch
  }
  const minProfit = parseFloat(filters.minProfit)
  if (Number.isFinite(minProfit)) {
    if (!hasCostData || profit < minProfit) return noMatch
  }
  const maxProfit = parseFloat(filters.maxProfit)
  if (Number.isFinite(maxProfit)) {
    if (!hasCostData || profit > maxProfit) return noMatch
  }

  return { matched: true, matchedItems }
}

// ── Profit by GST slab ──────────────────────────────────────────────────────

function emptyProfitBucket() {
  return { revenue: 0, taxable: 0, gst: 0, cost: 0, profit: 0, quantity: 0, lineCount: 0 }
}

function addItemToBucket(bucket, item) {
  bucket.revenue += num(item.total)
  bucket.taxable += itemTaxableValue(item)
  bucket.gst += num(item.gst_amount)
  bucket.cost += itemCost(item)
  bucket.profit += itemProfit(item)
  bucket.quantity += num(item.quantity)
  bucket.lineCount += 1
  return bucket
}

function finalizeBucket(bucket) {
  return {
    ...bucket,
    revenue: round2(bucket.revenue),
    taxable: round2(bucket.taxable),
    gst: round2(bucket.gst),
    cost: round2(bucket.cost),
    profit: round2(bucket.profit),
    quantity: round2(bucket.quantity),
    marginPct: bucket.cost > 0 ? round2((bucket.profit / bucket.cost) * 100) : null,
  }
}

// Builds one row per invoice holding the combined figures plus a per-slab
// split, so a bill carrying 5% and 18% lines reports three categories:
// the bill total, its 5% share and its 18% share.
export function buildProfitBySlab({ bills = [], items = [] }) {
  const itemsByBill = groupItemsByBillId(items)
  const slabTotals = new Map()
  const billRows = []

  for (const bill of bills) {
    const lines = itemsByBill.get(bill.id) || []
    if (!lines.length) continue

    const overall = emptyProfitBucket()
    const perSlab = new Map()

    for (const line of lines) {
      addItemToBucket(overall, line)
      const key = slabKey(line.gst_rate)
      if (!perSlab.has(key)) perSlab.set(key, emptyProfitBucket())
      addItemToBucket(perSlab.get(key), line)
      if (!slabTotals.has(key)) slabTotals.set(key, emptyProfitBucket())
      addItemToBucket(slabTotals.get(key), line)
    }

    const slabs = [...perSlab.entries()]
      .map(([key, bucket]) => ({ slab: key, label: `${key}%`, ...finalizeBucket(bucket) }))
      .sort((a, b) => parseFloat(a.slab) - parseFloat(b.slab))

    billRows.push({
      id: bill.id,
      bill_no: bill.bill_no,
      date: bill.date,
      customer_name: bill.customer_name,
      payment_mode: bill.payment_mode,
      payment_status: bill.payment_status,
      billTotal: num(bill.total),
      hasCostData: lines.some((line) => num(line.cost_price) > 0),
      ...finalizeBucket(overall),
      slabs,
      slabByKey: Object.fromEntries(slabs.map((entry) => [entry.slab, entry])),
    })
  }

  const slabSummaries = [...slabTotals.entries()]
    .map(([key, bucket]) => ({
      slab: key,
      label: `${key}%`,
      billCount: billRows.filter((row) => row.slabByKey[key]).length,
      ...finalizeBucket(bucket),
    }))
    .sort((a, b) => parseFloat(a.slab) - parseFloat(b.slab))

  return { billRows, slabSummaries }
}

// ── GST reconciliation ──────────────────────────────────────────────────────

const SOURCE_WEIGHTS = { purchase: 3, history: 2, sales: 1 }

function mostFrequentRate(entries) {
  // entries: [{ rate, weight, at }] — highest weight wins, newest breaks ties.
  const tally = new Map()
  for (const entry of entries) {
    const key = slabKey(entry.rate)
    if (!tally.has(key)) tally.set(key, { key, weight: 0, at: '' })
    const bucket = tally.get(key)
    bucket.weight += entry.weight ?? 1
    if (String(entry.at || '') > bucket.at) bucket.at = String(entry.at || '')
  }
  const ranked = [...tally.values()].sort((a, b) => (b.weight - a.weight) || String(b.at).localeCompare(String(a.at)))
  return ranked.length ? { rate: parseFloat(ranked[0].key), weight: ranked[0].weight, at: ranked[0].at, spread: ranked.length } : null
}

// Works out the GST rate a product *should* be carrying from three independent
// trails: what the supplier charged, what the product carried historically and
// what it was mostly billed at. The supplier trail wins because that is the
// rate the shop actually paid input tax at.
export function resolveExpectedGstRates({
  products = [],
  purchaseItems = [],
  priceHistory = [],
  salesItems = [],
  purchaseDateById = new Map(),
}) {
  const purchaseByProduct = new Map()
  for (const row of purchaseItems) {
    if (!row?.product_id) continue
    const at = String(purchaseDateById.get(row.purchase_bill_id) || row.created_at || '')
    const current = purchaseByProduct.get(row.product_id)
    if (!current || at >= current.at) {
      purchaseByProduct.set(row.product_id, { rate: round2(num(row.gst_rate)), at })
    }
  }

  const historyByProduct = new Map()
  for (const row of priceHistory) {
    if (!row?.product_id) continue
    if (!historyByProduct.has(row.product_id)) historyByProduct.set(row.product_id, [])
    historyByProduct.get(row.product_id).push({
      rate: round2(num(row.gst_rate)),
      weight: 1,
      at: String(row.effective_date || row.created_at || ''),
    })
  }

  const salesByProduct = new Map()
  for (const row of salesItems) {
    if (!row?.product_id) continue
    if (!salesByProduct.has(row.product_id)) salesByProduct.set(row.product_id, [])
    salesByProduct.get(row.product_id).push({
      rate: round2(num(row.gst_rate)),
      weight: 1,
      at: String(row.created_at || ''),
    })
  }

  const expectedByProduct = new Map()

  for (const product of products) {
    const masterRate = round2(num(product.gst_rate))
    const purchase = purchaseByProduct.get(product.id) || null
    const history = mostFrequentRate(historyByProduct.get(product.id) || [])
    const sales = mostFrequentRate(salesByProduct.get(product.id) || [])

    const candidates = []
    if (purchase) {
      candidates.push({
        source: 'purchase',
        weight: SOURCE_WEIGHTS.purchase,
        rate: purchase.rate,
        detail: purchase.at ? `Supplier bill dated ${purchase.at.slice(0, 10)}` : 'Supplier purchase bill',
      })
    }
    if (history) {
      candidates.push({
        source: 'history',
        weight: SOURCE_WEIGHTS.history,
        rate: history.rate,
        detail: history.at ? `Rate history (${history.at.slice(0, 10)})` : 'Rate history',
      })
    }
    if (sales) {
      candidates.push({
        source: 'sales',
        weight: SOURCE_WEIGHTS.sales,
        rate: sales.rate,
        detail: `Billed at this rate on ${sales.weight} past line${sales.weight === 1 ? '' : 's'}`,
      })
    }

    if (!candidates.length) continue

    const best = candidates.reduce((top, entry) => (entry.weight > top.weight ? entry : top), candidates[0])
    const agreeing = candidates.filter((entry) => slabKey(entry.rate) === slabKey(best.rate))
    const conflicting = candidates.filter((entry) => slabKey(entry.rate) !== slabKey(best.rate))

    let confidence = 'low'
    if (best.source === 'purchase' && agreeing.length > 1) confidence = 'high'
    else if (best.source === 'purchase' || agreeing.length > 1) confidence = 'medium'

    expectedByProduct.set(product.id, {
      productId: product.id,
      productName: product.name,
      hsnCode: product.hsn_code || '',
      masterRate,
      expectedRate: round2(best.rate),
      primarySource: best.source,
      candidates,
      agreeing,
      conflicting,
      confidence,
      masterMismatch: slabKey(masterRate) !== slabKey(best.rate),
    })
  }

  return expectedByProduct
}

// What the shop must hand over to the department on a line that was billed at
// the wrong rate. The customer already paid the inclusive total, so the
// shortfall is tax-on-total at the expected rate minus the tax actually shown.
export function taxShortfallForItem(item, expectedRate) {
  const total = num(item?.total)
  const charged = num(item?.gst_amount)
  const expected = round2(num(expectedRate))
  const taxAtExpected = round2((total * expected) / (100 + expected))
  return round2(taxAtExpected - charged)
}

// Flags invoice lines whose GST rate disagrees with the expected rate, groups
// them by product so one typo shows up as a single actionable row, and totals
// the money at risk.
export function buildGstRecon({ bills = [], items = [], expectedByProduct = new Map(), minConfidence = 'low' }) {
  const confidenceRank = { low: 0, medium: 1, high: 2 }
  const floor = confidenceRank[minConfidence] ?? 0
  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  const productRows = new Map()
  const lineRows = []

  for (const item of items) {
    const expected = item?.product_id ? expectedByProduct.get(item.product_id) : null
    if (!expected) continue
    if ((confidenceRank[expected.confidence] ?? 0) < floor) continue

    const chargedRate = round2(num(item.gst_rate))
    if (slabKey(chargedRate) === slabKey(expected.expectedRate)) continue

    const bill = billById.get(item.bill_id)
    if (!bill) continue

    const shortfall = taxShortfallForItem(item, expected.expectedRate)
    const row = {
      billId: bill.id,
      billNo: bill.bill_no,
      billDate: bill.date,
      customerName: bill.customer_name || '',
      itemId: item.id,
      productId: item.product_id,
      productName: item.product_name,
      hsnCode: item.hsn_code || '',
      quantity: num(item.quantity),
      lineTotal: num(item.total),
      chargedRate,
      expectedRate: expected.expectedRate,
      chargedGst: num(item.gst_amount),
      shortfall,
      confidence: expected.confidence,
      primarySource: expected.primarySource,
    }
    lineRows.push(row)

    const key = `${item.product_id}|${slabKey(chargedRate)}`
    if (!productRows.has(key)) {
      productRows.set(key, {
        key,
        productId: item.product_id,
        productName: item.product_name,
        hsnCode: item.hsn_code || '',
        chargedRate,
        expectedRate: expected.expectedRate,
        masterRate: expected.masterRate,
        masterMismatch: expected.masterMismatch,
        confidence: expected.confidence,
        primarySource: expected.primarySource,
        candidates: expected.candidates,
        billIds: new Set(),
        quantity: 0,
        revenue: 0,
        shortfall: 0,
        lines: [],
      })
    }
    const bucket = productRows.get(key)
    bucket.billIds.add(bill.id)
    bucket.quantity += num(item.quantity)
    bucket.revenue += num(item.total)
    bucket.shortfall += shortfall
    bucket.lines.push(row)
  }

  const products = [...productRows.values()]
    .map((bucket) => ({
      ...bucket,
      billCount: bucket.billIds.size,
      billIds: [...bucket.billIds],
      quantity: round2(bucket.quantity),
      revenue: round2(bucket.revenue),
      shortfall: round2(bucket.shortfall),
    }))
    .sort((a, b) => Math.abs(b.shortfall) - Math.abs(a.shortfall))

  const totals = products.reduce((acc, row) => {
    acc.shortfall += row.shortfall
    acc.revenue += row.revenue
    acc.lineCount += row.lines.length
    return acc
  }, { shortfall: 0, revenue: 0, lineCount: 0 })

  return {
    products,
    lines: lineRows.sort((a, b) => Math.abs(b.shortfall) - Math.abs(a.shortfall)),
    totals: {
      shortfall: round2(totals.shortfall),
      revenue: round2(totals.revenue),
      lineCount: totals.lineCount,
      productCount: products.length,
      billCount: new Set(lineRows.map((row) => row.billId)).size,
    },
  }
}

// Products whose master GST rate disagrees with the evidence, regardless of
// whether they were billed in the selected period. This is the "it was re-added
// at 0%" catch, before the wrong rate reaches another customer.
export function buildMasterRateWarnings(expectedByProduct, products = []) {
  const stockById = new Map(products.map((product) => [product.id, product]))
  return [...expectedByProduct.values()]
    .filter((entry) => entry.masterMismatch && entry.confidence !== 'low')
    .map((entry) => ({
      ...entry,
      stockQty: num(stockById.get(entry.productId)?.stock_qty),
      sellingPrice: num(stockById.get(entry.productId)?.selling_price),
    }))
    .sort((a, b) => Math.abs(b.expectedRate - b.masterRate) - Math.abs(a.expectedRate - a.masterRate))
}

// ── Correction maths ────────────────────────────────────────────────────────

// Re-splits an already-issued line at the correct GST rate. The inclusive total
// is deliberately untouched — the customer paid that amount, only the tax split
// inside it was wrong.
export function recomputeBillItemTax(item, expectedRate) {
  const expected = round2(num(expectedRate))
  const total = num(item.total)
  const quantity = num(item.quantity)
  const base = round2(total / (1 + expected / 100))
  const gstAmount = round2(total - base)
  return {
    gst_rate: expected,
    gst_amount: gstAmount,
    base_rate: quantity > 0 ? round2(base / quantity) : round2(base),
  }
}

// Rebuilds bill-level tax columns from its (already corrected) line items.
// Interstate bills keep using IGST; everything else splits CGST/SGST evenly.
export function recomputeBillTotals(items = [], { isInterstate = false } = {}) {
  let subtotal = 0
  let gstAmount = 0
  let discountAmount = 0
  for (const item of items) {
    subtotal += itemTaxableValue(item)
    gstAmount += num(item.gst_amount)
    discountAmount += num(item.discount_amount)
  }
  const gst = round2(gstAmount)
  return {
    subtotal: round2(subtotal),
    gst_amount: gst,
    cgst_amount: isInterstate ? 0 : round2(gst / 2),
    sgst_amount: isInterstate ? 0 : round2(gst - round2(gst / 2)),
    igst_amount: isInterstate ? gst : 0,
    discount_amount: round2(discountAmount),
  }
}
