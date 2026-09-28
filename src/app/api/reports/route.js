import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const REPORTS_TTL_MS = 45 * 1000
const reportsCache = new Map()

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !key.startsWith('eyJ')) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getClientForUser(userToken) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${userToken}` } },
  })
}

function decodeToken(request) {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return { ok: false, reason: 'Missing auth token' }

  try {
    const parts = token.split('.')
    if (parts.length < 2) return { ok: false, reason: 'Invalid auth token format' }
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const now = Math.floor(Date.now() / 1000)
    if (!payload?.exp || payload.exp <= now) return { ok: false, reason: 'Session expired' }
    if (!payload?.sub) return { ok: false, reason: 'Invalid user token' }
    return { ok: true, userId: payload.sub }
  } catch {
    return { ok: false, reason: 'Invalid auth token payload' }
  }
}

function getCacheKey(shopId, tab, dateFrom, dateTo) {
  return `${shopId}:${tab}:${dateFrom}:${dateTo}`
}

function readCached(key) {
  const entry = reportsCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    reportsCache.delete(key)
    return null
  }
  return entry.data
}

function writeCached(key, data) {
  reportsCache.set(key, {
    data,
    expiresAt: Date.now() + REPORTS_TTL_MS,
  })
}

async function loadSales(admin, shopId, dateFrom, dateTo) {
  const { data, error } = await admin
    .from('bills')
    .select('*')
    .eq('shop_id', shopId)
    .eq('bill_type', 'invoice')
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date')
  if (error) throw error
  return data || []
}

async function loadGst(admin, shopId, dateFrom, dateTo) {
  const [{ data: salesBills, error: salesBillsErr }, { data: purchaseBills, error: purchaseBillsErr }] = await Promise.all([
    admin
      .from('bills')
      .select('id')
      .eq('shop_id', shopId)
      .eq('bill_type', 'invoice')
      .gte('date', dateFrom)
      .lte('date', dateTo),
    admin
      .from('purchase_bills')
      .select('id')
      .eq('shop_id', shopId)
      .gte('date', dateFrom)
      .lte('date', dateTo),
  ])

  if (salesBillsErr) throw salesBillsErr
  if (purchaseBillsErr) throw purchaseBillsErr

  const salesBillIds = (salesBills || []).map((bill) => bill.id)
  const purchaseBillIds = (purchaseBills || []).map((bill) => bill.id)

  const [{ data: sales, error: salesErr }, { data: purchases, error: purchasesErr }] = await Promise.all([
    salesBillIds.length
      ? admin.from('bill_items').select('gst_rate,base_rate,quantity,gst_amount').in('bill_id', salesBillIds)
      : Promise.resolve({ data: [], error: null }),
    purchaseBillIds.length
      ? admin.from('purchase_bill_items').select('gst_rate,base_rate,quantity,gst_amount').in('purchase_bill_id', purchaseBillIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (salesErr) throw salesErr
  if (purchasesErr) throw purchasesErr

  return {
    sales: sales || [],
    purchases: purchases || [],
  }
}

async function loadAuditor(admin, shopId, dateFrom, dateTo) {
  const [
    { data: salesBills, error: salesBillsErr },
    { data: purchase_bills, error: purchaseBillsErr },
    { data: expenses, error: expensesErr },
  ]  = await Promise.all([
    admin
      .from('bills')
      .select('id,bill_no,date,customer_name,customer_gstin,subtotal,cgst_amount,sgst_amount,igst_amount,gst_amount,total,payment_status')
      .eq('shop_id', shopId)
      .eq('bill_type', 'invoice')
      .gte('date', dateFrom)
      .lte('date',dateTo)
      .order('date'),
    admin
      .from('expenses')
      .select('expense_date,title,category,amount,payment_mode,notes')
      .eq('shop_id',shopId)
      .gte('expense_date', dateFrom)
      .lte('expense_date', dateTo)
      .order('expense_date'),
  ])

  if (salesBillsErr) throw salesBillsErr
  if (purchaseBillsErr) throw purchaseBillsErr
  if (expensesErr) throw expensesErr

  const salesBillIds = (salesBills || []).map((bill) => bill.id)
  const purchaseBillIds = (purchaseBills || []).map((bill) => bill.id)

  const [{ data: salesItems, error: salesItemsErr}, { data: purchaseItems, error: purchaseItemsErr}] = await Promise.all([
    salesBillIds.length 
      ? admin.from('bill_items').select('bill_id, product_name, hsn_code,quantity,base_rate,gst_rate,gst_amount,total').in('bill_id', salesBillIds)
      : Promise.resolve({ data: [], error: null}),
    purchaseBillIds.length
      ? admin.from('purchase_bill_items').select('purchase_bill_id,product_name,hsn_code,quantity,base_rate,taxable_amount,gst_rate,gst_amount,cgst_amount,sgst_amount,igst_amount,total').in('purchase_bill_id', purchaseBillIds)
    : Promise.resolve({ data:[], error: null}),
  ])

  if(salesItemsErr) throw salesItemsErr
  if(purchaseItemsErr) throw purchaseItemsErr

  return {
    salesBills: salesBills || [],
    purchaseBills: purchaseBills || [],
    salesItems: salesItems || [],
    purchaseItems: purchaseItems || [],
    expenses: expenses || [],
  }
}

async function loadStockCheck(admin, shopId, dateFrom, dateTo) {
  const [{ data: purchaseBills, error: purchaseBillsErr }, { data: salesBills, error: salesBillsErr }] = await Promise.all([
    admin.from('purchase_bills').select('id').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo),
    admin.from('bills').select('id,bill_type').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo),
  ])
  if (purchaseBillsErr) throw purchaseBillsErr
  if (salesBillsErr) throw salesBillsErr

  const purchaseBillIds = (purchaseBills || []).map((bill) => bill.id)
  const invoiceBillIds = (salesBills || []).filter((bill) => bill.bill_type === 'invoice').map((bill) => bill.id)
  const otherBillIds = (salesBills || []).filter((bill) => bill.bill_type !== 'invoice').map((bill) => bill.id)

  const [
    { data: purchaseItems, error: purchaseItemsErr },
    { data: invoiceItems, error: invoiceItemsErr },
    { data: otherItems, error: otherItemsErr },
  ] = await Promise.all([
    purchaseBillIds.length
      ? admin.from('purchase_bill_items').select('product_id,quantity').in('purchase_bill_id', purchaseBillIds)
      : Promise.resolve({ data: [], error: null }),
    invoiceBillIds.length
      ? admin.from('bill_items').select('product_id,quantity').in('bill_id', invoiceBillIds)
      : Promise.resolve({ data: [], error: null }),
    otherBillIds.length
      ? admin.from('bill_items').select('product_id,quantity').in('bill_id', otherBillIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (purchaseItemsErr) throw purchaseItemsErr
  if (invoiceItemsErr) throw invoiceItemsErr
  if (otherItemsErr) throw otherItemsErr

  const productIds = [...new Set([
    ...(purchaseItems || []).map((item) => item.product_id),
    ...(invoiceItems || []).map((item) => item.product_id),
    ...(otherItems || []).map((item) => item.product_id),
  ].filter(Boolean))]

  const { data: products, error: productsErr } = productIds.length
    ? await admin.from('products').select('id,name,hsn_code,gst_rate,unit,stock_qty,selling_price').eq('shop_id', shopId).in('id', productIds)
    : { data: [], error: null }
  if (productsErr) throw productsErr

  return {
    purchaseItems: purchaseItems || [],
    invoiceItems: invoiceItems || [],
    otherItems: otherItems || [],
    products: products || [],
  }
}

async function loadPurchases(admin, shopId, dateFrom, dateTo) {
  const { data, error } = await admin
    .from('purchase_bills')
    .select('*, suppliers(name)')
    .eq('shop_id', shopId)
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date')

  if (error) throw error
  return data || []
}

async function loadCredits(admin, shopId, dateFrom, dateTo) {
  const [{ data: accounts, error: accountsErr }, { data: entries, error: entriesErr }] = await Promise.all([
    admin.from('credit_accounts').select('*').eq('shop_id', shopId).order('party_name'),
    admin.from('credit_entries').select('id,account_id,amount,direction,entry_date').eq('shop_id', shopId),
  ])

  if (accountsErr) throw accountsErr
  if (entriesErr) throw entriesErr

  const allEntries = entries || []
  return {
    accounts: accounts || [],
    allEntries,
    periodEntries: allEntries.filter((entry) => entry.entry_date >= dateFrom && entry.entry_date <= dateTo),
  }
}

async function loadTopProducts(admin, shopId, dateFrom, dateTo) {
  const { data: bills, error: billsErr } = await admin
    .from('bills')
    .select('id')
    .eq('shop_id', shopId)
    .eq('bill_type', 'invoice')
    .gte('date', dateFrom)
    .lte('date', dateTo)

  if (billsErr) throw billsErr

  const billIds = (bills || []).map((bill) => bill.id)
  const { data: items, error: itemsErr } = billIds.length
    ? await admin.from('bill_items').select('product_name,quantity,total').in('bill_id', billIds)
    : { data: [], error: null }

  if (itemsErr) throw itemsErr

  const aggregate = {}
  ;(items || []).forEach((item) => {
    if (!item.product_name) return
    if (!aggregate[item.product_name]) aggregate[item.product_name] = { qty: 0, amount: 0 }
    aggregate[item.product_name].qty += parseFloat(item.quantity) || 0
    aggregate[item.product_name].amount += parseFloat(item.total) || 0
  })

  return Object.entries(aggregate)
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 30)
}

export async function GET(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const userToken = authHeader.replace('Bearer ', '').trim()

    const auth = decodeToken(request)
    if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 })

    const admin = getAdminClient()
    const client = admin || getClientForUser(userToken)
    if (!client) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

    const { searchParams } = new URL(request.url)
    const shopId = searchParams.get('shopId') || ''
    const tab = searchParams.get('tab') || 'sales'
    const dateFrom = searchParams.get('dateFrom') || ''
    const dateTo = searchParams.get('dateTo') || ''
    const forceFresh = searchParams.get('force') === '1'

    if (!shopId || !dateFrom || !dateTo) {
      return NextResponse.json({ error: 'shopId, dateFrom and dateTo are required' }, { status: 400 })
    }

    const allowedTabs = new Set(['sales', 'gst', 'auditor', 'stockcheck', 'purchases', 'credits', 'topproducts'])
    if (!allowedTabs.has(tab)) {
      return NextResponse.json({ error: 'Invalid report tab' }, { status: 400 })
    }

    // Verify shop access only when using admin client (RLS handles it with user token)
    if (admin) {
      const { data: membership, error: membershipErr } = await admin
        .from('user_shops')
        .select('shop_id')
        .eq('user_id', auth.userId)
        .eq('shop_id', shopId)
        .limit(1)

      if (membershipErr) return NextResponse.json({ error: membershipErr.message }, { status: 500 })
      if (!membership?.length) return NextResponse.json({ error: 'Access denied for this shop' }, { status: 403 })
    }

    const cacheKey = getCacheKey(shopId, tab, dateFrom, dateTo)
    if (!forceFresh) {
      const cached = readCached(cacheKey)
      if (cached) return NextResponse.json({ data: cached, cached: true })
    }

    let data = []
    if (tab === 'sales') data = await loadSales(client, shopId, dateFrom, dateTo)
    else if (tab === 'gst') data = await loadGst(client, shopId, dateFrom, dateTo)
    else if (tab === 'auditor') data = await loadAuditor(client, shopId, dateFrom, dateTo)
    else if (tab === 'stockcheck') data = await loadStockCheck(client, shopId, dateFrom, dateTo)
    else if (tab === 'purchases') data = await loadPurchases(client, shopId, dateFrom, dateTo)
    else if (tab === 'credits') data = await loadCredits(client, shopId, dateFrom, dateTo)
    else if (tab === 'topproducts') data = await loadTopProducts(client, shopId, dateFrom, dateTo)

    writeCached(cacheKey, data)
    return NextResponse.json({ data, cached: false })
  } catch (error) {
    return NextResponse.json({ error: error?.message || 'Failed to load reports' }, { status: 500 })
  }
}
