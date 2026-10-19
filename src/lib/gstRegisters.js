/**
 * Pure builders for the GST register row sets (sales, purchase, item-wise,
 * tax and HSN summaries).
 *
 * These feed both the on-screen GST Auditor report and the monthly extract
 * pack, so the figures an auditor sees in the app always match the figures in
 * the exported files.
 */

export function num(value) {
  return Number(value) || 0
}

export function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100
}

export function taxableValue(item) {
  return round2(num(item.taxable_amount) || num(item.base_rate) * num(item.quantity))
}

export function cgstValue(item) {
  return round2(num(item.cgst_amount) || (num(item.igst_amount) ? 0 : num(item.gst_amount) / 2))
}

export function sgstValue(item) {
  return round2(num(item.sgst_amount) || (num(item.igst_amount) ? 0 : num(item.gst_amount) / 2))
}

export function igstValue(item) {
  return round2(num(item.igst_amount))
}

export function formatReportDate(date) {
  return date ? new Date(date + 'T00:00:00').toLocaleDateString('en-IN') : ''
}

// GST returns are filed rate-wise, so a bill carrying more than one GST rate
// needs one register row per rate. Line items are totalled per rate here.
function buildRateSlabsByBill(itemList, billIdKey) {
  const map = {}
  itemList.forEach((item) => {
    const billId = item[billIdKey]
    if (!billId) return
    const rate = num(item.gst_rate)
    if (!map[billId]) map[billId] = {}
    if (!map[billId][rate]) map[billId][rate] = { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0 }
    const slab = map[billId][rate]
    slab.taxable += taxableValue(item)
    slab.cgst += cgstValue(item)
    slab.sgst += sgstValue(item)
    slab.igst += igstValue(item)
    slab.gst += num(item.gst_amount)
  })
  return map
}

function sortedSlabs(slabsByRate) {
  return Object.values(slabsByRate || {}).sort((a, b) => a.rate - b.rate)
}

/**
 * Builds every GST register row set for a period.
 *
 * @param {object} input
 * @param {Array} input.salesBills    GST sales invoices in the period
 * @param {Array} input.purchaseBills purchase bills in the period (with `suppliers`)
 * @param {Array} input.salesItems    bill_items for those sales invoices
 * @param {Array} input.purchaseItems purchase_bill_items for those purchases
 * @param {Array} input.expenses      expenses in the period
 */
export function buildGstRegisters({
  salesBills = [],
  purchaseBills = [],
  salesItems = [],
  purchaseItems = [],
  expenses = [],
} = {}) {
  const taxMap = {}
  const hsnMap = {}

  salesItems.forEach((item) => {
    const rate = String(item.gst_rate || 0)
    if (!taxMap[rate]) taxMap[rate] = { rate, outwardTaxable: 0, outwardGst: 0, inwardTaxable: 0, inwardGst: 0 }
    taxMap[rate].outwardTaxable += taxableValue(item)
    taxMap[rate].outwardGst += num(item.gst_amount)

    const hsn = item.hsn_code || 'Unclassified'
    const key = `${hsn}:${rate}`
    if (!hsnMap[key]) hsnMap[key] = { hsn, rate, quantity: 0, taxable: 0, gst: 0, total: 0 }
    hsnMap[key].quantity += num(item.quantity)
    hsnMap[key].taxable += taxableValue(item)
    hsnMap[key].gst += num(item.gst_amount)
    hsnMap[key].total += num(item.total)
  })

  purchaseItems.forEach((item) => {
    const rate = String(item.gst_rate || 0)
    if (!taxMap[rate]) taxMap[rate] = { rate, outwardTaxable: 0, outwardGst: 0, inwardTaxable: 0, inwardGst: 0 }
    taxMap[rate].inwardTaxable += taxableValue(item)
    taxMap[rate].inwardGst += num(item.gst_amount)
  })

  const taxRows = Object.values(taxMap).sort((a, b) => num(a.rate) - num(b.rate))
  const hsnRows = Object.values(hsnMap).sort(
    (a, b) => String(a.hsn).localeCompare(String(b.hsn)) || num(a.rate) - num(b.rate)
  )

  const totalSales = salesBills.reduce((sum, bill) => sum + num(bill.total), 0)
  const totalPurchases = purchaseBills.reduce((sum, bill) => sum + num(bill.total), 0)
  const outputGst = salesItems.reduce((sum, item) => sum + num(item.gst_amount), 0)
  const inputGst = purchaseItems.reduce((sum, item) => sum + num(item.gst_amount), 0)

  const b2bSalesBills = salesBills.filter((bill) => !!String(bill.customer_gstin || '').trim())
  const b2cSalesBills = salesBills.filter((bill) => !String(bill.customer_gstin || '').trim())
  const salesBillById = Object.fromEntries(salesBills.map((bill) => [bill.id, bill]))
  const purchaseBillById = Object.fromEntries(purchaseBills.map((bill) => [bill.id, bill]))
  const b2cBillIdSet = new Set(b2cSalesBills.map((bill) => bill.id))

  const salesSlabsByBill = buildRateSlabsByBill(salesItems, 'bill_id')

  // One row per GST rate on the bill. Invoice-level columns (total, status)
  // repeat on each row, matching GSTR-1 layout — sum "Taxable Value" or
  // "Total GST" for period figures, not "Invoice Total".
  const salesRegisterRows = salesBills.flatMap((bill) => {
    const base = {
      Date: formatReportDate(bill.date),
      'Invoice No': bill.bill_no,
      Customer: bill.customer_name || 'B2C Customer',
      GSTIN: bill.customer_gstin || '',
      Type: bill.customer_gstin ? 'B2B' : 'B2C',
    }
    const tail = {
      'Invoice Total': round2(num(bill.total)),
      'Payment Status': bill.payment_status || '',
    }
    const slabs = sortedSlabs(salesSlabsByBill[bill.id])

    // Bills with no stored line items still have to appear, using bill totals.
    if (slabs.length === 0) {
      return [{
        ...base,
        'GST Rate': '',
        'Taxable Value': round2(num(bill.subtotal)),
        CGST: round2(num(bill.cgst_amount) || (num(bill.igst_amount) ? 0 : num(bill.gst_amount) / 2)),
        SGST: round2(num(bill.sgst_amount) || (num(bill.igst_amount) ? 0 : num(bill.gst_amount) / 2)),
        IGST: round2(num(bill.igst_amount)),
        'Total GST': round2(num(bill.gst_amount)),
        ...tail,
      }]
    }

    return slabs.map((slab) => ({
      ...base,
      'GST Rate': `${slab.rate}%`,
      'Taxable Value': round2(slab.taxable),
      CGST: round2(slab.cgst),
      SGST: round2(slab.sgst),
      IGST: round2(slab.igst),
      'Total GST': round2(slab.gst),
      ...tail,
    }))
  })

  const b2bRegisterRows = salesRegisterRows.filter((row) => row.Type === 'B2B')
  const b2cRegisterRows = salesRegisterRows.filter((row) => row.Type === 'B2C')

  const purchaseSlabsByBill = buildRateSlabsByBill(purchaseItems, 'purchase_bill_id')

  // Interstate purchases attract IGST instead of CGST+SGST. The bill's
  // `is_interstate` flag is authoritative, so the slab's GST is split here
  // rather than relying on the line item's stored tax columns.
  const purchaseRegisterRows = purchaseBills.flatMap((bill) => {
    const interstate = Boolean(bill.is_interstate)
    const base = {
      Date: formatReportDate(bill.date),
      'Purchase No': bill.bill_no,
      'Supplier Invoice No': bill.supplier_invoice_no || '',
      Supplier: bill.suppliers?.name || '',
      'Supplier GSTIN': bill.suppliers?.gstin || '',
      Interstate: interstate ? 'Yes' : 'No',
    }
    const tail = {
      'Invoice Total': round2(num(bill.total)),
      'Payment Status': bill.payment_status || '',
    }
    const taxRow = (gst) => ({
      CGST: interstate ? 0 : round2(gst / 2),
      SGST: interstate ? 0 : round2(gst / 2),
      IGST: interstate ? round2(gst) : 0,
      'Input GST': round2(gst),
    })
    const slabs = sortedSlabs(purchaseSlabsByBill[bill.id])

    if (slabs.length === 0) {
      return [{
        ...base,
        'GST Rate': '',
        'Taxable Value': round2(num(bill.subtotal)),
        ...taxRow(num(bill.gst_amount)),
        ...tail,
      }]
    }

    return slabs.map((slab) => ({
      ...base,
      'GST Rate': `${slab.rate}%`,
      'Taxable Value': round2(slab.taxable),
      ...taxRow(slab.gst),
      ...tail,
    }))
  })

  const salesItemRows = salesItems.map((item) => {
    const bill = salesBillById[item.bill_id] || {}
    return {
      Date: formatReportDate(bill.date),
      'Invoice No': bill.bill_no || '',
      Customer: bill.customer_name || 'B2C Customer',
      GSTIN: bill.customer_gstin || '',
      Product: item.product_name || '',
      HSN: item.hsn_code || '',
      Quantity: round2(num(item.quantity)),
      'GST Rate': `${item.gst_rate || 0}%`,
      'Taxable Value': taxableValue(item),
      CGST: round2(num(item.gst_amount) / 2),
      SGST: round2(num(item.gst_amount) / 2),
      IGST: 0,
      'Total GST': round2(num(item.gst_amount)),
      'Line Total': round2(num(item.total)),
    }
  })

  const b2cSummaryMap = {}
  salesItems.forEach((item) => {
    if (!b2cBillIdSet.has(item.bill_id)) return
    const rate = String(item.gst_rate || 0)
    if (!b2cSummaryMap[rate]) b2cSummaryMap[rate] = { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, total: 0 }
    b2cSummaryMap[rate].taxable += taxableValue(item)
    b2cSummaryMap[rate].cgst += round2(num(item.gst_amount) / 2)
    b2cSummaryMap[rate].sgst += round2(num(item.gst_amount) / 2)
    b2cSummaryMap[rate].gst += num(item.gst_amount)
    b2cSummaryMap[rate].total += num(item.total)
  })

  const b2cSummaryRows = Object.values(b2cSummaryMap)
    .sort((a, b) => num(a.rate) - num(b.rate))
    .map((row) => ({
      'GST Rate': `${row.rate}%`,
      'Taxable Value': round2(row.taxable),
      CGST: round2(row.cgst),
      SGST: round2(row.sgst),
      IGST: round2(row.igst),
      'Total GST': round2(row.gst),
      'Sales Value': round2(row.total),
    }))

  const purchaseItemRows = purchaseItems.map((item) => {
    const bill = purchaseBillById[item.purchase_bill_id] || {}
    return {
      Date: formatReportDate(bill.date),
      'Purchase No': bill.bill_no || '',
      'Supplier Invoice No': bill.supplier_invoice_no || '',
      Supplier: bill.suppliers?.name || '',
      'Supplier GSTIN': bill.suppliers?.gstin || '',
      Product: item.product_name || '',
      HSN: item.hsn_code || '',
      Quantity: round2(num(item.quantity)),
      'GST Rate': `${item.gst_rate || 0}%`,
      'Taxable Value': taxableValue(item),
      CGST: cgstValue(item),
      SGST: sgstValue(item),
      IGST: igstValue(item),
      'Input GST': round2(num(item.gst_amount)),
      'Line Total': round2(num(item.total)),
    }
  })

  const taxSummaryRows = taxRows.map((row) => ({
    'GST Rate': `${row.rate}%`,
    'Outward Taxable': round2(row.outwardTaxable),
    'Outward CGST': round2(row.outwardGst / 2),
    'Outward SGST': round2(row.outwardGst / 2),
    'Outward GST': round2(row.outwardGst),
    'Inward Taxable': round2(row.inwardTaxable),
    'Input GST': round2(row.inwardGst),
    'Net GST Payable': round2(row.outwardGst - row.inwardGst),
  }))

  const hsnSummaryRows = hsnRows.map((row) => ({
    HSN: row.hsn,
    'GST Rate': `${row.rate}%`,
    Quantity: round2(row.quantity),
    'Taxable Value': round2(row.taxable),
    GST: round2(row.gst),
    'Sales Value': round2(row.total),
  }))

  const expenseRows = expenses.map((expense) => ({
    Date: formatReportDate(expense.expense_date),
    Title: expense.title,
    Category: expense.category || '',
    Amount: round2(expense.amount),
    'Payment Mode': expense.payment_mode || '',
    Notes: expense.notes || '',
  }))

  return {
    taxRows,
    hsnRows,
    salesRegisterRows,
    b2bRegisterRows,
    b2cRegisterRows,
    b2cSummaryRows,
    purchaseRegisterRows,
    salesItemRows,
    purchaseItemRows,
    taxSummaryRows,
    hsnSummaryRows,
    expenseRows,
    b2bSalesBills,
    b2cSalesBills,
    totals: {
      totalSales,
      totalPurchases,
      outputGst,
      inputGst,
      netPayable: outputGst - inputGst,
    },
  }
}
