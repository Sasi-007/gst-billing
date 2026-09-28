'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import Link from 'next/link'
import { useShop } from '@/context/ShopContext'

async function fetchDashboardDirect(shopId, today, monthStart) {
  const [
    todayBillsRes,
    monthBillsRes,
    stockRes,
    recentBillsRes,
    creditAccountsRes,
    creditEntriesRes,
  ] = await Promise.all([
    supabase.from('bills').select('total').eq('shop_id', shopId).gte('date', today).eq('bill_type', 'invoice'),
    supabase.from('bills').select('total').eq('shop_id', shopId).gte('date', monthStart).eq('bill_type', 'invoice'),
    supabase.from('products').select('id,name,stock_qty,min_stock,selling_price').eq('shop_id', shopId).eq('is_active', true).lte('stock_qty', 5).order('stock_qty').limit(10),
    supabase.from('bills').select('id,bill_no,date,customer_name,total,payment_status,payment_mode').eq('shop_id', shopId).eq('bill_type', 'invoice').order('created_at', { ascending: false }).limit(8),
    supabase.from('credit_accounts').select('id,relation_type,opening_balance').eq('shop_id', shopId),
    supabase.from('credit_entries').select('account_id,amount,direction').eq('shop_id', shopId),
  ])

  const todaySales = (todayBillsRes.data || []).reduce((s, b) => s + (b.total || 0), 0)
  const monthSales = (monthBillsRes.data || []).reduce((s, b) => s + (b.total || 0), 0)

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
      todayBills: (todayBillsRes.data || []).length,
      monthBills: (monthBillsRes.data || []).length,
      creditAccounts: (creditAccountsRes.data || []).length,
      receivable: creditStats.receivable,
      payable: creditStats.payable,
    },
    lowStock: stockRes.data || [],
    recentBills: recentBillsRes.data || [],
  }
}

export default function DashboardPage() {
  const { shop, loading: shopLoading } = useShop()
  const cacheKey = shop?.id ? `dashboard:${shop.id}` : ''
  const [liveTick, setLiveTick] = useState(0)
  const loadedTick = useRef(0)
  const initialCache = readPageCache(cacheKey)
  const [stats,      setStats]      = useState({
    todaySales: initialCache?.stats?.todaySales || 0,
    monthSales: initialCache?.stats?.monthSales || 0,
    todayBills: initialCache?.stats?.todayBills || 0,
    monthBills: initialCache?.stats?.monthBills || 0,
    creditAccounts: initialCache?.stats?.creditAccounts || 0,
    receivable: initialCache?.stats?.receivable || 0,
    payable: initialCache?.stats?.payable || 0,
  })
  const [lowStock,   setLowStock]   = useState(() => initialCache?.lowStock || [])
  const [recentBills,setRecentBills]= useState(() => initialCache?.recentBills || [])
  const [loading,    setLoading]    = useState(() => !initialCache)
  const [error,      setError]      = useState('')
  usePageLoadingState('dashboard-page', loading)

  useEffect(() => {
    if (!shop?.id) return   // wait until shop is loaded
    async function load() {
      const cached = readPageCache(cacheKey)
      const shouldForceFresh = liveTick !== loadedTick.current
      setError('')
      if (cached && !shouldForceFresh) {
        setStats(cached.stats)
        setLowStock(cached.lowStock || [])
        setRecentBills(cached.recentBills || [])
        setLoading(false)
      } else {
        setLoading(true)
      }

      try {
        const nextData = await fetchDashboardDirect(shop.id, todayStr(), monthStartStr())
        setStats(nextData.stats || {})
        const nextLowStock = nextData.lowStock || []
        const nextRecentBills = nextData.recentBills || []
        setLowStock(nextLowStock)
        setRecentBills(nextRecentBills)
        writePageCache(cacheKey, {
          stats: nextData.stats || {},
          lowStock: nextLowStock,
          recentBills: nextRecentBills,
        })
        loadedTick.current = liveTick
      } catch (fetchErr) {
        const fallback = readPageCache(cacheKey)
        if (fallback) {
          setStats(fallback.stats || {})
          setLowStock(fallback.lowStock || [])
          setRecentBills(fallback.recentBills || [])
          setError('Offline mode: showing cached dashboard data')
        } else {
          setStats({
            todaySales: 0,
            monthSales: 0,
            todayBills: 0,
            monthBills: 0,
            creditAccounts: 0,
            receivable: 0,
            payable: 0,
          })
          setLowStock([])
          setRecentBills([])
          setError(fetchErr?.message || 'Failed to load dashboard')
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [cacheKey, liveTick, shop?.id])

  useEffect(() => {
    if (!shop?.id) return
    const channel = supabase.channel(`dashboard-live:${shop.id}`)
    ;['bills', 'bill_items', 'products', 'credit_accounts', 'credit_entries'].forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `shop_id=eq.${shop.id}` }, () => {
        setLiveTick((tick) => tick + 1)
      })
    })
    channel.subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [shop?.id])

  if (shopLoading || loading) return (
    <div className="p-4">
      <LoadingPlaceholder label="Loading dashboard" rows={4} fullPage />
    </div>
  )

  return (
    <div className="p-4">
      {error && (
        <div className="mb-3 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
          {error}
        </div>
      )}
      {/* Greeting */}
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">{shop?.name || 'Dashboard'}</h1>
        <p className="text-sm text-gray-500">
          {new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
        {[
          { label:"Today's Sales",    value: fmt(stats.todaySales),  sub:`${stats.todayBills} bills`,  cls:'text-blue-700',   bg:'bg-blue-50'   },
          { label:"Month Sales",      value: fmt(stats.monthSales),  sub:`${stats.monthBills} bills`,  cls:'text-green-700',  bg:'bg-green-50'  },
          { label:'To Collect',       value: fmt(stats.receivable),  sub:`${stats.creditAccounts} accounts`, cls:'text-cyan-700', bg:'bg-cyan-50' },
          { label:'To Pay',           value: fmt(stats.payable),     sub:'credit book',                cls:'text-purple-700', bg:'bg-purple-50' },
          { label:"Low Stock Items",  value: lowStock.length,         sub:'need attention',             cls:'text-orange-700', bg:'bg-orange-50' },
          { label:"Out of Stock",     value: lowStock.filter(p=>p.stock_qty<=0).length, sub:'items', cls:'text-red-700', bg:'bg-red-50' },
        ].map(c => (
          <div key={c.label} className={`${c.bg} rounded-xl p-4 border`}>
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-2xl font-bold mt-1 ${c.cls}`}>{c.value}</div>
            <div className="text-xs text-gray-400 mt-0.5">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Quick actions */}
        <div className="bg-white rounded-xl border p-4">
          <h2 className="font-semibold text-sm mb-3 text-gray-700">Quick Actions</h2>
          <div className="grid grid-cols-2 gap-2">
            {[
              { href:'/billing',     icon:'🧾', label:'New Bill',        cls:'bg-blue-600 text-white' },
              { href:'/purchases/new',icon:'🛒',label:'New Purchase',    cls:'bg-purple-600 text-white' },
              { href:'/inventory/new',icon:'📦',label:'Add Product',     cls:'bg-green-600 text-white' },
              { href:'/credits',     icon:'📒', label:'Credit Book',     cls:'bg-cyan-600 text-white' },
              { href:'/suppliers',   icon:'🏪', label:'Suppliers',       cls:'bg-gray-700 text-white' },
              { href:'/reports',     icon:'📈', label:'Reports',         cls:'bg-orange-600 text-white' },
              { href:'/inventory',   icon:'📋', label:'View Inventory',  cls:'bg-teal-600 text-white' },
            ].map(a => (
              <Link key={a.href} href={a.href}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-opacity hover:opacity-90 ${a.cls}`}>
                <span>{a.icon}</span>
                <span>{a.label}</span>
              </Link>
            ))}
          </div>
        </div>

        {/* Low stock */}
        <div className="bg-white rounded-xl border p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm text-gray-700">⚡ Low / Out of Stock</h2>
            <Link href="/inventory?filter=low" className="text-xs text-blue-600 hover:underline">View all</Link>
          </div>
          {lowStock.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">All items are well stocked ✓</p>
          ) : (
            <div className="space-y-1.5">
              {lowStock.map(p => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <span className="truncate text-gray-800">{p.name}</span>
                  <span className={`ml-2 font-semibold flex-shrink-0 ${p.stock_qty <= 0 ? 'text-red-600' : 'text-yellow-600'}`}>
                    {p.stock_qty <= 0 ? '⚠ Out' : `${p.stock_qty} left`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent bills */}
      <div className="bg-white rounded-xl border mt-4">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold text-sm text-gray-700">Recent Bills</h2>
          <Link href="/reports" className="text-xs text-blue-600 hover:underline">All reports</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b bg-gray-50">
              {['Bill No','Date','Customer','Amount','Mode','Status'].map(h => (
                <th key={h} className="px-4 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentBills.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-4 text-center text-gray-400">No bills yet</td></tr>
            ) : recentBills.map(b => (
              <tr key={b.id} className="border-b hover:bg-gray-50">
                <td className="px-4 py-2 font-mono font-medium">
                  <Link href={`/billing/${b.id}`} className="text-blue-700 hover:underline">
                    {b.bill_no}
                  </Link>
                </td>
                <td className="px-4 py-2">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                <td className="px-4 py-2 text-gray-600">{b.customer_name || 'Walk-in'}</td>
                <td className="px-4 py-2 font-medium">{fmt(b.total)}</td>
                <td className="px-4 py-2 capitalize text-gray-500 text-xs">{b.payment_mode}</td>
                <td className="px-4 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    b.payment_status === 'paid'    ? 'bg-green-100 text-green-700'
                    : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-red-100 text-red-700'
                  }`}>{b.payment_status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
