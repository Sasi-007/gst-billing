'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { calcItem, calcBillTotals, fmt, GST_RATES } from '@/lib/gst'
import ProductSearch from '@/components/ProductSearch'
import BillScanner from '@/components/BillScanner'
import { useShop } from '@/context/ShopContext'

let _uid = 0
function uid() { return ++_uid }

function emptyItem() {
  return {
    _id: uid(), product_id: null, product_name: '', hsn_code: '',
    unit: 'pcs', quantity: '', rate: '', gst_rate: 0,
    base_amount: 0, gst_amount: 0, total: 0,
  }
}

function focusId(id) {
  setTimeout(() => { const el = document.getElementById(id); if (el) { el.focus(); el.select?.() } }, 30)
}

export default function NewPurchasePage() {
  const router = useRouter()

  const [items,      setItems]     = useState([emptyItem()])
  const [suppId,     setSuppId]    = useState('')
  const [suppInv,    setSuppInv]   = useState('')
  const [date,       setDate]      = useState(new Date().toISOString().slice(0, 10))
  const [payMode,    setPayMode]   = useState('Credit')
  const [paidAmt,    setPaidAmt]   = useState('')
  const [notes,      setNotes]     = useState('')
  const [suppliers,  setSuppliers] = useState([])
  const [settings,   setSettings]  = useState(null)

  const { shop } = useShop()

  const [searchOpen, setSearchOpen] = useState(false)
  const [activeRow,  setActiveRow]  = useState(0)
  const [saving,     setSaving]     = useState(false)
  const [toast,      setToast]      = useState(null)

  useEffect(() => {
    supabase.from('suppliers').select('id,name').eq('is_active', true).order('name').then(({ data }) => setSuppliers(data || []))
    supabase.from('settings').select('*').single().then(({ data }) => setSettings(data))
  }, [])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  function recalc(item) {
    if (!item.product_id) return item
    const c = calcItem(parseFloat(item.rate) || 0, parseFloat(item.quantity) || 0, parseFloat(item.gst_rate) || 0, 0)
    return { ...item, ...c }
  }

  function updateItem(i, field, value) {
    setItems(prev => { const n = [...prev]; n[i] = recalc({ ...n[i], [field]: value }); return n })
  }

  const openSearch = useCallback((idx) => { setActiveRow(idx); setSearchOpen(true) }, [])

  function handleProductSelect(product) {
    const rate = product.purchase_price || product.mrp || 0
    setItems(prev => {
      const n = [...prev]
      n[activeRow] = recalc({
        ...n[activeRow],
        product_id: product.id, product_name: product.name,
        hsn_code: product.hsn_code || '', unit: product.unit || 'pcs',
        rate, gst_rate: product.gst_rate || 0, quantity: 1,
      })
      return n
    })
    setSearchOpen(false)
    focusId(`qty-${activeRow}`)
  }

  function addRow() {
    const idx = items.length
    setItems(prev => [...prev, emptyItem()])
    setActiveRow(idx)
    setTimeout(() => openSearch(idx), 60)
  }

  function deleteRow(i) {
    if (items.length === 1) { setItems([emptyItem()]); return }
    setItems(prev => prev.filter((_, j) => j !== i))
    setActiveRow(Math.max(0, i - 1))
  }

  const filledItems = items.filter(i => i.product_id)
  const totals = calcBillTotals(filledItems)

  // ── AI scan apply ─────────────────────────────────────────────────────────
  function handleScanApply(scanResult) {
    if (!scanResult?.items?.length) return
    const newItems = scanResult.items.map(item => {
      const base = emptyItem()
      const calc = calcItem(item.rate || 0, item.quantity || 1, item.gst_rate || 0, 0)
      return { ...base, product_name: item.name, hsn_code: item.hsn_code || '',
        unit: item.unit || 'pcs', quantity: item.quantity || 1,
        rate: item.rate || 0, gst_rate: item.gst_rate || 0, ...calc }
    })
    setItems(newItems)
    if (scanResult.invoice_number) setSuppInv(scanResult.invoice_number)
    if (scanResult.invoice_date)   setDate(scanResult.invoice_date)
    // Try to match supplier by GSTIN
    if (scanResult.supplier_gstin) {
      const matched = suppliers.find(s =>
        s.gstin?.toUpperCase() === scanResult.supplier_gstin?.toUpperCase())
      if (matched) setSuppId(matched.id)
    }
  }

  async function handleSave() {
    if (filledItems.length === 0) { showToast('Add at least one item', 'error'); return }
    setSaving(true)
    try {
      const { data: no } = await supabase.rpc('get_next_purchase_no', {
        p_shop_id: shop.id,
        p_prefix: settings?.purchase_prefix || shop?.purchase_prefix || 'PUR',
      })
      const paid = parseFloat(paidAmt) || 0

      const { data: saved, error: err } = await supabase.from('purchase_bills').insert({
        shop_id:            shop.id,
        bill_no:            no,
        supplier_id: suppId || null,
        supplier_invoice_no: suppInv || null,
        date,
        subtotal: totals.subtotal,
        gst_amount: totals.gstAmount,
        total: totals.total,
        paid_amount: paid,
        payment_mode: payMode.toLowerCase(),
        payment_status: paid >= totals.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
        notes: notes || null,
      }).select().single()

      if (err) throw err

      await supabase.from('purchase_bill_items').insert(
        filledItems.map((item, i) => ({
          shop_id:         shop.id,
          purchase_bill_id: saved.id,
          product_id: item.product_id,
          sl_no: i + 1,
          product_name: item.product_name,
          hsn_code: item.hsn_code || null,
          unit: item.unit,
          quantity: parseFloat(item.quantity) || 1,
          rate: parseFloat(item.rate) || 0,
          base_rate: (parseFloat(item.rate) || 0) / (1 + (item.gst_rate || 0) / 100),
          gst_rate: item.gst_rate || 0,
          gst_amount: item.gst_amount || 0,
          total: item.total || 0,
        }))
      )

      showToast(`✓ ${no} saved`)
      setTimeout(() => router.push('/purchases'), 1000)
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (searchOpen) return
      if (e.key === 'F3' || (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))) {
        e.preventDefault(); openSearch(activeRow)
      }
      if (e.key === 'F4') { e.preventDefault(); addRow() }
      if (e.key === 'F8') { e.preventDefault(); handleSave() }
      if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); deleteRow(activeRow) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, activeRow, items, settings, filledItems, totals])

  return (
    <>
      {searchOpen && <ProductSearch onSelect={handleProductSelect} onClose={() => setSearchOpen(false)} />}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg shadow text-white text-sm font-medium ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
        }`}>{toast.msg}</div>
      )}

      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="bg-white border-b px-4 py-2 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => router.back()} className="text-gray-500 text-sm hover:text-gray-700">← Back</button>
            <h1 className="text-lg font-bold">New Purchase Entry</h1>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-500">Date</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="border rounded px-2 py-1 text-sm" />
          </div>
        </div>

        <div className="bg-blue-700 text-white text-xs px-4 py-1 flex gap-4 flex-shrink-0">
          <span><kbd>F3</kbd> or <kbd>/</kbd> Search</span>
          <span><kbd>F4</kbd> Add Row</span>
          <span><kbd>F8</kbd> Save</span>
          <span><kbd>Ctrl+D</kbd> Delete Row</span>
        </div>

        {/* Supplier row */}
        <div className="bg-white border-b px-4 py-2 flex flex-wrap gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Supplier:</span>
            <select value={suppId} onChange={e => setSuppId(e.target.value)}
              className="border rounded px-2 py-1 text-sm w-48">
              <option value="">— Walk-in / Unknown —</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Supplier Invoice No:</span>
            <input value={suppInv} onChange={e => setSuppInv(e.target.value)}
              placeholder="e.g. SUP-1234"
              className="border rounded px-2 py-1 text-sm w-36" />
          </div>
        </div>

        {/* AI Bill Scanner */}
        <div className="px-4 pt-3">
          <BillScanner onApply={handleScanApply} />
        </div>

        {/* Items table */}
        <div className="flex-1 overflow-y-auto px-4 pt-3">
          <table className="w-full bg-white border rounded-lg text-sm border-collapse">
            <thead>
              <tr className="bg-gray-100 text-gray-600 text-xs">
                <th className="px-2 py-2 text-left w-8">#</th>
                <th className="px-2 py-2 text-left">Product Name</th>
                <th className="px-2 py-2 text-center w-16">HSN</th>
                <th className="px-2 py-2 text-center w-20">Qty</th>
                <th className="px-2 py-2 text-center w-14">Unit</th>
                <th className="px-2 py-2 text-right w-24">Rate (₹)</th>
                <th className="px-2 py-2 text-center w-16">GST%</th>
                <th className="px-2 py-2 text-right w-24">Amount (₹)</th>
                <th className="px-2 py-2 w-7"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={item._id} onClick={() => setActiveRow(i)}
                  className={`border-t ${i === activeRow ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <td className="px-2 py-1 text-gray-400 text-xs">{i + 1}</td>
                  <td className="px-2 py-1">
                    <button
                      className={`text-left w-full truncate ${item.product_name ? 'font-medium' : 'text-gray-400 italic text-xs'}`}
                      onClick={e => { e.stopPropagation(); openSearch(i) }}
                    >
                      {item.product_name || 'Press F3 to search product…'}
                    </button>
                  </td>
                  <td className="px-1 py-1">
                    <input value={item.hsn_code} onChange={e => updateItem(i, 'hsn_code', e.target.value)}
                      className="w-full border rounded px-1 py-0.5 text-xs text-center" placeholder="HSN" />
                  </td>
                  <td className="px-1 py-1">
                    <input id={`qty-${i}`} type="number" value={item.quantity}
                      onChange={e => updateItem(i, 'quantity', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); focusId(`rate-${i}`) } }}
                      className="w-full border rounded px-1 py-0.5 text-center" min="0" step="0.001" />
                  </td>
                  <td className="px-1 py-1 text-center text-xs text-gray-500">{item.unit}</td>
                  <td className="px-1 py-1">
                    <input id={`rate-${i}`} type="number" value={item.rate}
                      onChange={e => updateItem(i, 'rate', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRow() } }}
                      className="w-full border rounded px-1 py-0.5 text-right" min="0" step="0.01" />
                  </td>
                  <td className="px-1 py-1">
                    <select value={item.gst_rate} onChange={e => updateItem(i, 'gst_rate', parseFloat(e.target.value))}
                      className="w-full border rounded px-1 py-0.5 text-center text-xs">
                      {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right font-medium">{item.total > 0 ? fmt(item.total) : '—'}</td>
                  <td className="px-1 py-1 text-center">
                    <button onClick={e => { e.stopPropagation(); deleteRow(i) }}
                      className="text-red-400 hover:text-red-600" tabIndex={-1}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={addRow} className="mt-2 text-sm text-blue-600 hover:underline">
            + Add Row <kbd className="text-xs">F4</kbd>
          </button>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 border-t bg-white px-4 py-3 flex gap-4">
          <div className="flex-1 space-y-2">
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Notes" rows={2}
              className="w-full border rounded px-2 py-1 text-sm resize-none" />
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Payment Mode</div>
                <select value={payMode} onChange={e => setPayMode(e.target.value)}
                  className="border rounded px-2 py-1 text-sm">
                  {['Credit','Cash','UPI','Card','Cheque'].map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Paid Now ₹</div>
                <input type="number" value={paidAmt} onChange={e => setPaidAmt(e.target.value)}
                  placeholder="0" className="border rounded px-2 py-1 text-sm w-28" />
              </div>
              <button onClick={handleSave} disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50 text-sm">
                {saving ? 'Saving…' : 'F8: Save Purchase'}
              </button>
            </div>
          </div>
          <div className="w-56 bg-gray-50 border rounded-lg px-4 py-3 space-y-1 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>Subtotal</span><span>{fmt(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>GST</span><span>{fmt(totals.gstAmount)}</span>
            </div>
            <div className="flex justify-between font-bold text-base border-t pt-1">
              <span>Total</span><span className="text-blue-700">{fmt(totals.total)}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
