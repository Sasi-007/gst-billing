'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { fmt } from '../lib/gst'
import Link from 'next/link'

function todayStr() { return new Date().toISOString().slice(0, 10) }
function monthStart() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10) }

export default function DashboardPage() {
  const [stats,      setStats]      = useState({ todaySales:0, monthSales:0, todayBills:0, monthBills:0 })
  const [lowStock,   setLowStock]   = useState([])
  const [recentBills,setRecentBills]= useState([])
  const [settings,   setSettings]   = useState(null)
  const [loading,    setLoading]    = useState(true)

  useEffect(() => {
    async function load() {
      const today = todayStr()
      const mStart = monthStart()

      const [settRes, todayRes, monthRes, stockRes, billsRes] = await Promise.all([
        supabase.from('settings').select('*').single(),
        supabase.from('bills').select('total').gte('date', today).eq('bill_type','invoice'),
        supabase.from('bills').select('total').gte('date', mStart).eq('bill_type','invoice'),
        supabase.from('products')
          .select('id,name,stock_qty,min_stock,selling_price')
          .eq('is_active', true)
          .lte('stock_qty', 5)
          .order('stock_qty')
          .limit(10),
        supabase.from('bills')
          .select('bill_no,date,customer_name,total,payment_status,payment_mode')
          .eq('bill_type', 'invoice')
          .order('created_at', { ascending: false })
          .limit(8),
      ])

      setSettings(settRes.data)

      const todaySales = (todayRes.data || []).reduce((s, b) => s + (b.total || 0), 0)
      const monthSales = (monthRes.data || []).reduce((s, b) => s + (b.total || 0), 0)
      setStats({
        todaySales, monthSales,
        todayBills: (todayRes.data || []).length,
        monthBills: (monthRes.data || []).length,
      })
      setLowStock(stockRes.data || [])
      setRecentBills(billsRes.data || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-full text-gray-400">Loading…</div>
  )

  return (
    <div className="p-4">
      {/* Greeting */}
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">{settings?.shop_name || 'Dashboard'}</h1>
        <p className="text-sm text-gray-500">
          {new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {[
          { label:"Today's Sales",    value: fmt(stats.todaySales),  sub:`${stats.todayBills} bills`,  cls:'text-blue-700',   bg:'bg-blue-50'   },
          { label:"Month Sales",      value: fmt(stats.monthSales),  sub:`${stats.monthBills} bills`,  cls:'text-green-700',  bg:'bg-green-50'  },
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
        <table className="w-full text-sm">
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
              <tr key={b.bill_no} className="border-b hover:bg-gray-50">
                <td className="px-4 py-2 font-mono font-medium text-blue-700">{b.bill_no}</td>
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
  )
}
