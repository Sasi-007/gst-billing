'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import Link from 'next/link'
import { syncPurchaseCreditEntry } from '@/lib/purchaseCredit'

const PAYMENT_MODES = ['Credit', 'Cash', 'UPI', 'Card', 'Cheque']

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
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function formatDate(date) {
  return date ? new Date(date + 'T00:00:00').toLocaleDateString('en-IN') : ''
}

function normalizePaymentModeForDb(value, fallback = 'credit') {
  const mode = String(value || '').trim().toLowerCase()
  if (!mode) return fallback
  if (mode === 'gpay') return 'upi'
  return mode
}

function isOnline() {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

async function fetchPurchasesDirect(shopId, dateFrom, dateTo, search) {
  let q = supabase.from('purchase_bills').select('*, suppliers(name,phone,gstin)').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(200)
  if (search) q = q.ilike('bill_no', `%${search}%`)
  const { data } = await q
  return { bills: data || [] }
}

export default function PurchasesPage() {
  const { shop } = useShop()
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [search,   setSearch]   = useState('')
  const [liveTick, setLiveTick] = useState(0)
  const [offlineNotice, setOfflineNotice] = useState('')
  const [error, setError] = useState('')
  const [paymentDrafts, setPaymentDrafts] = useState({})
  const [paymentModes, setPaymentModes] = useState({})
  const [updatingBillId, setUpdatingBillId] = useState(null)
  const loadedTick = useRef(0)
  const debouncedSearch = useDebouncedValue(search)
  const cacheKey = shop?.id ? `purchases:${shop.id}:${dateFrom}:${dateTo}:${debouncedSearch}` : ''
  const initialCache = readPageCache(cacheKey)
  const [bills,    setBills]    = useState(() => initialCache?.bills || [])
  const [loading,  setLoading]  = useState(() => !initialCache)
  usePageLoadingState('purchases-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setBills([])
      setOfflineNotice('')
      setError('')
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    const shouldForceFresh = liveTick !== loadedTick.current
    setOfflineNotice('')
    setError('')
    if (cached?.bills && !shouldForceFresh) {
      setBills(cached.bills)
      setLoading(false)
    } else {
      setLoading(true)
    }

    if (!isOnline()) {
      if (cached?.bills) {
        setBills(cached.bills)
        setOfflineNotice('Offline mode: showing cached purchases')
        setLoading(false)
        return
      }
      setBills([])
      setError('Purchases are unavailable offline until this screen has been opened once online.')
      setOfflineNotice('')
      setLoading(false)
      return
    }

    try {
      const nextData = await fetchPurchasesDirect(shop.id, dateFrom, dateTo, debouncedSearch)
      const nextBills = nextData.bills || []
      setBills(nextBills)
      writePageCache(cacheKey, { bills: nextBills })
      loadedTick.current = liveTick
      setLoading(false)
    } catch (error) {
      if (cached?.bills) {
        setBills(cached.bills)
        setOfflineNotice('Offline mode: showing cached purchases')
        setLoading(false)
        return
      }
      setBills([])
      setError(error?.message || 'Failed to load purchases')
      setLoading(false)
    }
  }, [cacheKey, dateFrom, dateTo, debouncedSearch, liveTick, shop?.id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!shop?.id) return
    const channel = supabase.channel(`purchases-live:${shop.id}`)
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'purchase_bills',
      filter: `shop_id=eq.${shop.id}`,
    }, () => setLiveTick((tick) => tick + 1))
    channel.subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [shop?.id])

  const totalAmt = bills.reduce((s, b) => s + (b.total || 0), 0)
  const unpaidAmt = bills.filter(b => b.payment_status !== 'paid').reduce((s, b) => s + ((b.total || 0) - (b.paid_amount || 0)), 0)

  function handleExportPurchases() {
    const rows = bills.map((bill) => ({
      'Bill No': bill.bill_no,
      Date: formatDate(bill.date),
      Supplier: bill.suppliers?.name || '',
      'Supplier Phone': bill.suppliers?.phone || '',
      'Supplier GSTIN': bill.suppliers?.gstin || '',
      'Supplier Invoice No': bill.supplier_invoice_no || '',
      Subtotal: Number(bill.subtotal || 0),
      GST: Number(bill.gst_amount || 0),
      Total: Number(bill.total || 0),
      Paid: Number(bill.paid_amount || 0),
      Due: getDueAmount(bill),
      'Payment Mode': bill.payment_mode || '',
      Status: bill.payment_status || '',
      Notes: bill.notes || '',
    }))
    downloadCsv(`purchases-${dateFrom}-to-${dateTo}.csv`, Object.keys(rows[0] || {
      'Bill No': '', Date: '', Supplier: '', 'Supplier Phone': '', 'Supplier GSTIN': '', 'Supplier Invoice No': '', Subtotal: '', GST: '', Total: '', Paid: '', Due: '', 'Payment Mode': '', Status: '', Notes: '',
    }), rows)
  }

  function getDueAmount(bill) {
    return Math.max(0, Number(bill.total || 0) - Number(bill.paid_amount || 0))
  }

  function getPaymentStatus(total, paid) {
    if (paid >= total) return 'paid'
    if (paid > 0) return 'partial'
    return 'unpaid'
  }

  async function handleRecordPayment(bill) {
    if (!shop?.id || !bill?.id) return
    const due = getDueAmount(bill)
    if (due <= 0) return

    const draftValue = paymentDrafts[bill.id] ?? ''
    const amountToAdd = Number(draftValue)
    if (!Number.isFinite(amountToAdd) || amountToAdd <= 0) {
      setError('Enter a valid payment amount greater than 0')
      return
    }

    const currentPaid = Number(bill.paid_amount || 0)
    const total = Number(bill.total || 0)
    const nextPaid = Math.min(total, currentPaid + amountToAdd)
    const selectedMode = normalizePaymentModeForDb(paymentModes[bill.id] || bill.payment_mode || 'credit')
    const nextStatus = getPaymentStatus(total, nextPaid)

    setUpdatingBillId(bill.id)
    const { error: updateErr } = await supabase
      .from('purchase_bills')
      .update({
        paid_amount: nextPaid,
        payment_mode: selectedMode,
        payment_status: nextStatus,
      })
      .eq('id', bill.id)
      .eq('shop_id', shop.id)

    if (updateErr) {
      setError(updateErr.message || 'Failed to update payment')
      setUpdatingBillId(null)
      return
    }

    let syncError = null
    try {
      await syncPurchaseCreditEntry({
        shopId: shop.id,
        purchaseId: bill.id,
        billNo: bill.bill_no,
        billDate: bill.date,
        supplierId: bill.supplier_id,
        supplierName: bill.suppliers?.name || '',
        supplierPhone: bill.suppliers?.phone || '',
        payMode: selectedMode,
        paidAmount: nextPaid,
        totalAmount: total,
      })
    } catch (syncErr) {
      syncError = syncErr
    }

    setError(syncError?.message || '')
    setBills((prevBills) => prevBills.map((row) => (
      row.id === bill.id
        ? { ...row, paid_amount: nextPaid, payment_mode: selectedMode, payment_status: nextStatus }
        : row
    )))
    setPaymentDrafts((prev) => ({ ...prev, [bill.id]: '' }))
    setUpdatingBillId(null)
  }

  return (
    <div className="p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Purchases</h1>
          <div className="text-xs text-gray-500 mt-0.5">
            Total: {fmt(totalAmt)}
            {unpaidAmt > 0 && <span className="text-red-600 ml-2">· Unpaid: {fmt(unpaidAmt)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleExportPurchases}
            disabled={bills.length === 0}
            className="px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50"
          >
            Export CSV
          </button>
          <Link href="/purchases/new?import=1"
            className="px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
            Import CSV
          </Link>
          <Link href="/purchases/new"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
            + New Purchase
          </Link>
        </div>
      </div>

      {offlineNotice && (
        <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          {offlineNotice}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search bill no…"
          className="border rounded-lg px-3 py-2 text-sm w-48" />
        {search !== debouncedSearch && (
          <span className="self-center text-xs text-blue-600">Searching…</span>
        )}
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
        <span className="self-center text-gray-400 text-sm">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
      </div>

      {loading ? (
        <LoadingPlaceholder label="Loading purchases" rows={4} fullPage />
      ) : bills.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No purchases in this period</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                {['Bill No','Date','Supplier','Sup. Invoice','Subtotal','GST','Total','Paid','Due','Mode','Status','Action'].map(h => (
                  <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bills.map(b => (
                <tr key={b.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium">
                    <Link href={`/purchases/${b.id}`} className="text-blue-700 hover:underline">
                      {b.bill_no}
                    </Link>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                  <td className="px-3 py-2">{b.suppliers?.name || '—'}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{b.supplier_invoice_no || '—'}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.subtotal)}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.gst_amount)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmt(b.total)}</td>
                  <td className="px-3 py-2 text-right">{fmt(b.paid_amount)}</td>
                  <td className="px-3 py-2 text-right">{fmt(getDueAmount(b))}</td>
                  <td className="px-3 py-2">
                    <select
                      value={String(paymentModes[b.id] || b.payment_mode || 'credit').toLowerCase()}
                      onChange={(e) => setPaymentModes((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      className="border rounded px-2 py-1 text-xs bg-white"
                    >
                      {PAYMENT_MODES.map((mode) => (
                        <option key={mode} value={mode.toLowerCase()}>
                          {mode}
                        </option>
                      ))}
                    </select>
                  </td>
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
                    <div className="flex items-center gap-2">
                      {getDueAmount(b) > 0 ? (
                        <>
                          <input
                            type="number"
                            value={paymentDrafts[b.id] ?? ''}
                            onChange={(e) => setPaymentDrafts((prev) => ({ ...prev, [b.id]: e.target.value }))}
                            placeholder="Paid now"
                            className="w-24 border rounded px-2 py-1 text-xs"
                            min="0"
                            step="0.01"
                          />
                          <button
                            type="button"
                            onClick={() => handleRecordPayment(b)}
                            disabled={updatingBillId === b.id}
                            className="px-2 py-1 rounded bg-green-600 text-white text-xs hover:bg-green-700 disabled:opacity-60"
                          >
                            {updatingBillId === b.id ? 'Saving…' : 'Record'}
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400">Settled</span>
                      )}
                      <Link href={`/purchases/${b.id}`}
                        className="text-blue-600 hover:underline text-xs">View</Link>
                    </div>
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
