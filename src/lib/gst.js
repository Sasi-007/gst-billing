// GST rates applicable for grocery / general retail in India
export const GST_RATES = [0, 3, 5, 12, 18, 28]

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// Base price extracted from a GST-inclusive MRP
export function basePrice(price, gstRate) {
  if (!gstRate) return round2(price)
  return round2(price / (1 + gstRate / 100))
}

// Calculate all amounts for one line item (GST inclusive rate)
export function calcItem(rate, qty, gstRate, discPct = 0) {
  const gross         = round2((rate || 0) * (qty || 0))
  const discountAmt   = round2(gross * (discPct || 0) / 100)
  const netAmount     = round2(gross - discountAmt)
  const baseAmt       = round2(netAmount / (1 + (gstRate || 0) / 100))
  const gstAmt        = round2(netAmount - baseAmt)

  return {
    gross_amount:    gross,
    discount_amount: discountAmt,
    base_amount:     baseAmt,
    gst_amount:      gstAmt,
    total:           netAmount,
  }
}

// Aggregate bill totals and per-rate GST breakdown
export function calcBillTotals(items) {
  let subtotal       = 0
  let gstAmount      = 0
  let discountAmount = 0
  let total          = 0
  const gstBreakdown = {}   // { '5': { base, gst }, '12': {...} }

  for (const item of items) {
    subtotal       += item.base_amount    || 0
    gstAmount      += item.gst_amount     || 0
    discountAmount += item.discount_amount|| 0
    total          += item.total          || 0

    const r = String(item.gst_rate || 0)
    if (!gstBreakdown[r]) gstBreakdown[r] = { base: 0, gst: 0 }
    gstBreakdown[r].base += item.base_amount || 0
    gstBreakdown[r].gst  += item.gst_amount  || 0
  }

  return {
    subtotal:       round2(subtotal),
    gstAmount:      round2(gstAmount),
    discountAmount: round2(discountAmount),
    total:          round2(total),
    gstBreakdown,
  }
}

// Indian-locale currency string  ₹1,23,456.78
export function fmt(amount) {
  if (amount === null || amount === undefined) return '₹0.00'
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Amount in words (for print)
export function numToWords(num) {
  const ones = [
    '', 'One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen',
    'Seventeen','Eighteen','Nineteen',
  ]
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety']

  function convert(n) {
    if (n === 0) return ''
    if (n < 20)  return ones[n]
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '')
    if (n < 1000)return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + convert(n % 100) : '')
    if (n < 100000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '')
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + convert(n % 100000) : '')
    return convert(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + convert(n % 10000000) : '')
  }

  const n     = Math.floor(Math.abs(num || 0))
  const paise = Math.round((Math.abs(num || 0) - n) * 100)
  let words   = (convert(n) || 'Zero') + ' Rupees'
  if (paise > 0) words += ' and ' + convert(paise) + ' Paise'
  return words + ' Only'
}
