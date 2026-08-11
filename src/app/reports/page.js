'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { fmt } from '../../lib/gst'

function todayStr() { return new Date().toISOString().slice(0, 10) }
function monthStart() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10) }

export default function ReportsPage() {
  const [tab,      setTab]      = useState('sales')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(todayStr())
  const [data,     setData]     = useState([])
  const [loading,  setLoading]  = useState(false)

  useEffect(() => {
    let cancelled = false

    async function run() {
      setLoading(true)

      try {
        let result = []

        if (tab === 'sales') {
          const { data: bills } = await supabase
            .from('bills')
            .select('*, bill_items(gst_rate,base_amount,gst_amount,total)')
            .gte('date', dateFrom)
            .lte('date', dateTo)
            .eq('bill_type', 'invoice')
            .order('date')

          result = bills || []
        }

        else if (tab === 'gst') {
          const [{ data: sales }, { data: purch }] = await Promise.all([
            supabase
              .from('bill_items')
              .select('gst_rate,base_amount,gst_amount')
              .gte('created_at', dateFrom + 'T00:00:00')
              .lte('created_at', dateTo + 'T23:59:59'),

            supabase
              .from('purchase_bill_items')
              .select('gst_rate,base_amount:base_rate,gst_amount')
              .gte('created_at', dateFrom + 'T00:00:00')
              .lte('created_at', dateTo + 'T23:59:59'),
          ])

          result = {
            sales: sales || [],
            purchases: purch || [],
          }
        }

        else if (tab === 'purchases') {
          const { data: purch } = await supabase
            .from('purchase_bills')
            .select('*, suppliers(name)')
            .gte('date', dateFrom)
            .lte('date', dateTo)
            .order('date')

          result = purch || []
        }

        else if (tab === 'topproducts') {
          const { data: items } = await supabase
            .from('bill_items')
            .select('product_name,quantity,total')
            .gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')

          const agg = {}

          ;(items || []).forEach(i => {
            if (!agg[i.product_name]) {
              agg[i.product_name] = { qty: 0, amount: 0 }
            }

            agg[i.product_name].qty += parseFloat(i.quantity) || 0
            agg[i.product_name].amount += parseFloat(i.total) || 0
          })

          result = Object.entries(agg)
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 30)
        }

        if (!cancelled) {
          setData(result)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [tab, dateFrom, dateTo])

  async function load() {
    setLoading(true)
    if (tab === 'sales') {
      const { data: bills } = await supabase
        .from('bills')
        .select('*, bill_items(gst_rate,base_amount,gst_amount,total)')
        .gte('date', dateFrom).lte('date', dateTo)
        .eq('bill_type', 'invoice')
        .order('date')

      setData(bills || [])
    } else if (tab === 'gst') {
      // GST summary across both bills and purchases
      const [{ data: sales }, { data: purch }] = await Promise.all([
        supabase.from('bill_items')
          .select('gst_rate,base_amount,gst_amount')
          .gte('created_at', dateFrom + 'T00:00:00')
          .lte('created_at', dateTo + 'T23:59:59'),
        supabase.from('purchase_bill_items')
          .select('gst_rate,base_amount:base_rate,gst_amount')
          .gte('created_at', dateFrom + 'T00:00:00')
          .lte('created_at', dateTo + 'T23:59:59'),
      ])
      setData({ sales: sales || [], purchases: purch || [] })
    } else if (tab === 'purchases') {
      const { data: purch } = await supabase
        .from('purchase_bills')
        .select('*, suppliers(name)')
        .gte('date', dateFrom).lte('date', dateTo)
        .order('date')
      setData(purch || [])
    } else if (tab === 'topproducts') {
      const { data: items } = await supabase
        .from('bill_items')
        .select('product_name,quantity,total')
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
      // aggregate client-side
      const agg = {}
      ;(items || []).forEach(i => {
        if (!agg[i.product_name]) agg[i.product_name] = { qty: 0, amount: 0 }
        agg[i.product_name].qty    += parseFloat(i.quantity) || 0
        agg[i.product_name].amount += parseFloat(i.total)    || 0
      })
      setData(
        Object.entries(agg)
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 30)
      )
    }
    setLoading(false)
  }

  // ── Sales summary ──────────────────────────────────────────────────────────
  function SalesSummary() {
    const bills = data || []
    const total     = bills.reduce((s, b) => s + (b.total || 0), 0)
    const gst       = bills.reduce((s, b) => s + (b.gst_amount || 0), 0)
    const subtotal  = bills.reduce((s, b) => s + (b.subtotal || 0), 0)
    const discount  = bills.reduce((s, b) => s + (b.discount_amount || 0), 0)

    return (
      <>
        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label:'Total Sales', value: fmt(total),    cls:'text-blue-700' },
            { label:'Taxable Amt', value: fmt(subtotal), cls:'text-gray-700' },
            { label:'Total GST',   value: fmt(gst),      cls:'text-orange-700' },
            { label:'Discounts',   value: fmt(discount), cls:'text-red-700' },
          ].map(c => (
            <div key={c.label} className="bg-white border rounded-lg p-3">
              <div className="text-xs text-gray-500">{c.label}</div>
              <div className={`text-xl font-bold mt-1 ${c.cls}`}>{c.value}</div>
              <div className="text-xs text-gray-400">{bills.length} bills</div>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['Date','Bill No','Customer','Subtotal','GST','Total','Mode','Status'].map(h => (
                  <th key={h} className="px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bills.map(b => (
                <tr key={b.id} className="border-b hover:bg-gray-50 text-sm">
                  <td className="px-3 py-1.5">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                  <td className="px-3 py-1.5 font-mono font-medium">{b.bill_no}</td>
                  <td className="px-3 py-1.5 text-gray-600">{b.customer_name || '—'}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(b.subtotal)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(b.gst_amount)}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{fmt(b.total)}</td>
                  <td className="px-3 py-1.5 capitalize text-gray-500">{b.payment_mode}</td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      b.payment_status === 'paid' ? 'bg-green-100 text-green-700'
                      : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                      : 'bg-red-100 text-red-700'
                    }`}>{b.payment_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    )
  }

  // ── GST summary ────────────────────────────────────────────────────────────
  function GSTSummary() {
    if (!data?.sales) return null
    const gstMap = {}

    data.sales.forEach(i => {
      const r = String(i.gst_rate || 0)
      if (!gstMap[r]) gstMap[r] = { outward_base:0, outward_gst:0, inward_base:0, inward_gst:0 }
      gstMap[r].outward_base += parseFloat(i.base_amount) || 0
      gstMap[r].outward_gst  += parseFloat(i.gst_amount)  || 0
    })
    data.purchases.forEach(i => {
      const r = String(i.gst_rate || 0)
      if (!gstMap[r]) gstMap[r] = { outward_base:0, outward_gst:0, inward_base:0, inward_gst:0 }
      gstMap[r].inward_base += parseFloat(i.base_amount) || 0
      gstMap[r].inward_gst  += parseFloat(i.gst_amount)  || 0
    })

    const rows = Object.entries(gstMap).sort((a,b) => parseFloat(a[0])-parseFloat(b[0]))
    const totOut = rows.reduce((s,[,d]) => s + d.outward_gst, 0)
    const totIn  = rows.reduce((s,[,d]) => s + d.inward_gst,  0)
    const netGST = totOut - totIn

    return (
      <div className="bg-white rounded-xl border overflow-x-auto">
        <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">
          GST Summary (outward − inward = net payable)
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              {['GST Rate','Outward Taxable','Out CGST','Out SGST','Out GST','In Taxable','In GST','Net GST'].map(h => (
                <th key={h} className="px-3 py-2 text-right first:text-center">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([rate, d]) => (
              <tr key={rate} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5 text-center font-medium">{rate}%</td>
                <td className="px-3 py-1.5 text-right">{fmt(d.outward_base)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(d.outward_gst/2)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(d.outward_gst/2)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{fmt(d.outward_gst)}</td>
                <td className="px-3 py-1.5 text-right text-blue-600">{fmt(d.inward_base)}</td>
                <td className="px-3 py-1.5 text-right text-blue-600">{fmt(d.inward_gst)}</td>
                <td className={`px-3 py-1.5 text-right font-semibold ${d.outward_gst-d.inward_gst>0?'text-orange-600':'text-green-600'}`}>
                  {fmt(d.outward_gst - d.inward_gst)}
                </td>
              </tr>
            ))}
            <tr className="bg-gray-50 font-bold border-t-2">
              <td className="px-3 py-2 text-center">Total</td>
              <td colSpan={3}></td>
              <td className="px-3 py-2 text-right">{fmt(totOut)}</td>
              <td></td>
              <td className="px-3 py-2 text-right text-blue-700">{fmt(totIn)}</td>
              <td className={`px-3 py-2 text-right ${netGST>0?'text-orange-700':'text-green-700'}`}>{fmt(netGST)}</td>
            </tr>
          </tbody>
        </table>
        <div className="px-4 py-2 text-xs text-gray-400">
          Net GST payable to government = Output GST − Input GST credit
        </div>
      </div>
    )
  }

  // ── Top Products ─────────────────────────────────────────────────────────
  function TopProducts() {
    return (
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">Product</th>
              <th className="px-3 py-2 text-right">Qty Sold</th>
              <th className="px-3 py-2 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).map((p, i) => (
              <tr key={p.name} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5 text-gray-400">{i+1}</td>
                <td className="px-3 py-1.5 font-medium">{p.name}</td>
                <td className="px-3 py-1.5 text-right">{p.qty.toFixed(2)}</td>
                <td className="px-3 py-1.5 text-right font-medium text-blue-700">{fmt(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const TABS = [
    { key:'sales',       label:'Sales Report' },
    { key:'gst',         label:'GST Summary' },
    { key:'purchases',   label:'Purchase Report' },
    { key:'topproducts', label:'Top Products' },
  ]

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-3">Reports</h1>

      {/* Date range */}
      <div className="flex items-center gap-3 mb-4">
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
        <span className="text-gray-400">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
        {[
          { label:'Today',     from: todayStr(),   to: todayStr() },
          { label:'This Month',from: monthStart(), to: todayStr() },
        ].map(p => (
          <button key={p.label}
            onClick={() => { setDateFrom(p.from); setDateTo(p.to) }}
            className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-xs hover:bg-gray-200">
            {p.label}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-10">Loading…</div>
      ) : (
        <>
          {tab === 'sales'       && <SalesSummary />}
          {tab === 'gst'         && <GSTSummary />}
          {tab === 'purchases'   && <PurchaseSummary data={data} />}
          {tab === 'topproducts' && <TopProducts />}
        </>
      )}
    </div>
  )
}

function PurchaseSummary({ data }) {
  const bills = Array.isArray(data) ? data : []

  const total = bills.reduce(
    (sum, b) => sum + (Number(b.total) || 0),
    0
  )

  const unpaid = bills
    .filter(b => b.payment_status !== 'paid')
    .reduce(
      (sum, b) =>
        sum +
        ((Number(b.total) || 0) - (Number(b.paid_amount) || 0)),
      0
    )

  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { label:'Total Purchases', value: fmt(total),  cls:'text-blue-700' },
          { label:'Bills',           value: bills.length, cls:'text-gray-700' },
          { label:'Outstanding',     value: fmt(unpaid), cls:'text-red-700' },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-xl font-bold mt-1 ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>
      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              {['Date','Bill No','Supplier','Sup. Inv.','GST','Total','Paid','Status'].map(h => (
                <th key={h} className="px-3 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bills.map(b => (
              <tr key={b.id} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                <td className="px-3 py-1.5 font-mono font-medium">{b.bill_no}</td>
                <td className="px-3 py-1.5">{b.suppliers?.name || '—'}</td>
                <td className="px-3 py-1.5 text-gray-500 text-xs">{b.supplier_invoice_no || '—'}</td>
                <td className="px-3 py-1.5 text-right">{fmt(b.gst_amount)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{fmt(b.total)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(b.paid_amount)}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                    b.payment_status === 'paid' ? 'bg-green-100 text-green-700'
                    : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-red-100 text-red-700'
                  }`}>{b.payment_status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
