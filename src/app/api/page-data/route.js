import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 45 * 1000
const pageCache = new Map()

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // Service role key must be a JWT (starts with eyJ) — new sb_secret_ format keys don't work here
  if (!url || !key || !key.startsWith('eyJ')) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// Falls back to anon key with user JWT when service role key is not a valid JWT
function getClientForUser(userToken) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  // Pass the JWT via global headers — Supabase reads Authorization: Bearer <jwt> for RLS
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

function cacheKeyFrom(scope, shopId, extra = '') {
  return `${scope}:${shopId}:${extra}`
}

function readCached(key) {
  const entry = pageCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    pageCache.delete(key)
    return null
  }
  return entry.data
}

function writeCached(key, data) {
  pageCache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

async function verifyShopAccess(admin, userId, shopId) {
  const { data, error } = await admin
    .from('user_shops')
    .select('shop_id')
    .eq('user_id', userId)
    .eq('shop_id', shopId)
    .limit(1)

  if (error) throw error
  return Boolean(data?.length)
}

async function loadDashboard(admin, shopId, today, monthStart) {
  const results = await Promise.allSettled([
    admin.from('bills').select('total').eq('shop_id', shopId).gte('date', today).eq('bill_type', 'invoice'),
    admin.from('bills').select('total').eq('shop_id', shopId).gte('date', monthStart).eq('bill_type', 'invoice'),
    admin
      .from('products')
      .select('id,name,stock_qty,min_stock,selling_price')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .lte('stock_qty', 5)
      .order('stock_qty')
      .limit(10),
    admin
      .from('bills')
      .select('id,bill_no,date,customer_name,total,payment_status,payment_mode')
      .eq('shop_id', shopId)
      .eq('bill_type', 'invoice')
      .order('created_at', { ascending: false })
      .limit(8),
    admin.from('credit_accounts').select('id,relation_type,opening_balance').eq('shop_id', shopId),
    admin.from('credit_entries').select('account_id,amount,direction').eq('shop_id', shopId),
  ])

  const toResult = (result) => (result.status === 'fulfilled' ? result.value : { data: [], error: result.reason })
  const todayBills = toResult(results[0])
  const monthBills = toResult(results[1])
  const stockRes = toResult(results[2])
  const recentBillsRes = toResult(results[3])
  const creditAccountsRes = toResult(results[4])
  const creditEntriesRes = toResult(results[5])

  const todaySales = (todayBills.data || []).reduce((s, b) => s + (b.total || 0), 0)
  const monthSales = (monthBills.data || []).reduce((s, b) => s + (b.total || 0), 0)
  const creditEntriesByAccount = (creditEntriesRes.data || []).reduce((map, entry) => {
    if (!map[entry.account_id]) map[entry.account_id] = []
    map[entry.account_id].push(entry)
    return map
  }, {})
  const creditStats = (creditAccountsRes.data || []).reduce((summary, account) => {
    const balance = (creditEntriesByAccount[account.id] || []).reduce((sum, entry) => {
      const amount = Number(entry.amount || 0)
      return entry.direction === 'increase' ? sum + amount : sum - amount
    }, Number(account.opening_balance || 0))
    if (account.relation_type === 'lender') {
      summary.payable += Math.max(0, balance)
    } else {
      summary.receivable += Math.max(0, balance)
    }
    return summary
  }, { receivable: 0, payable: 0 })

  return {
    stats: {
      todaySales,
      monthSales,
      todayBills: (todayBills.data || []).length,
      monthBills: (monthBills.data || []).length,
      creditAccounts: (creditAccountsRes.data || []).length,
      receivable: creditStats.receivable,
      payable: creditStats.payable,
    },
    lowStock: stockRes.data || [],
    recentBills: recentBillsRes.data || [],
    warnings: results
      .map((result, index) => {
        if (result.status === 'fulfilled' && !result.value?.error) return null
        const labels = ['todayBills', 'monthBills', 'stock', 'recentBills', 'creditAccounts', 'creditEntries']
        const error = result.status === 'rejected' ? result.reason : result.value?.error
        return `${labels[index]}: ${error?.message || error}`
      })
      .filter(Boolean),
  }
}

async function loadSummary(admin, shopId, dateFrom, dateTo) {
  const results = await Promise.allSettled([
    admin
      .from('bills')
      .select('id,date,total,subtotal,discount_amount,gst_amount,paid_amount,payment_status')
      .eq('shop_id', shopId)
      .eq('bill_type', 'invoice')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: false }),
    admin
      .from('purchase_bills')
      .select('id,date,total,gst_amount,paid_amount,payment_status')
      .eq('shop_id', shopId)
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: false }),
    admin
      .from('expenses')
      .select('id,expense_date,title,category,amount,payment_mode')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .gte('expense_date', dateFrom)
      .lte('expense_date', dateTo)
      .order('expense_date', { ascending: false }),
    admin
      .from('investments')
      .select('id,investment_date,source_name,amount,payment_mode')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .gte('investment_date', dateFrom)
      .lte('investment_date', dateTo)
      .order('investment_date', { ascending: false }),
    admin
      .from('owner_drawings')
      .select('id,drawing_date,title,amount,payment_mode,bank_account_id')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .gte('drawing_date', dateFrom)
      .lte('drawing_date', dateTo)
      .order('drawing_date', { ascending: false }),
    admin
      .from('products')
      .select('id,name,stock_qty,purchase_price,mrp,selling_price,min_stock,is_active')
      .eq('shop_id', shopId)
      .eq('is_active', true),
    admin
      .from('bank_accounts')
      .select('*')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .order('account_name'),
    admin
      .from('bank_transactions')
      .select('*')
      .eq('shop_id', shopId)
      .eq('is_active', true),
    admin
      .from('credit_accounts')
      .select('*')
      .eq('shop_id', shopId)
      .eq('is_active', true),
    admin
      .from('credit_entries')
      .select('*')
      .eq('shop_id', shopId),
  ])

  const bills = results[0].status === 'fulfilled' ? results[0].value.data || [] : []
  const purchases = results[1].status === 'fulfilled' ? results[1].value.data || [] : []
  const expenses = results[2].status === 'fulfilled' ? results[2].value.data || [] : []
  const investments = results[3].status === 'fulfilled' ? results[3].value.data || [] : []
  const drawings = results[4].status === 'fulfilled' ? results[4].value.data || [] : []
  const products = results[5].status === 'fulfilled' ? results[5].value.data || [] : []
  const bankAccounts = results[6].status === 'fulfilled' ? results[6].value.data || [] : []
  const bankTransactions = results[7].status === 'fulfilled' ? results[7].value.data || [] : []
  const creditAccounts = results[8].status === 'fulfilled' ? results[8].value.data || [] : []
  const creditEntries = results[9].status === 'fulfilled' ? results[9].value.data || [] : []

  const billIds = (bills || []).map((bill) => bill.id)
  let billItems = []
  if (billIds.length > 0) {
    const { data: itemRows, error: itemErr } = await admin
      .from('bill_items')
      .select('bill_id,quantity,total,cost_price')
      .eq('shop_id', shopId)
      .in('bill_id', billIds)
    if (itemErr) throw itemErr
    billItems = itemRows || []
  }

  return {
    bills: bills || [],
    billItems,
    purchases: purchases || [],
    expenses: expenses || [],
    investments: investments || [],
    drawings: drawings || [],
    products: products || [],
    bankAccounts: bankAccounts || [],
    bankTransactions: bankTransactions || [],
    creditAccounts: creditAccounts || [],
    creditEntries: creditEntries || [],
    warnings: results
      .map((result, index) => {
        const labels = ['bills', 'purchases', 'expenses', 'investments', 'drawings', 'products', 'bankAccounts', 'bankTransactions', 'creditAccounts', 'creditEntries']
        if (result.status === 'fulfilled' && !result.value?.error) return null
        const error = result.status === 'rejected' ? result.reason : result.value?.error
        return `${labels[index]}: ${error?.message || error}`
      })
      .filter(Boolean),
  }
}

async function loadPurchases(admin, shopId, dateFrom, dateTo, search) {
  let q = admin
    .from('purchase_bills')
    .select('*, suppliers(name)')
    .eq('shop_id', shopId)
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200)

  if (search) q = q.ilike('bill_no', `%${search}%`)
  const { data, error } = await q
  if (error) throw error
  return { bills: data || [] }
}

export async function GET(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const userToken = authHeader.replace('Bearer ', '').trim()

    const auth = decodeToken(request)
    if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 })

    // Try admin client first; fall back to user-scoped client (RLS handles access)
    let client = getAdminClient()
    let useRls = false
    if (!client) {
      client = getClientForUser(userToken)
      useRls = true
    }
    if (!client) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

    const { searchParams } = new URL(request.url)
    const scope = searchParams.get('scope') || ''
    const shopId = searchParams.get('shopId') || ''
    const forceFresh = searchParams.get('force') === '1'
    const dateFrom = searchParams.get('dateFrom') || ''
    const dateTo = searchParams.get('dateTo') || ''
    const search = (searchParams.get('search') || '').trim()

    if (!scope || !shopId) {
      return NextResponse.json({ error: 'scope and shopId are required' }, { status: 400 })
    }

    const allowedScopes = new Set(['dashboard', 'summary', 'purchases'])
    if (!allowedScopes.has(scope)) {
      return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })
    }

    // Only verify shop access explicitly when using admin client (RLS handles it otherwise)
    if (!useRls) {
      const ok = await verifyShopAccess(client, auth.userId, shopId)
      if (!ok) return NextResponse.json({ error: 'Access denied for this shop' }, { status: 403 })
    }

    const cacheExtra =
      scope === 'dashboard'
        ? `${searchParams.get('today') || ''}:${searchParams.get('monthStart') || ''}`
        : `${dateFrom}:${dateTo}:${search}`
    const cacheKey = cacheKeyFrom(scope, shopId, cacheExtra)
    if (!forceFresh) {
      const cached = readCached(cacheKey)
      if (cached) return NextResponse.json({ data: cached, cached: true })
    }

    let data
    if (scope === 'dashboard') {
      const today = searchParams.get('today') || ''
      const monthStart = searchParams.get('monthStart') || ''
      if (!today || !monthStart) return NextResponse.json({ error: 'today and monthStart are required' }, { status: 400 })
      data = await loadDashboard(client, shopId, today, monthStart)
    } else if (scope === 'summary') {
      if (!dateFrom || !dateTo) return NextResponse.json({ error: 'dateFrom and dateTo are required' }, { status: 400 })
      data = await loadSummary(client, shopId, dateFrom, dateTo)
    } else if (scope === 'purchases') {
      if (!dateFrom || !dateTo) return NextResponse.json({ error: 'dateFrom and dateTo are required' }, { status: 400 })
      data = await loadPurchases(client, shopId, dateFrom, dateTo, search)
    }

    writeCached(cacheKey, data)
    return NextResponse.json({ data, cached: false })
  } catch (error) {
    console.error('[page-data] 500 error:', error)
    return NextResponse.json({ error: error?.message || 'Failed to load page data', stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined }, { status: 500 })
  }
}
