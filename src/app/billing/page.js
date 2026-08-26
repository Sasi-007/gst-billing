'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { calcItem, calcBillTotals, fmt, GST_RATES } from '@/lib/gst'
import ProductSearch from '@/components/ProductSearch'
import PrintTemplate from '@/components/PrintTemplate'
import { useShop } from '@/context/ShopContext'

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Credit', 'Cheque']

let _uid = 0
function uid() { return ++_uid }

function emptyItem() {
  return {
    _id:            uid(),
    product_id:     null,
    product_name:   '',
    hsn_code:       '',
    unit:           'pcs',
    quantity:       '',
    mrp:            0,
    rate:           '',
    gst_rate:       0,
    discount_pct:   '',
    // computed
    base_amount:    0,
    gst_amount:     0,
    discount_amount:0,
    total:          0,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function focusId(id) {
  setTimeout(() => {
    const el = document.getElementById(id)
    if (el) { el.focus(); el.select?.() }
  }, 30)
}

export default function BillingPage() {
  const searchParams = useSearchParams()
  const [items,       setItems]       = useState([emptyItem()])
  const [customer,    setCustomer]    = useState({ name:'', phone:'', gstin:'', address:'' })
  const [billDate,    setBillDate]    = useState(new Date().toISOString().slice(0,10))
  const [billNo,      setBillNo]      = useState('')
  const [billType,    setBillType]    = useState('invoice')
  const [payMode,     setPayMode]     = useState('Cash')
  const [paidAmt,     setPaidAmt]     = useState('')
  const [notes,       setNotes]       = useState('')

  const [searchOpen,  setSearchOpen]  = useState(false)
  const [activeRow,   setActiveRow]   = useState(0)
  const [printData,   setPrintData]   = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [toast,       setToast]       = useState(null)
  const [mounted,     setMounted]     = useState(false)
  const [view,        setView]        = useState('form') // 'form' | 'history'
  const [editBillId,   setEditBillId] = useState(null)
  const [historyBills, setHistoryBills] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historySearch, setHistorySearch] = useState('')

  useEffect(() => setMounted(true), [])

  const { shop } = useShop()

  // ── Load history when switching to history view ────────────────────────────
  useEffect(() => {
    if (view !== 'history' || !shop?.id) return
    setHistoryLoading(true)
    let q = supabase
      .from('bills')
      .select('id,bill_no,date,customer_name,total,payment_status,bill_type')
      .eq('shop_id', shop.id)
      .eq('bill_type', billType)
      .order('created_at', { ascending: false })
      .limit(50)
    const term = historySearch.trim()
    if (term) {
      q = q.or(`bill_no.ilike.%${term}%,customer_name.ilike.%${term}%`)
    }
    q.then(({ data }) => {
        setHistoryBills(data || [])
        setHistoryLoading(false)
      })
  }, [view, billType, historySearch, shop?.id])

  // ── Load existing bill into form when ?editId= is provided ───────────────────
  useEffect(() => {
    const id = searchParams.get('editId')
    if (!id || !shop?.id) return

    let cancelled = false
    async function loadForEdit() {
      const [{ data: b, error: bErr }, { data: lines, error: lErr }] = await Promise.all([
        supabase
          .from('bills')
          .select('*')
          .eq('id', id)
          .eq('shop_id', shop.id)
          .single(),
        supabase
          .from('bill_items')
          .select('id,product_id,product_name,hsn_code,unit,quantity,mrp,rate,gst_rate,discount_pct,base_rate,gst_amount,discount_amount,total,sl_no')
          .eq('bill_id', id)
          .eq('shop_id', shop.id)
          .order('sl_no'),
      ])

      if (cancelled) return
      if (bErr) { showToast('Load failed: ' + bErr.message, 'error'); return }
      if (lErr) { showToast('Load failed: ' + lErr.message, 'error'); return }

      setEditBillId(id)
      setView('form')
      setBillType(b.bill_type || 'invoice')
      setBillNo(b.bill_no || '')
      setBillDate(b.date || new Date().toISOString().slice(0, 10))
      setCustomer({
        name: b.customer_name || '',
        phone: b.customer_phone || '',
        gstin: b.customer_gstin || '',
        address: b.customer_address || '',
      })
      setPayMode(b.payment_mode ? b.payment_mode.charAt(0).toUpperCase() + b.payment_mode.slice(1) : 'Cash')
      setPaidAmt(String(b.paid_amount ?? ''))
      setNotes(b.notes || '')

      const loaded = (lines || []).map((it) => ({
        _id: uid(),
        product_id: it.product_id || null,
        product_name: it.product_name || '',
        hsn_code: it.hsn_code || '',
        unit: it.unit || 'pcs',
        quantity: it.quantity ?? 1,
        mrp: it.mrp ?? 0,
        rate: it.rate ?? 0,
        gst_rate: it.gst_rate ?? 0,
        discount_pct: it.discount_pct ?? 0,
        base_amount: (Number(it.total || 0) - Number(it.gst_amount || 0)),
        gst_amount: it.gst_amount ?? 0,
        discount_amount: it.discount_amount ?? 0,
        total: it.total ?? 0,
      }))
      setItems(loaded.length ? loaded : [emptyItem()])
      setActiveRow(0)
    }

    loadForEdit()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, shop?.id])

  // ── Pick up quotation redirect flag from sessionStorage ─────────────────
  useEffect(() => {
    const type = sessionStorage.getItem('defaultBillType')
    if (type) { setBillType(type); sessionStorage.removeItem('defaultBillType') }
  }, [])

  // ── Toast helper ──────────────────────────────────────────────────────────
  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // ── Item calculation — runs for any item that has rate set ─────────────────
  function recalc(item) {
    if (!parseFloat(item.rate) && !parseFloat(item.quantity)) return item
    const c = calcItem(
      parseFloat(item.rate)         || 0,
      parseFloat(item.quantity)     || 0,
      parseFloat(item.gst_rate)     || 0,
      parseFloat(item.discount_pct) || 0,
    )
    return { ...item, ...c }
  }

  function updateItem(index, field, value) {
    setItems(prev => {
      const next = [...prev]
      next[index] = recalc({ ...next[index], [field]: value })
      return next
    })
  }

  // ── Derived totals ─────────────────────────────────────────────────────────
  // Include free-text items (no product_id) that have a name and rate entered
  const filledItems = items.filter(i => i.product_id || (i.product_name && parseFloat(i.rate) > 0))
  const totals      = calcBillTotals(filledItems)

  // ── Open search for a row ──────────────────────────────────────────────────
  const openSearch = useCallback((rowIdx) => {
    setActiveRow(rowIdx)
    setSearchOpen(true)
  }, [])

  // ── Product selected from modal ───────────────────────────────────────────
  function handleProductSelect(product) {
    const rate = product.selling_price || product.mrp || 0
    setItems(prev => {
      const next = [...prev]
      const item = {
        ...next[activeRow],
        product_id:   product.id,
        product_name: product.name,
        hsn_code:     product.hsn_code || '',
        unit:         product.unit     || 'pcs',
        mrp:          product.mrp      || rate,
        rate,
        gst_rate:     product.gst_rate || 0,
        quantity:     1,
        discount_pct: '',
        stock_qty:    product.stock_qty,
        min_stock:    product.min_stock || 0,
      }
      next[activeRow] = recalc(item)
      return next
    })
    setSearchOpen(false)
    focusId(`qty-${activeRow}`)
  }

  // ── Free-text item (not in inventory) ────────────────────────────────────
  function handleFreeTextItem(name) {
    setItems(prev => {
      const next = [...prev]
      next[activeRow] = {
        ...next[activeRow],
        product_id:   null,
        product_name: name,
        unit:         'pcs',
        quantity:     1,
        rate:         '',
        gst_rate:     0,
        base_amount:  0,
        gst_amount:   0,
        discount_amount: 0,
        total:        0,
      }
      return next
    })
    setSearchOpen(false)
    focusId(`rate-${activeRow}`)  // focus rate — user must enter price manually
  }

  // ── Row actions ────────────────────────────────────────────────────────────
  function addRow() {
    const idx = items.length
    setItems(prev => [...prev, emptyItem()])
    setActiveRow(idx)
    setTimeout(() => openSearch(idx), 60)
  }

  function deleteRow(index) {
    if (items.length === 1) { setItems([emptyItem()]); return }
    setItems(prev => prev.filter((_, i) => i !== index))
    setActiveRow(Math.max(0, index - 1))
  }

  // ── New bill ───────────────────────────────────────────────────────────────
  function handleNewBill() {
    if (filledItems.length > 0 && !window.confirm('Clear current bill and start new?')) return
    setEditBillId(null)
    setItems([emptyItem()])
    setCustomer({ name:'', phone:'', gstin:'', address:'' })
    setBillDate(new Date().toISOString().slice(0,10))
    setBillNo('')
    setPaidAmt('')
    setNotes('')
    setActiveRow(0)
    setPrintData(null)
    setTimeout(() => openSearch(0), 60)
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave(withPrint = false) {
    if (filledItems.length === 0) { showToast('Add at least one item', 'error'); return }
    setSaving(true)

    try {
      // Generate bill number with type-appropriate prefix
      let finalNo = billNo.trim()
      if (!finalNo) {
        if (!shop?.id) throw new Error('Shop not loaded. Please refresh.')
        const prefix =
          billType === 'quotation' ? (shop.quotation_prefix || 'QUO')
          : billType === 'estimate' ? (shop.estimate_prefix || 'EST')
          : (shop.bill_prefix || 'INV')
        const { data: no } = await supabase.rpc('get_next_bill_no', {
          p_shop_id: shop.id,
          p_prefix:  prefix,
        })
        finalNo = no || `${prefix}-${Date.now()}`
        setBillNo(finalNo)
      }

      const paid = parseFloat(paidAmt) || totals.total

      const billRow = {
        shop_id:          shop.id,
        bill_no:          finalNo,
        bill_type:        billType,
        date:             billDate,
        customer_name:    customer.name    || null,
        customer_phone:   customer.phone   || null,
        customer_gstin:   customer.gstin   || null,
        customer_address: customer.address || null,
        subtotal:         totals.subtotal,
        cgst_amount:      totals.gstAmount / 2,
        sgst_amount:      totals.gstAmount / 2,
        gst_amount:       totals.gstAmount,
        discount_amount:  totals.discountAmount,
        total:            totals.total,
        paid_amount:      paid,
        payment_mode:     payMode.toLowerCase(),
        payment_status:   paid >= totals.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
        notes:            notes || null,
      }

      let savedId = editBillId
      if (editBillId) {
        const { error: updErr } = await supabase
          .from('bills')
          .update(billRow)
          .eq('id', editBillId)
          .eq('shop_id', shop.id)
        if (updErr) throw updErr
      } else {
        const { data: saved, error: billErr } = await supabase.from('bills').insert(billRow).select().single()
        if (billErr) throw billErr
        savedId = saved.id
      }

      const lineItems = filledItems.map((item, i) => ({
        shop_id:         shop.id,
        bill_id:         savedId,
        product_id:      item.product_id,
        sl_no:           i + 1,
        product_name:    item.product_name,
        hsn_code:        item.hsn_code || null,
        unit:            item.unit,
        quantity:        parseFloat(item.quantity)     || 1,
        mrp:             item.mrp,
        rate:            parseFloat(item.rate)         || 0,
        base_rate:       (parseFloat(item.rate) || 0) / (1 + (item.gst_rate || 0) / 100),
        gst_rate:        item.gst_rate     || 0,
        gst_amount:      item.gst_amount   || 0,
        discount_pct:    parseFloat(item.discount_pct) || 0,
        discount_amount: item.discount_amount || 0,
        total:           item.total        || 0,
      }))

      if (editBillId) {
        const { error: delErr } = await supabase
          .from('bill_items')
          .delete()
          .eq('bill_id', editBillId)
          .eq('shop_id', shop.id)
        if (delErr) throw delErr
      }

      const { error: itemErr } = await supabase.from('bill_items').insert(lineItems)
      if (itemErr) throw itemErr

      showToast(editBillId ? `✓ ${finalNo} updated` : `✓ ${finalNo} saved`)

      if (withPrint) {
        setPrintData({ bill: { ...billRow, id: savedId }, items: filledItems, shop, totals })
        setTimeout(() => window.print(), 200)
      }
    } catch (err) {
      console.error(err)
      showToast('Save failed: ' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (searchOpen) return

      switch (e.key) {
        case 'F2':  e.preventDefault(); handleNewBill();        break
        case 'F3':  e.preventDefault(); openSearch(activeRow);  break
        case 'F4':  e.preventDefault(); addRow();               break
        case 'F8':  e.preventDefault(); handleSave(true);       break
        case 'F9':  e.preventDefault(); handleSave(false);      break
        case '/':
          if (!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) {
            e.preventDefault()
            openSearch(activeRow)
          }
          break
        default:
          if (e.ctrlKey && e.key.toLowerCase() === 'd') {
            e.preventDefault()
            deleteRow(activeRow)
          }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, activeRow])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* PrintTemplate portaled to document.body — escapes the no-print parent */}
      {printData && mounted && createPortal(
        <PrintTemplate data={printData} />,
        document.body
      )}

      {/* Product search modal */}
      {searchOpen && (
        <ProductSearch
          onSelect={handleProductSelect}
          onAddFreeText={handleFreeTextItem}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* Toast notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg shadow-lg text-white text-sm font-medium no-print ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
        }`}>
          {toast.msg}
        </div>
      )}

      <div className="flex flex-col h-full no-print">

        {/* ── Top bar ─────────────────────────────────────────────────── */}
        <div className="bg-white border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <select
              value={billType}
              onChange={e => { setBillType(e.target.value); setView('form') }}
              className="border rounded px-2 py-1 text-sm font-semibold"
            >
              <option value="invoice">Tax Invoice</option>
              <option value="quotation">Quotation</option>
              <option value="estimate">Estimate</option>
            </select>
          </div>

          {/* New / History tabs */}
          <div className="flex gap-1">
            <button
              onClick={() => setView('form')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${view === 'form' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >New</button>
            <button
              onClick={() => setView('history')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${view === 'history' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >History</button>
          </div>

          {view === 'form' && (
            <div className="flex items-center gap-2 ml-auto text-sm">
              {editBillId && (
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-medium">
                  Editing Existing Bill
                </span>
              )}
              <label className="text-gray-500">Bill No</label>
              <input
                value={billNo}
                onChange={e => setBillNo(e.target.value)}
                placeholder="Auto"
                className="border rounded px-2 py-1 w-28 font-mono text-sm"
              />
              <label className="text-gray-500 ml-2">Date</label>
              <input
                type="date"
                value={billDate}
                onChange={e => setBillDate(e.target.value)}
                className="border rounded px-2 py-1 text-sm"
              />
            </div>
          )}
        </div>

        {/* ── Shortcut strip (desktop only) ──────────────────────────── */}
        {view === 'form' && (
        <div className="shortcuts-bar bg-blue-700 text-white text-xs px-4 py-1 flex flex-wrap gap-4 flex-shrink-0 no-print">
          <span><kbd>F2</kbd> New</span>
          <span><kbd>F3</kbd> or <kbd>/</kbd> Search product</span>
          <span><kbd>F4</kbd> Add row</span>
          <span><kbd>F8</kbd> Save+Print</span>
          <span><kbd>F9</kbd> Save</span>
          <span><kbd>Ctrl+D</kbd> Delete row</span>
          <span><kbd>↑↓ Enter</kbd> Pick item in search</span>
        </div>
        )}

        {/* ── History view ─────────────────────────────────────────── */}
        {view === 'history' && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mb-3">
              <input
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                placeholder={`Search ${billType} by bill no or customer`}
                className="w-full max-w-md border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            {historyLoading ? (
              <div className="text-center text-gray-400 py-10">Loading…</div>
            ) : historyBills.length === 0 ? (
              <div className="text-center text-gray-400 py-10">No {billType}s found</div>
            ) : (
              <div className="bg-white rounded-xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                      {['Date','Bill No','Customer','Total','Status'].map(h => (
                        <th key={h} className="px-3 py-2 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyBills.map(b => (
                      <tr key={b.id} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                        <td className="px-3 py-2 font-mono font-medium">
                          <Link href={`/billing/${b.id}`} className="text-blue-700 hover:underline">
                            {b.bill_no}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-gray-600">{b.customer_name || '—'}</td>
                        <td className="px-3 py-2 font-medium text-right">₹{Number(b.total).toFixed(2)}</td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            b.payment_status === 'paid' ? 'bg-green-100 text-green-700'
                            : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-gray-100 text-gray-600'
                          }`}>{b.payment_status || 'draft'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Customer row, items, footer (form view only) ─────────── */}
        {view === 'form' && (<>
        {/* ── Customer row ────────────────────────────────────────────── */}
        <div className="bg-white border-b px-4 py-2 flex flex-wrap gap-3 flex-shrink-0">
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400 whitespace-nowrap">Customer:</span>
            <input value={customer.name} onChange={e => setCustomer(c => ({ ...c, name: e.target.value }))}
              placeholder="Name (optional)" className="border rounded px-2 py-1 text-sm w-40" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400 whitespace-nowrap">Phone:</span>
            <input value={customer.phone} onChange={e => setCustomer(c => ({ ...c, phone: e.target.value }))}
              placeholder="Phone" className="border rounded px-2 py-1 text-sm w-32" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400 whitespace-nowrap">GSTIN:</span>
            <input value={customer.gstin}
              onChange={e => setCustomer(c => ({ ...c, gstin: e.target.value.toUpperCase().slice(0, 15) }))}
              placeholder="Customer GSTIN" maxLength={15}
              className="border rounded px-2 py-1 text-sm w-40 font-mono uppercase" />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400 whitespace-nowrap">Address:</span>
            <input value={customer.address} onChange={e => setCustomer(c => ({ ...c, address: e.target.value }))}
              placeholder="Address" className="border rounded px-2 py-1 text-sm w-48" />
          </div>
        </div>

        {/* ── Bill items table ─────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-4 pt-3">
          <div className="table-scroll">
          <table className="w-full min-w-[640px] bg-white border rounded-lg text-sm border-collapse billing-table">
            <thead>
              <tr className="bg-gray-100 text-gray-600 text-xs">
                <th className="px-2 py-2 text-left w-8">#</th>
                <th className="px-2 py-2 text-left">Product Name</th>
                <th className="px-2 py-2 text-center w-16">HSN</th>
                <th className="px-2 py-2 text-center w-20">Qty</th>
                <th className="px-2 py-2 text-center w-14">Unit</th>
                <th className="px-2 py-2 text-right w-24">Rate (₹)</th>
                <th className="px-2 py-2 text-center w-16">GST%</th>
                <th className="px-2 py-2 text-center w-16">Disc%</th>
                <th className="px-2 py-2 text-right w-24">Amount (₹)</th>
                <th className="px-2 py-2 w-7"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={item._id}
                  onClick={() => setActiveRow(i)}
                  className={`border-t transition-colors ${
                    i === activeRow ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-2 py-1 text-gray-400 text-xs">{i + 1}</td>

                  {/* Product name / search button */}
                  <td className="px-2 py-1">
                    <button
                      className={`text-left w-full truncate ${
                        item.product_name
                          ? 'font-medium text-gray-900'
                          : 'text-gray-400 italic text-xs'
                      }`}
                      onClick={e => { e.stopPropagation(); openSearch(i) }}
                      onFocus={() => setActiveRow(i)}
                      tabIndex={0}
                      title="Press F3 or / to search"
                    >
                      {item.product_name || 'Press F3 or / to search product…'}
                    </button>
                    {/* Low / out-of-stock warning */}
                    {item.stock_qty !== undefined && item.stock_qty !== null && (
                      item.stock_qty <= 0
                        ? <div className="text-xs text-red-500 leading-tight mt-0.5">⚠ Out of stock</div>
                        : item.min_stock > 0 && item.stock_qty <= item.min_stock
                          ? <div className="text-xs text-yellow-600 leading-tight mt-0.5">⚡ Low stock ({item.stock_qty} left)</div>
                          : null
                    )}
                  </td>

                  {/* HSN */}
                  <td className="px-1 py-1">
                    <input
                      value={item.hsn_code}
                      onChange={e => updateItem(i, 'hsn_code', e.target.value)}
                      onFocus={() => setActiveRow(i)}
                      className="w-full border rounded px-1 py-0.5 text-xs text-center"
                      placeholder="HSN"
                    />
                  </td>

                  {/* Qty */}
                  <td className="px-1 py-1">
                    <input
                      id={`qty-${i}`}
                      type="number"
                      value={item.quantity}
                      onChange={e => updateItem(i, 'quantity', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                          e.preventDefault()
                          focusId(`rate-${i}`)
                        }
                      }}
                      className="w-full border rounded px-1 py-0.5 text-center"
                      min="0" step="0.001"
                    />
                  </td>

                  {/* Unit */}
                  <td className="px-1 py-1 text-center text-xs text-gray-500">{item.unit}</td>

                  {/* Rate */}
                  <td className="px-1 py-1">
                    <input
                      id={`rate-${i}`}
                      type="number"
                      value={item.rate}
                      onChange={e => updateItem(i, 'rate', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                          e.preventDefault()
                          focusId(`disc-${i}`)
                        }
                      }}
                      className="w-full border rounded px-1 py-0.5 text-right"
                      min="0" step="0.01"
                    />
                  </td>

                  {/* GST% */}
                  <td className="px-1 py-1">
                    <select
                      value={item.gst_rate}
                      onChange={e => updateItem(i, 'gst_rate', parseFloat(e.target.value))}
                      onFocus={() => setActiveRow(i)}
                      className="w-full border rounded px-1 py-0.5 text-center text-xs"
                    >
                      {GST_RATES.map(r => (
                        <option key={r} value={r}>{r}%</option>
                      ))}
                    </select>
                  </td>

                  {/* Discount % */}
                  <td className="px-1 py-1">
                    <input
                      id={`disc-${i}`}
                      type="number"
                      value={item.discount_pct}
                      onChange={e => updateItem(i, 'discount_pct', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addRow()
                        }
                      }}
                      className="w-full border rounded px-1 py-0.5 text-center"
                      min="0" max="100" step="0.01" placeholder="0"
                    />
                  </td>

                  {/* Amount */}
                  <td className="px-2 py-1 text-right font-medium">
                    {item.total > 0 ? fmt(item.total) : '—'}
                  </td>

                  {/* Delete */}
                  <td className="px-1 py-1 text-center">
                    <button
                      onClick={e => { e.stopPropagation(); deleteRow(i) }}
                      className="text-red-400 hover:text-red-600 leading-none"
                      tabIndex={-1}
                      title="Delete row (Ctrl+D)"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button
            onClick={addRow}
            className="mt-2 text-sm text-blue-600 hover:text-blue-800 hover:underline"
          >
            + Add Row &nbsp;<kbd className="text-xs">F4</kbd>
          </button>
          </div>{/* end table-scroll */}
        </div>

        {/* ── Footer: payment + totals + actions ──────────────────────── */}
        <div className="flex-shrink-0 border-t bg-white px-4 py-3 flex flex-col md:flex-row gap-4">

          {/* Left: notes + payment */}
          <div className="flex-1 space-y-2">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full border rounded px-2 py-1 text-sm resize-none"
            />
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Payment Mode</div>
                <select
                  value={payMode}
                  onChange={e => setPayMode(e.target.value)}
                  className="border rounded px-2 py-1 text-sm"
                >
                  {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Paid Amount</div>
                <input
                  type="number"
                  value={paidAmt}
                  onChange={e => setPaidAmt(e.target.value)}
                  placeholder={String(totals.total)}
                  className="border rounded px-2 py-1 text-sm w-28"
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => handleSave(true)}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50 text-sm"
              >
                {saving ? 'Saving…' : 'F8: Save + Print'}
              </button>
              <button
                onClick={() => handleSave(false)}
                disabled={saving}
                className="px-4 py-2 bg-green-600 text-white rounded font-medium hover:bg-green-700 disabled:opacity-50 text-sm"
              >
                F9: Save
              </button>
              <button
                onClick={handleNewBill}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded font-medium hover:bg-gray-300 text-sm"
              >
                F2: New Bill
              </button>
            </div>
          </div>

          {/* Right: totals box */}
          <div className="w-64 bg-gray-50 border rounded-lg px-4 py-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Subtotal (excl. GST)</span>
              <span>{fmt(totals.subtotal)}</span>
            </div>
            {totals.discountAmount > 0 && (
              <div className="flex justify-between text-red-500">
                <span>Discount</span>
                <span>– {fmt(totals.discountAmount)}</span>
              </div>
            )}
            {Object.entries(totals.gstBreakdown || {})
              .filter(([r, d]) => r !== '0' && d.gst > 0)
              .map(([r, d]) => (
                <div key={r} className="flex justify-between text-gray-500 text-xs">
                  <span>GST {r}% (CGST {r/2}% + SGST {r/2}%)</span>
                  <span>{fmt(d.gst)}</span>
                </div>
              ))}
            <div className="flex justify-between">
              <span className="text-gray-500">Total GST</span>
              <span>{fmt(totals.gstAmount)}</span>
            </div>
            <div className="flex justify-between font-bold text-lg border-t pt-2 mt-1">
              <span>Total</span>
              <span className="text-blue-700">{fmt(totals.total)}</span>
            </div>
            {paidAmt && parseFloat(paidAmt) < totals.total && (
              <div className="flex justify-between text-orange-600 text-xs">
                <span>Balance due</span>
                <span>{fmt(totals.total - parseFloat(paidAmt))}</span>
              </div>
            )}
            <div className="text-xs text-gray-400 italic pt-1">
              {filledItems.length} item{filledItems.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        </>)}
      </div>
    </>
  )
}
