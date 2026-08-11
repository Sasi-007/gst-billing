'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import Link from 'next/link'

export default function PurchasesPage() {
  const [bills,    setBills]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10))
  const [search,   setSearch]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase
      .from('purchase_bills')
      .select('*, suppliers(name)')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)

    if (search) q = q.ilike('bill_no', `%${search}%`)

    const { data } = await q
    setBills(data || [])
    setLoading(false)
  }, [dateFrom, dateTo, search])

  useEffect(() => { load() }, [load])

  const totalAmt = bills.reduce((s, b) => s + (b.total || 0), 0)
  const unpaidAmt = bills.filter(b => b.payment_status !== 'paid').reduce((s, b) => s + ((b.total || 0) - (b.paid_amount || 0)), 0)

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Purchases</h1>
          <div className="text-xs text-gray-500 mt-0.5">
            Total: {fmt(totalAmt)}
            {unpaidAmt > 0 && <span className="text-red-600 ml-2">· Unpaid: {fmt(unpaidAmt)}</span>}
          </div>
        </div>
        <Link href="/purchases/new"
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
          + New Purchase
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search bill no…"
          className="border rounded-lg px-3 py-2 text-sm w-48" />
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
        <span className="self-center text-gray-400 text-sm">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-10">Loading…</div>
      ) : bills.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No purchases in this period</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                {['Bill No','Date','Supplier','Sup. Invoice','Subtotal','GST','Total','Paid','Status',''].map(h => (
                  <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bills.map(b => (
                <tr key={b.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium text-blue-700">{b.bill_no}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                  <td className="px-3 py-2">{b.suppliers?.name || '—'}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{b.supplier_invoice_no || '—'}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.subtotal)}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.gst_amount)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmt(b.total)}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.paid_amount)}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      b.payment_status === 'paid'    ? 'bg-green-100 text-green-700'
                      : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                      : 'bg-red-100 text-red-700'
                    }`}>
                      {b.payment_status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/purchases/${b.id}`}
                      className="text-blue-600 hover:underline text-xs">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 text-xs text-gray-400">{bills.length} purchases</div>
        </div>
      )}
    </div>
  )
}
