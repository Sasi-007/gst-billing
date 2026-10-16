'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import PurchaseImportPanel from '@/components/PurchaseImportPanel'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { syncPurchaseCreditEntry } from '@/lib/purchaseCredit'

const PAYMENT_MODES = ['Credit', 'Cash', 'UPI', 'Card', 'Cheque']

function getDueAmount(bill) {
  return Math.max(0, Number(bill.total || 0) - Number(bill.paid_amount || 0))
}

const SORT_COLUMNS = [
  { key: 'bill_no', label: 'Bill No', value: (b) => String(b.bill_no || '') },
  { key: 'date', label: 'Date', value: (b) => String(b.date || '') },
  { key: 'supplier', label: 'Supplier', value: (b) => String(b.suppliers?.name || '') },
  { key: 'supplier_invoice_no', label: 'Sup. Invoice', value: (b) => String(b.supplier_invoice_no || '') },
  { key: 'subtotal', label: 'Subtotal', value: (b) => Number(b.subtotal || 0) },
  { key: 'gst_amount', label: 'GST', value: (b) => Number(b.gst_amount || 0) },
  { key: 'total', label: 'Total', value: (b) => Number(b.total || 0) },
  { key: 'paid_amount', label: 'Paid', value: (b) => Number(b.paid_amount || 0) },
  { key: 'due', label: 'Due', value: (b) => getDueAmount(b) },
  { key: 'payment_mode', label: 'Mode', value: (b) => String(b.payment_mode || '') },
  { key: 'payment_status', label: 'Status', value: (b) => String(b.payment_status || '') },
]

function lastMonthRange() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const end = new Date(now.getFullYear(), now.getMonth(), 0)
  const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return { from: format(start), to: format(end) }
}

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
  const router = useRouter()
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [search,   setSearch]   = useState('')
  const [liveTick, setLiveTick] = useState(0)
  const [offlineNotice, setOfflineNotice] = useState('')
  const [error, setError] = useState('')
  const [paymentDrafts, setPaymentDrafts] = useState({})
  const [paymentModes, setPaymentModes] = useState({})
  const [updatingBillId, setUpdatingBillId] = useState(null)
  const [sortKey, setSortKey] = useState('date')
  const [sortDir, setSortDir] = useState('desc')
  const [selectedBillIds, setSelectedBillIds] = useState([])
  const [exportingSupportData, setExportingSupportData] = useState(false)
  const [importPanelOpen, setImportPanelOpen] = useState(false)
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

  const sortedBills = useMemo(() => {
    const column = SORT_COLUMNS.find((col) => col.key === sortKey)
    if (!column) return bills
    const direction = sortDir === 'asc' ? 1 : -1
    return [...bills].sort((a, b) => {
      const left = column.value(a)
      const right = column.value(b)
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
      return String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' }) * direction
    })
  }, [bills, sortDir, sortKey])

  useEffect(() => {
    setSelectedBillIds((prev) => {
      const available = new Set(bills.map((bill) => bill.id))
      const next = prev.filter((id) => available.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [bills])

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDir('asc')
  }

  function handleThisMonth() {
    setDateFrom(monthStartStr())
    setDateTo(todayStr())
  }

  function handleLastMonth() {
    const { from, to } = lastMonthRange()
    setDateFrom(from)
    setDateTo(to)
  }

  function handleToggleBillSelection(billId, checked) {
    setSelectedBillIds((prev) => (checked
      ? (prev.includes(billId) ? prev : [...prev, billId])
      : prev.filter((id) => id !== billId)))
  }

  function handleToggleSelectAllBills(checked) {
    setSelectedBillIds(checked ? sortedBills.map((bill) => bill.id) : [])
  }

  function handleMoveSelectedToNumberUpdater() {
    if (!shop?.id) return
    if (!selectedBillIds.length) {
      setError('Select purchases to update numbering')
      return
    }

    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(
        `purchase-number-updater:${shop.id}`,
        JSON.stringify({ purchaseIds: selectedBillIds, selectedAt: Date.now() })
      )
    }

    router.push('/purchases/number-updater')
  }

  async function handleExportPurchases() {
    const exportBills = selectedBillIds.length
      ? sortedBills.filter((bill) => selectedBillIds.includes(bill.id))
      : sortedBills
    const rows = exportBills.map((bill) => ({
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

    await exportSupportingData(exportBills)
  }

  // Purchase CSVs are useless on re-import without the item lines, suppliers and
  // products they reference, so those files are downloaded alongside the summary.
  async function exportSupportingData(exportBills) {
    if (!shop?.id || !isOnline()) {
      setError('Supporting data (items, suppliers, inventory) needs internet and was not exported.')
      return
    }

    setExportingSupportData(true)
    try {
      const billIds = exportBills.map((bill) => bill.id).filter(Boolean)
      const billNoById = new Map(exportBills.map((bill) => [bill.id, bill.bill_no]))

      const [itemsRes, suppliersRes, productsRes] = await Promise.all([
        billIds.length
          ? supabase
            .from('purchase_bill_items')
            .select('purchase_bill_id,sl_no,product_name,hsn_code,unit,quantity,rate,mrp,gst_rate,sch_disc_amount,cash_disc_amount,taxable_amount,total')
            .eq('shop_id', shop.id)
            .in('purchase_bill_id', billIds)
            .order('sl_no')
          : Promise.resolve({ data: [] }),
        supabase
          .from('suppliers')
          .select('name,contact_person,phone,email,gstin,address,city,state,pincode,is_active')
          .eq('shop_id', shop.id)
          .order('name'),
        supabase
          .from('products')
          .select('name,local_name,brand,barcode,unit,hsn_code,gst_rate,purchase_price,mrp,selling_price,stock_qty,min_stock,is_active,suppliers(name),categories(name)')
          .eq('shop_id', shop.id)
          .order('name'),
      ])

      if (itemsRes.error) throw itemsRes.error
      if (suppliersRes.error) throw suppliersRes.error
      if (productsRes.error) throw productsRes.error

      const itemRows = (itemsRes.data || []).map((item) => ({
        bill_no: billNoById.get(item.purchase_bill_id) || '',
        product_name: item.product_name || '',
        hsn_code: item.hsn_code || '',
        unit: item.unit || '',
        quantity: Number(item.quantity || 0),
        base_rate: Number(item.rate || 0),
        mrp: Number(item.mrp || 0),
        gst_rate: Number(item.gst_rate || 0),
        scheme_discount: Number(item.sch_disc_amount || 0),
        cash_discount: Number(item.cash_disc_amount || 0),
        taxable_amount: Number(item.taxable_amount || 0),
        line_total: Number(item.total || 0),
      }))
      downloadCsv(
        `purchase-items-${dateFrom}-to-${dateTo}.csv`,
        ['bill_no', 'product_name', 'hsn_code', 'unit', 'quantity', 'base_rate', 'mrp', 'gst_rate', 'scheme_discount', 'cash_discount', 'taxable_amount', 'line_total'],
        itemRows
      )

      const supplierRows = (suppliersRes.data || []).map((supplier) => ({
        name: supplier.name || '',
        contact_person: supplier.contact_person || '',
        phone: supplier.phone || '',
        email: supplier.email || '',
        gstin: supplier.gstin || '',
        address: supplier.address || '',
        city: supplier.city || '',
        state: supplier.state || '',
        pincode: supplier.pincode || '',
        is_active: supplier.is_active === false ? 'false' : 'true',
      }))
      downloadCsv(
        'purchase-suppliers.csv',
        ['name', 'contact_person', 'phone', 'email', 'gstin', 'address', 'city', 'state', 'pincode', 'is_active'],
        supplierRows
      )

      const productRows = (productsRes.data || []).map((product) => ({
        name: product.name || '',
        local_name: product.local_name || '',
        brand: product.brand || '',
        category: product.categories?.name || '',
        supplier: product.suppliers?.name || '',
        barcode: product.barcode || '',
        unit: product.unit || '',
        hsn_code: product.hsn_code || '',
        gst_rate: Number(product.gst_rate || 0),
        purchase_price: Number(product.purchase_price || 0),
        mrp: Number(product.mrp || 0),
        selling_price: Number(product.selling_price || 0),
        stock_qty: Number(product.stock_qty || 0),
        min_stock: Number(product.min_stock || 0),
        is_active: product.is_active === false ? 'false' : 'true',
      }))
      downloadCsv(
        'purchase-inventory.csv',
        ['name', 'local_name', 'brand', 'category', 'supplier', 'barcode', 'unit', 'hsn_code', 'gst_rate', 'purchase_price', 'mrp', 'selling_price', 'stock_qty', 'min_stock', 'is_active'],
        productRows
      )
    } catch (exportErr) {
      setError(`Supporting data export failed: ${exportErr?.message || 'Unknown error'}`)
    } finally {
      setExportingSupportData(false)
    }
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
      {importPanelOpen && (
        <PurchaseImportPanel
          shopId={shop?.id}
          onClose={() => setImportPanelOpen(false)}
          onImported={() => setLiveTick((tick) => tick + 1)}
        />
      )}
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
            disabled={bills.length === 0 || exportingSupportData}
            title="Downloads purchases, their item lines, suppliers and inventory so the data can be re-imported"
            className="px-3 sm:px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50 whitespace-nowrap"
          >
            {exportingSupportData ? 'Exporting…' : (
              <>⬇ Export<span className="hidden sm:inline"> CSV + Data</span></>
            )}
          </button>
          <Link href="/purchases/new?import=1"
            className="px-3 sm:px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium whitespace-nowrap">
            ⬆ Items<span className="hidden sm:inline"> CSV</span>
          </Link>
          <button
            type="button"
            onClick={() => setImportPanelOpen(true)}
            title="Upload any one or all four files from the purchases export"
            className="px-3 sm:px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium whitespace-nowrap"
          >
            ⬆ Import<span className="hidden sm:inline"> CSV + Data</span>
          </button>
          <Link href="/purchases/new"
            className="px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium whitespace-nowrap">
            + New<span className="hidden sm:inline"> Purchase</span>
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
          className="border rounded-lg px-3 py-2 text-sm w-full sm:w-48" />
        {search !== debouncedSearch && (
          <span className="self-center text-xs text-blue-600">Searching…</span>
        )}
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm min-w-0 flex-1 sm:flex-none" />
        <span className="self-center text-gray-400 text-sm">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm min-w-0 flex-1 sm:flex-none" />
        <button type="button" onClick={handleThisMonth}
          className="px-3 py-2 rounded-lg border bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 whitespace-nowrap">
          This Month
        </button>
        <button type="button" onClick={handleLastMonth}
          className="px-3 py-2 rounded-lg border bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 whitespace-nowrap">
          Last Month
        </button>
        <button
          type="button"
          onClick={handleMoveSelectedToNumberUpdater}
          disabled={selectedBillIds.length === 0}
          className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60 whitespace-nowrap"
        >
          <span className="sm:hidden">🔢 Renumber</span>
          <span className="hidden sm:inline">Move to Number Updater</span>
          {selectedBillIds.length ? ` (${selectedBillIds.length})` : ''}
        </button>
      </div>

      {loading ? (
        <LoadingPlaceholder label="Loading purchases" rows={4} fullPage />
      ) : bills.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No purchases in this period</div>
      ) : (
        <div className="bg-white rounded-xl border">
          {/* Mobile: card per bill, keeping select + inline payment */}
          <div className="md:hidden divide-y">
            {sortedBills.map(b => (
              <div key={b.id} className="p-3">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedBillIds.includes(b.id)}
                    onChange={(e) => handleToggleBillSelection(b.id, e.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0"
                    aria-label={`Select purchase ${b.bill_no}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/purchases/${b.id}`} className="font-mono font-medium text-blue-700 break-all">
                          {b.bill_no}
                        </Link>
                        <div className="text-xs text-gray-600 truncate">{b.suppliers?.name || '—'}</div>
                        <div className="text-xs text-gray-400">
                          {new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}
                          {b.supplier_invoice_no ? ` · Inv ${b.supplier_invoice_no}` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold">{fmt(b.total)}</div>
                        <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          b.payment_status === 'paid'    ? 'bg-green-100 text-green-700'
                          : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-red-100 text-red-700'
                        }`}>{b.payment_status}</span>
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
                      <span>Subtotal <b className="font-medium">{fmt(b.subtotal)}</b></span>
                      <span>GST <b className="font-medium">{fmt(b.gst_amount)}</b></span>
                      <span className="text-green-700">Paid <b className="font-medium">{fmt(b.paid_amount)}</b></span>
                      <span className={getDueAmount(b) > 0 ? 'text-red-600' : 'text-gray-400'}>
                        Due <b className="font-medium">{fmt(getDueAmount(b))}</b>
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
                      <select
                        value={String(paymentModes[b.id] || b.payment_mode || 'credit').toLowerCase()}
                        onChange={(e) => setPaymentModes((prev) => ({ ...prev, [b.id]: e.target.value }))}
                        className="border rounded px-2 py-1 text-xs bg-white"
                      >
                        {PAYMENT_MODES.map((mode) => (
                          <option key={mode} value={mode.toLowerCase()}>{mode}</option>
                        ))}
                      </select>
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
                      <Link href={`/purchases/${b.id}`} className="ml-auto text-blue-600 text-xs">View</Link>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                <th className="px-3 py-2 text-left whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={sortedBills.length > 0 && selectedBillIds.length === sortedBills.length}
                    onChange={(e) => handleToggleSelectAllBills(e.target.checked)}
                    aria-label="Select all purchases in this list"
                  />
                </th>
                {SORT_COLUMNS.map(col => (
                  <th key={col.key} className="px-3 py-2 text-left whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className="flex items-center gap-1 font-medium text-gray-600 hover:text-blue-700"
                      title={`Sort by ${col.label}`}
                    >
                      {col.label}
                      <span className={sortKey === col.key ? 'text-blue-600' : 'text-gray-300'}>
                        {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                ))}
                <th className="px-3 py-2 text-left whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedBills.map(b => (
                <tr key={b.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedBillIds.includes(b.id)}
                      onChange={(e) => handleToggleBillSelection(b.id, e.target.checked)}
                      aria-label={`Select purchase ${b.bill_no}`}
                    />
                  </td>
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
          </div>
          <div className="px-3 py-2 text-xs text-gray-400">{bills.length} purchases</div>
        </div>
      )}
    </div>
  )
}
