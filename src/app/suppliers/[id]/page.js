'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function downloadCsv(filename, headers, rows) {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function formatDate(date) {
  return date ? new Date(`${date}T00:00:00`).toLocaleDateString('en-IN') : ''
}

export default function SupplierSummaryPage() {
  const params = useParams()
  const supplierId = params?.id
  const { shop } = useShop()
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [tab, setTab] = useState('items')
  const [itemSearch, setItemSearch] = useState('')
  const cacheKey = shop?.id && supplierId ? `supplier-summary:${shop.id}:${supplierId}:${dateFrom}:${dateTo}` : ''
  const initialCache = readPageCache(cacheKey)
  const [supplier, setSupplier] = useState(() => initialCache?.supplier || null)
  const [bills, setBills] = useState(() => initialCache?.bills || [])
  const [items, setItems] = useState(() => initialCache?.items || [])
  const [loading, setLoading] = useState(() => !initialCache)
  const [error, setError] = useState('')
  usePageLoadingState('supplier-summary-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id || !supplierId) {
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.bills) {
      setSupplier(cached.supplier || null)
      setBills(cached.bills)
      setItems(cached.items || [])
      setLoading(false)
    } else {
      setLoading(true)
    }

    try {
      const [supplierRes, billsRes] = await Promise.all([
        supabase.from('suppliers').select('*').eq('id', supplierId).eq('shop_id', shop.id).maybeSingle(),
        supabase
          .from('purchase_bills')
          .select('id,bill_no,supplier_invoice_no,date,subtotal,gst_amount,total,paid_amount,payment_mode,payment_status')
          .eq('shop_id', shop.id)
          .eq('supplier_id', supplierId)
          .gte('date', dateFrom)
          .lte('date', dateTo)
          .order('date', { ascending: false }),
      ])
      if (supplierRes.error) throw supplierRes.error
      if (billsRes.error) throw billsRes.error

      const nextBills = billsRes.data || []
      let nextItems = []
      if (nextBills.length) {
        const { data, error: itemsError } = await supabase
          .from('purchase_bill_items')
          .select('purchase_bill_id,product_id,product_name,hsn_code,unit,quantity,rate,mrp,gst_rate,gst_amount,total')
          .eq('shop_id', shop.id)
          .in('purchase_bill_id', nextBills.map((bill) => bill.id))
        if (itemsError) throw itemsError
        nextItems = data || []
      }

      setSupplier(supplierRes.data || null)
      setBills(nextBills)
      setItems(nextItems)
      setError('')
      writePageCache(cacheKey, { supplier: supplierRes.data || null, bills: nextBills, items: nextItems })
    } catch (err) {
      setError(err.message || 'Failed to load supplier summary')
    } finally {
      setLoading(false)
    }
  }, [cacheKey, dateFrom, dateTo, shop?.id, supplierId])

  useEffect(() => { load() }, [load])

  const billById = useMemo(() => new Map(bills.map((bill) => [bill.id, bill])), [bills])

  const totals = useMemo(() => {
    const purchased = bills.reduce((sum, bill) => sum + Number(bill.total || 0), 0)
    const paid = bills.reduce((sum, bill) => sum + Number(bill.paid_amount || 0), 0)
    const gst = bills.reduce((sum, bill) => sum + Number(bill.gst_amount || 0), 0)
    return {
      bills: bills.length,
      purchased,
      paid,
      outstanding: purchased - paid,
      gst,
      uniqueItems: new Set(items.map((item) => item.product_id || item.product_name)).size,
    }
  }, [bills, items])

  const productSummary = useMemo(() => {
    const map = new Map()
    for (const item of items) {
      const key = item.product_id || `name:${item.product_name}`
      const bill = billById.get(item.purchase_bill_id)
      const existing = map.get(key) || {
        key,
        product_id: item.product_id,
        product_name: item.product_name,
        hsn_code: item.hsn_code || '',
        unit: item.unit || '',
        quantity: 0,
        amount: 0,
        gst_amount: 0,
        bills: new Set(),
        lastRate: Number(item.rate || 0),
        lastMrp: Number(item.mrp || 0),
        lastDate: bill?.date || '',
      }
      existing.quantity += Number(item.quantity || 0)
      existing.amount += Number(item.total || 0)
      existing.gst_amount += Number(item.gst_amount || 0)
      existing.bills.add(item.purchase_bill_id)
      if (bill?.date && bill.date >= existing.lastDate) {
        existing.lastDate = bill.date
        existing.lastRate = Number(item.rate || 0)
        existing.lastMrp = Number(item.mrp || 0)
      }
      map.set(key, existing)
    }
    const term = itemSearch.trim().toLowerCase()
    return Array.from(map.values())
      .map((row) => ({ ...row, billCount: row.bills.size, avgRate: row.quantity ? row.amount / row.quantity : 0 }))
      .filter((row) => !term
        || row.product_name.toLowerCase().includes(term)
        || row.hsn_code.toLowerCase().includes(term))
      .sort((a, b) => b.amount - a.amount)
  }, [billById, itemSearch, items])

  function exportItems() {
    downloadCsv(
      `supplier-${supplier?.name || supplierId}-items-${dateFrom}-to-${dateTo}.csv`,
      ['product_name', 'hsn_code', 'unit', 'quantity', 'amount', 'gst_amount', 'avg_rate', 'last_rate', 'last_mrp', 'bills', 'last_purchase'],
      productSummary.map((row) => ({
        product_name: row.product_name,
        hsn_code: row.hsn_code,
        unit: row.unit,
        quantity: row.quantity,
        amount: row.amount.toFixed(2),
        gst_amount: row.gst_amount.toFixed(2),
        avg_rate: row.avgRate.toFixed(2),
        last_rate: row.lastRate.toFixed(2),
        last_mrp: row.lastMrp.toFixed(2),
        bills: row.billCount,
        last_purchase: row.lastDate,
      })),
    )
  }

  function exportBills() {
    downloadCsv(
      `supplier-${supplier?.name || supplierId}-bills-${dateFrom}-to-${dateTo}.csv`,
      ['date', 'bill_no', 'supplier_invoice_no', 'subtotal', 'gst_amount', 'total', 'paid_amount', 'balance', 'payment_status'],
      bills.map((bill) => ({
        date: bill.date,
        bill_no: bill.bill_no,
        supplier_invoice_no: bill.supplier_invoice_no || '',
        subtotal: Number(bill.subtotal || 0).toFixed(2),
        gst_amount: Number(bill.gst_amount || 0).toFixed(2),
        total: Number(bill.total || 0).toFixed(2),
        paid_amount: Number(bill.paid_amount || 0).toFixed(2),
        balance: (Number(bill.total || 0) - Number(bill.paid_amount || 0)).toFixed(2),
        payment_status: bill.payment_status || '',
      })),
    )
  }

  const kpis = [
    { label: 'Bills', value: totals.bills, tone: 'text-gray-900' },
    { label: 'Purchased', value: fmt(totals.purchased), tone: 'text-blue-700' },
    { label: 'Paid', value: fmt(totals.paid), tone: 'text-green-700' },
    { label: 'Outstanding', value: fmt(totals.outstanding), tone: totals.outstanding > 0 ? 'text-red-600' : 'text-gray-900' },
    { label: 'GST', value: fmt(totals.gst), tone: 'text-gray-700' },
    { label: 'Distinct Items', value: totals.uniqueItems, tone: 'text-gray-900' },
  ]

  return (
    <div className="p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div>
          <Link href="/suppliers" className="text-xs text-blue-600 hover:underline">← Suppliers</Link>
          <h1 className="text-xl font-bold text-gray-900">{supplier?.name || 'Supplier'} — Purchase Summary</h1>
          <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
            {supplier?.phone && <span>📞 {supplier.phone}</span>}
            {supplier?.gstin && <span className="font-mono">{supplier.gstin}</span>}
            {supplier?.city && <span>{supplier.city}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm" />
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm" />
          <Link
            href={`/inventory?supplier=${supplierId}`}
            className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
          >
            Stock from this supplier
          </Link>
        </div>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-xl border bg-white px-3 py-2">
            <div className="text-[11px] text-gray-500">{kpi.label}</div>
            <div className={`text-base font-semibold ${kpi.tone}`}>{kpi.value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-lg border overflow-hidden text-xs">
          {[['items', 'Item-wise'], ['bills', 'Bill-wise']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 font-medium ${tab === key ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'items' && (
          <input
            value={itemSearch}
            onChange={(e) => setItemSearch(e.target.value)}
            placeholder="🔍 Filter items…"
            className="border rounded-lg px-3 py-1.5 text-sm"
          />
        )}
        <button
          type="button"
          onClick={tab === 'items' ? exportItems : exportBills}
          className="ml-auto px-3 py-1.5 rounded-lg border text-sm text-gray-700 hover:bg-gray-50"
        >
          Download CSV
        </button>
      </div>

      {loading ? (
        <LoadingPlaceholder label="Loading supplier summary" rows={4} fullPage />
      ) : tab === 'items' ? (
        productSummary.length === 0 ? (
          <div className="text-center text-gray-400 py-10">No purchases from this supplier in the selected range</div>
        ) : (
          <div className="rounded-lg border bg-white overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  {['Product', 'HSN', 'Qty', 'Avg Rate', 'Last Rate', 'Last MRP', 'GST', 'Amount', 'Bills', 'Last Purchase'].map((header) => (
                    <th key={header} className="px-3 py-2 text-left whitespace-nowrap">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {productSummary.map((row) => (
                  <tr key={row.key} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium max-w-[240px] truncate" title={row.product_name}>
                      {row.product_id
                        ? <Link href={`/inventory/${row.product_id}`} className="text-blue-600 hover:underline">{row.product_name}</Link>
                        : row.product_name}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">{row.hsn_code || '—'}</td>
                    <td className="px-3 py-2 text-right">{row.quantity} {row.unit}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{fmt(row.avgRate)}</td>
                    <td className="px-3 py-2 text-right">{fmt(row.lastRate)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(row.lastMrp)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(row.gst_amount)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-blue-700">{fmt(row.amount)}</td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500">{row.billCount}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{formatDate(row.lastDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : bills.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No bills from this supplier in the selected range</div>
      ) : (
        <div className="rounded-lg border bg-white overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                {['Date', 'Bill No', 'Supplier Invoice', 'Subtotal', 'GST', 'Total', 'Paid', 'Balance', 'Status'].map((header) => (
                  <th key={header} className="px-3 py-2 text-left whitespace-nowrap">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => {
                const balance = Number(bill.total || 0) - Number(bill.paid_amount || 0)
                return (
                  <tr key={bill.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs text-gray-500">{formatDate(bill.date)}</td>
                    <td className="px-3 py-2 font-medium">
                      <Link href={`/purchases/${bill.id}`} className="text-blue-600 hover:underline">{bill.bill_no}</Link>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{bill.supplier_invoice_no || '—'}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(bill.subtotal)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(bill.gst_amount)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmt(bill.total)}</td>
                    <td className="px-3 py-2 text-right text-green-700">{fmt(bill.paid_amount)}</td>
                    <td className={`px-3 py-2 text-right ${balance > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{fmt(balance)}</td>
                    <td className="px-3 py-2 text-xs capitalize">{bill.payment_status || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
