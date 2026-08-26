'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { calcItem, calcBillTotals, fmt, GST_RATES } from '@/lib/gst'
import { todayStr } from '@/lib/finance'
import ProductSearch from '@/components/ProductSearch'
import BillScanner from '@/components/BillScanner'
import { useShop } from '@/context/ShopContext'
import {
  enqueuePendingAction,
  listPendingActions,
  makeTempBillNo,
  removePendingAction,
  updatePendingAction,
} from '@/lib/offlineBilling'

function isOnline() {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

let _uid = 0
function uid() { return ++_uid }

function emptyItem() {
  return {
    _id: uid(), product_id: null, product_name: '', hsn_code: '',
    unit: 'pcs', quantity: '', rate: '', mrp: '', gst_rate: 0,
    base_amount: 0, gst_amount: 0, total: 0,
  }
}

function focusId(id) {
  setTimeout(() => { const el = document.getElementById(id); if (el) { el.focus(); el.select?.() } }, 30)
}

export default function NewPurchasePage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [items,      setItems]     = useState([emptyItem()])
  const [suppId,     setSuppId]    = useState('')
  const [suppInv,    setSuppInv]   = useState('')
  const [date,       setDate]      = useState(todayStr())
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
  const [editPurchaseId, setEditPurchaseId] = useState(null)
  const [offlineNotice, setOfflineNotice] = useState('')
  const syncInProgressRef = useRef(false)

  useEffect(() => {
    if (!shop?.id) return
    if (!isOnline()) {
      setSuppliers([])
      setSettings(null)
      return
    }

    supabase.from('suppliers').select('id,name').eq('is_active', true).order('name')
      .then(({ data }) => setSuppliers(data || []))
      .catch(() => setSuppliers([]))
    supabase.from('shops').select('*').eq('id', shop?.id || '').single()
      .then(({ data }) => setSettings(data))
      .catch(() => setSettings(null))
  }, [shop?.id])

  useEffect(() => {
    const editId = searchParams.get('editId')
    if (!editId || !shop?.id) return

    let cancelled = false
    async function loadForEdit() {
      const [{ data: b, error: bErr }, { data: lines, error: lErr }] = await Promise.all([
        supabase
          .from('purchase_bills')
          .select('*')
          .eq('id', editId)
          .eq('shop_id', shop.id)
          .single(),
        supabase
          .from('purchase_bill_items')
          .select('id,product_id,product_name,hsn_code,unit,quantity,rate,mrp,gst_rate,gst_amount,total,sl_no')
          .eq('purchase_bill_id', editId)
          .eq('shop_id', shop.id)
          .order('sl_no'),
      ])

      if (cancelled) return
      if (bErr) { showToast('Load failed: ' + bErr.message, 'error'); return }
      if (lErr) { showToast('Load failed: ' + lErr.message, 'error'); return }

      setEditPurchaseId(editId)
      setSuppId(b.supplier_id || '')
      setSuppInv(b.supplier_invoice_no || '')
      setDate(b.date || todayStr())
      setPayMode(b.payment_mode ? b.payment_mode.charAt(0).toUpperCase() + b.payment_mode.slice(1) : 'Credit')
      setPaidAmt(String(b.paid_amount ?? ''))
      setNotes(b.notes || '')

      const loaded = (lines || []).map((it) => ({
        _id: uid(),
        product_id: it.product_id || null,
        product_name: it.product_name || '',
        hsn_code: it.hsn_code || '',
        unit: it.unit || 'pcs',
        quantity: it.quantity ?? 1,
        rate: it.rate ?? 0,
        mrp: it.mrp ?? 0,
        gst_rate: it.gst_rate ?? 0,
        base_amount: (Number(it.total || 0) - Number(it.gst_amount || 0)),
        gst_amount: it.gst_amount ?? 0,
        total: it.total ?? 0,
      }))
      setItems(loaded.length ? loaded : [emptyItem()])
      setActiveRow(0)
    }

    loadForEdit()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, shop?.id])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    if (!shop?.id || !isOnline()) return

    let cancelled = false
    async function syncQueue() {
      if (syncInProgressRef.current) return
      syncInProgressRef.current = true
      try {
        const queue = await listPendingActions(shop.id, 'purchase-bill')
        for (const record of queue) {
          if (cancelled) return
          await updatePendingAction(record.id, { status: 'syncing' })

          const prefix = settings?.purchase_prefix || shop?.purchase_prefix || 'PUR'
          let billNo = record.purchaseRow?.bill_no || ''
          if (!billNo || String(billNo).startsWith('OFF-')) {
            try {
              const { data: generatedNo, error: noErr } = await supabase.rpc('get_next_purchase_no', {
                p_shop_id: shop.id,
                p_prefix: prefix,
              })
              if (noErr) throw noErr
              billNo = generatedNo || `${prefix}-${Date.now()}`
            } catch {
              billNo = billNo || `${prefix}-${Date.now()}`
            }
          }

          const purchaseRow = {
            ...record.purchaseRow,
            bill_no: billNo,
          }

          const { data: saved, error: billErr } = await supabase.from('purchase_bills').insert(purchaseRow).select().single()
          if (billErr) throw billErr

          const syncedLineItems = (record.lineItems || []).map((item, i) => ({
            shop_id: shop.id,
            purchase_bill_id: saved.id,
            product_id: item.product_id,
            sl_no: i + 1,
            product_name: item.product_name,
            hsn_code: item.hsn_code || null,
            unit: item.unit,
            quantity: parseFloat(item.quantity) || 1,
            rate: parseFloat(item.rate) || 0,
            mrp: parseFloat(item.mrp) || 0,
            base_rate: (parseFloat(item.rate) || 0) / (1 + (item.gst_rate || 0) / 100),
            gst_rate: item.gst_rate || 0,
            gst_amount: item.gst_amount || 0,
            total: item.total || 0,
          }))

          const { error: itemsErr } = await supabase.from('purchase_bill_items').insert(syncedLineItems)
          if (itemsErr) throw itemsErr

          await removePendingAction(record.id)
        }
      } catch (error) {
        console.warn('Purchase queue sync failed:', error)
      } finally {
        syncInProgressRef.current = false
      }
    }

    syncQueue()
    window.addEventListener('online', syncQueue)
    return () => {
      cancelled = true
      window.removeEventListener('online', syncQueue)
    }
  }, [shop?.id, settings?.purchase_prefix])

  function recalc(item) {
    if (!item.product_id && !item.product_name) return item
    const c = calcItem(parseFloat(item.rate) || 0, parseFloat(item.quantity) || 0, parseFloat(item.gst_rate) || 0, 0)
    return { ...item, ...c }
  }

  function updateItem(i, field, value) {
    setItems(prev => { const n = [...prev]; n[i] = recalc({ ...n[i], [field]: value }); return n })
  }

  const openSearch = useCallback((idx) => { setActiveRow(idx); setSearchOpen(true) }, [])

  function handleProductSelect(product) {
    const rate = product.purchase_price || product.mrp || 0
    const mrp = product.mrp || rate
    setItems(prev => {
      const n = [...prev]
      n[activeRow] = recalc({
        ...n[activeRow],
        product_id: product.id, product_name: product.name,
        hsn_code: product.hsn_code || '', unit: product.unit || 'pcs',
        rate, mrp, gst_rate: product.gst_rate || 0, quantity: 1,
      })
      return n
    })
    setSearchOpen(false)
    focusId(`qty-${activeRow}`)
  }

  function handleFreeTextItem(name) {
    setItems(prev => {
      const n = [...prev]
      n[activeRow] = {
        ...n[activeRow],
        product_id:   null,
        product_name: name,
        unit:         'pcs',
        quantity:     1,
        rate:         '',
        mrp:          '',
        gst_rate:     0,
        base_amount:  0,
        gst_amount:   0,
        total:        0,
      }
      return n
    })
    setSearchOpen(false)
    focusId(`rate-${activeRow}`)
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

  const filledItems = items.filter(i => i.product_id || (i.product_name && parseFloat(i.rate) > 0))
  const totals = calcBillTotals(filledItems)

  // ── AI scan apply ─────────────────────────────────────────────────────────
  function handleScanApply(scanResult) {
    if (!scanResult?.items?.length) return
    const newItems = scanResult.items.map(item => {
      const base = emptyItem()
      const calc = calcItem(item.rate || 0, item.quantity || 1, item.gst_rate || 0, 0)
      return { ...base, product_name: item.name, hsn_code: item.hsn_code || '',
        unit: item.unit || 'pcs', quantity: item.quantity || 1,
        rate: item.rate || 0, mrp: item.mrp || item.rate || 0, gst_rate: item.gst_rate || 0, ...calc }
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
      const prefix = settings?.purchase_prefix || shop?.purchase_prefix || 'PUR'
      const paid = parseFloat(paidAmt) || 0
      if (!isOnline()) {
        if (editPurchaseId) throw new Error('Editing purchases offline is not available yet')
        const tempNo = makeTempBillNo('OFF')
        const purchaseRow = {
          shop_id:            shop.id,
          bill_no:            tempNo,
          supplier_id:        suppId || null,
          supplier_invoice_no: suppInv || null,
          date,
          subtotal: totals.subtotal,
          gst_amount: totals.gstAmount,
          total: totals.total,
          paid_amount: paid,
          payment_mode: payMode.toLowerCase(),
          payment_status: paid >= totals.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
          notes: notes || null,
        }
        await enqueuePendingAction(shop.id, {
          type: 'purchase-bill',
          purchaseRow,
          lineItems: filledItems.map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            hsn_code: item.hsn_code || null,
            unit: item.unit,
            quantity: parseFloat(item.quantity) || 1,
            rate: parseFloat(item.rate) || 0,
            mrp: parseFloat(item.mrp) || 0,
            gst_rate: item.gst_rate || 0,
            gst_amount: item.gst_amount || 0,
            total: item.total || 0,
          })),
        })
        showToast(`✓ ${tempNo} saved offline. It will sync when internet returns.`)
        setOfflineNotice('Offline mode: purchase queued for sync')
        setItems([emptyItem()])
        setSuppId('')
        setSuppInv('')
        setNotes('')
        setPaidAmt('')
        setPayMode('Credit')
        setEditPurchaseId(null)
        return
      }

      let no = ''
      if (!editPurchaseId) {
        const { data: generatedNo } = await supabase.rpc('get_next_purchase_no', {
          p_shop_id: shop.id,
          p_prefix: prefix,
        })
        no = generatedNo || `${prefix}-${Date.now()}`
      } else {
        const { data: current } = await supabase
          .from('purchase_bills')
          .select('bill_no')
          .eq('id', editPurchaseId)
          .eq('shop_id', shop.id)
          .single()
        no = current?.bill_no || no
      }
      if (!no) throw new Error('Purchase number could not be generated')
      const purchaseRow = {
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
      }

      let purchaseId = editPurchaseId
      if (editPurchaseId) {
        const { error: updErr } = await supabase
          .from('purchase_bills')
          .update(purchaseRow)
          .eq('id', editPurchaseId)
          .eq('shop_id', shop.id)
        if (updErr) throw updErr
      } else {
        const { data: saved, error: err } = await supabase.from('purchase_bills').insert(purchaseRow).select().single()
        if (err) throw err
        purchaseId = saved.id
      }

      if (editPurchaseId) {
        const { error: delErr } = await supabase
          .from('purchase_bill_items')
          .delete()
          .eq('purchase_bill_id', editPurchaseId)
          .eq('shop_id', shop.id)
        if (delErr) throw delErr
      }

      await supabase.from('purchase_bill_items').insert(
        filledItems.map((item, i) => ({
          shop_id:         shop.id,
          purchase_bill_id: purchaseId,
          product_id: item.product_id,
          sl_no: i + 1,
          product_name: item.product_name,
          hsn_code: item.hsn_code || null,
          unit: item.unit,
          quantity: parseFloat(item.quantity) || 1,
          rate: parseFloat(item.rate) || 0,
          mrp: parseFloat(item.mrp) || 0,
          base_rate: (parseFloat(item.rate) || 0) / (1 + (item.gst_rate || 0) / 100),
          gst_rate: item.gst_rate || 0,
          gst_amount: item.gst_amount || 0,
          total: item.total || 0,
        }))
      )

      showToast(editPurchaseId ? `✓ ${no} updated` : `✓ ${no} saved`)
      setTimeout(() => router.push(`/purchases/${purchaseId}`), 700)
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
      {searchOpen && <ProductSearch onSelect={handleProductSelect} onAddFreeText={handleFreeTextItem} onClose={() => setSearchOpen(false)} />}
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
            <h1 className="text-lg font-bold">{editPurchaseId ? 'Edit Purchase Entry' : 'New Purchase Entry'}</h1>
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

        {offlineNotice && (
          <div className="mx-4 mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
            {offlineNotice}
          </div>
        )}

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
          <table className="w-full min-w-[600px] bg-white border rounded-lg text-sm border-collapse">
            <thead>
              <tr className="bg-gray-100 text-gray-600 text-xs">
                <th className="px-2 py-2 text-left w-8">#</th>
                <th className="px-2 py-2 text-left">Product Name</th>
                <th className="px-2 py-2 text-center w-16">HSN</th>
                <th className="px-2 py-2 text-center w-20">Qty</th>
                <th className="px-2 py-2 text-center w-14">Unit</th>
                <th className="px-2 py-2 text-right w-24">Rate (₹)</th>
                <th className="px-2 py-2 text-right w-24">MRP (₹)</th>
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
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); focusId(`mrp-${i}`) } }}
                      className="w-full border rounded px-1 py-0.5 text-right" min="0" step="0.01" />
                  </td>
                  <td className="px-1 py-1">
                    <input id={`mrp-${i}`} type="number" value={item.mrp}
                      onChange={e => updateItem(i, 'mrp', e.target.value)}
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
                {saving ? 'Saving…' : editPurchaseId ? 'F8: Update Purchase' : 'F8: Save Purchase'}
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
