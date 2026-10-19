'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { calcPurchaseItem, calcBillTotals } from '@/lib/gst'
import { csvHeaders, csvRowsToObjects, parseCsvDate } from '@/lib/csv'
import { invalidatePurchaseImpactCache, syncProductPricingFromLatestPurchases } from '@/lib/productStock'
import { syncPurchaseCreditEntry } from '@/lib/purchaseCredit'
import { todayStr } from '@/lib/finance'

const FILE_KINDS = {
  purchases: 'Purchases (bill headers)',
  items: 'Purchase items (bill lines)',
  suppliers: 'Suppliers',
  inventory: 'Inventory (products)',
}

function detectKind(headers) {
  const has = (name) => headers.includes(name)
  if (has('bill_no') && has('product_name')) return 'items'
  if (has('bill no')) return 'purchases'
  if (has('name') && has('mrp')) return 'inventory'
  if (has('name') && (has('gstin') || has('contact_person'))) return 'suppliers'
  return null
}

function num(value) {
  const parsed = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function lower(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizePaymentMode(value) {
  const mode = lower(value)
  if (!mode) return 'credit'
  if (mode === 'gpay') return 'upi'
  return mode
}

function paymentStatusFor(total, paid) {
  if (paid >= total && total > 0) return 'paid'
  if (paid > 0) return 'partial'
  return 'unpaid'
}

export default function PurchaseImportPanel({ shopId, onClose, onImported }) {
  const [filesByKind, setFilesByKind] = useState({})
  const [unknownFiles, setUnknownFiles] = useState([])
  const [replaceStock, setReplaceStock] = useState(false)
  const [existingMode, setExistingMode] = useState('update')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState(false)
  const resultRef = useRef(null)

  // The report renders near the bottom of a scrollable body, so bring it into
  // view instead of leaving the user staring at the file list.
  useEffect(() => {
    if (report || error) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [report, error])

  const detectedKinds = useMemo(() => Object.keys(filesByKind), [filesByKind])
  // Block a second click on Import once a run finished, otherwise the same files
  // would be re-imported (products updated again, stock added twice).
  const canImport = detectedKinds.length > 0 && !running && !completed

  async function handleFiles(event) {
    const picked = Array.from(event.target.files || [])
    event.target.value = ''
    if (!picked.length) return

    setError('')
    setReport(null)
    setCompleted(false)
    const nextFiles = { ...filesByKind }
    const nextUnknown = []

    for (const file of picked) {
      try {
        const text = await file.text()
        const kind = detectKind(csvHeaders(text))
        if (!kind) {
          nextUnknown.push(file.name)
          continue
        }
        nextFiles[kind] = { name: file.name, rows: csvRowsToObjects(text) }
      } catch {
        nextUnknown.push(file.name)
      }
    }

    setFilesByKind(nextFiles)
    setUnknownFiles(nextUnknown)
  }

  function removeKind(kind) {
    setFilesByKind((prev) => {
      const next = { ...prev }
      delete next[kind]
      return next
    })
  }

  function startNewImport() {
    setFilesByKind({})
    setUnknownFiles([])
    setReplaceStock(false)
    setExistingMode('update')
    setReport(null)
    setError('')
    setCompleted(false)
  }

  async function importSuppliers(rows, summary) {
    const named = rows.filter((row) => String(row.name || '').trim())
    if (!named.length) return

    const { data: existing, error: loadErr } = await supabase
      .from('suppliers')
      .select('id,name')
      .eq('shop_id', shopId)
    if (loadErr) throw loadErr

    const existingByName = new Map((existing || []).map((row) => [lower(row.name), row]))
    const inserts = []
    const queuedNames = new Set()

    for (const row of named) {
      const key = lower(row.name)
      // The same name can appear twice inside one CSV; queuing it twice would
      // insert a genuine duplicate because the DB row does not exist yet.
      if (queuedNames.has(key)) {
        summary.suppliersSkipped += 1
        continue
      }

      const payload = {
        name: String(row.name).trim(),
        contact_person: row.contact_person || null,
        phone: row.phone || null,
        email: row.email || null,
        gstin: row.gstin || null,
        address: row.address || null,
        city: row.city || null,
        state: row.state || null,
        pincode: row.pincode || null,
        is_active: lower(row.is_active) !== 'false',
      }
      const match = existingByName.get(key)
      if (match) {
        if (existingMode === 'skip') {
          summary.suppliersSkipped += 1
          continue
        }
        const { error: updErr } = await supabase
          .from('suppliers')
          .update(payload)
          .eq('shop_id', shopId)
          .eq('id', match.id)
        if (updErr) throw updErr
        summary.suppliersUpdated += 1
      } else {
        queuedNames.add(key)
        inserts.push({ ...payload, shop_id: shopId })
      }
    }

    if (inserts.length) {
      const { error: insErr } = await supabase.from('suppliers').insert(inserts)
      if (insErr) throw insErr
      summary.suppliersCreated += inserts.length
    }
  }

  async function resolveCategoryIds(rows) {
    const wanted = [...new Set(rows.map((row) => String(row.category || '').trim()).filter(Boolean))]
    if (!wanted.length) return new Map()

    const { data: existing, error: loadErr } = await supabase
      .from('categories')
      .select('id,name')
      .eq('shop_id', shopId)
    if (loadErr) throw loadErr

    const byName = new Map((existing || []).map((row) => [lower(row.name), row.id]))
    const missing = wanted.filter((name) => !byName.has(lower(name)))
    if (missing.length) {
      const { data: created, error: insErr } = await supabase
        .from('categories')
        .insert(missing.map((name) => ({ shop_id: shopId, name })))
        .select('id,name')
      if (insErr) throw insErr
      for (const row of created || []) byName.set(lower(row.name), row.id)
    }
    return byName
  }

  async function importProducts(rows, summary) {
    const named = rows.filter((row) => String(row.name || '').trim())
    if (!named.length) return

    const [categoryByName, { data: existing, error: loadErr }, { data: supplierRows, error: supErr }] = await Promise.all([
      resolveCategoryIds(named),
      supabase.from('products').select('id,name').eq('shop_id', shopId),
      supabase.from('suppliers').select('id,name').eq('shop_id', shopId),
    ])
    if (loadErr) throw loadErr
    if (supErr) throw supErr

    const existingByName = new Map((existing || []).map((row) => [lower(row.name), row]))
    const supplierByName = new Map((supplierRows || []).map((row) => [lower(row.name), row.id]))
    const inserts = []
    const queuedNames = new Set()

    for (const row of named) {
      const key = lower(row.name)
      if (queuedNames.has(key)) {
        summary.productsSkipped += 1
        continue
      }

      const payload = {
        name: String(row.name).trim(),
        local_name: row.local_name || null,
        brand: row.brand || null,
        category_id: categoryByName.get(lower(row.category)) || null,
        supplier_id: supplierByName.get(lower(row.supplier)) || null,
        barcode: row.barcode || null,
        unit: row.unit || 'pcs',
        hsn_code: row.hsn_code || null,
        gst_rate: num(row.gst_rate),
        purchase_price: num(row.purchase_price),
        mrp: num(row.mrp),
        selling_price: num(row.selling_price),
        min_stock: num(row.min_stock),
        is_active: lower(row.is_active) !== 'false',
      }
      const match = existingByName.get(key)
      if (match) {
        if (existingMode === 'skip') {
          summary.productsSkipped += 1
          continue
        }
        // Stock is normally driven by purchase and sale history, so it is only
        // overwritten when the user explicitly asks for it.
        const updatePayload = replaceStock ? { ...payload, stock_qty: num(row.stock_qty) } : payload
        const { error: updErr } = await supabase
          .from('products')
          .update({ ...updatePayload, last_price_source: 'import' })
          .eq('shop_id', shopId)
          .eq('id', match.id)
        if (updErr) throw updErr
        summary.productsUpdated += 1
      } else {
        queuedNames.add(key)
        inserts.push({
          ...payload,
          shop_id: shopId,
          stock_qty: replaceStock ? num(row.stock_qty) : 0,
        })
      }
    }

    if (inserts.length) {
      const { error: insErr } = await supabase.from('products').insert(inserts)
      if (insErr) throw insErr
      summary.productsCreated += inserts.length
    }
  }

  async function importBills(headerRows, itemRows, summary) {
    const headerByBillNo = new Map()
    for (const row of headerRows) {
      const billNo = String(row['bill no'] || '').trim()
      if (billNo) headerByBillNo.set(billNo, row)
    }

    const itemsByBillNo = new Map()
    for (const row of itemRows) {
      const billNo = String(row.bill_no || '').trim()
      if (!billNo || !String(row.product_name || '').trim()) continue
      if (!itemsByBillNo.has(billNo)) itemsByBillNo.set(billNo, [])
      itemsByBillNo.get(billNo).push(row)
    }

    const billNos = [...new Set([...headerByBillNo.keys(), ...itemsByBillNo.keys()])]
    if (!billNos.length) return

    const [{ data: existingBills, error: billErr }, { data: supplierRows, error: supErr }, { data: productRows, error: prodErr }] = await Promise.all([
      supabase.from('purchase_bills').select('bill_no').eq('shop_id', shopId).in('bill_no', billNos),
      supabase.from('suppliers').select('id,name,phone').eq('shop_id', shopId),
      supabase.from('products').select('id,name,hsn_code').eq('shop_id', shopId),
    ])
    if (billErr) throw billErr
    if (supErr) throw supErr
    if (prodErr) throw prodErr

    const existingBillNos = new Set((existingBills || []).map((row) => row.bill_no))
    const supplierByName = new Map((supplierRows || []).map((row) => [lower(row.name), row]))
    const productByName = new Map((productRows || []).map((row) => [lower(row.name), row]))
    const productsByHsn = new Map()
    for (const row of productRows || []) {
      const key = lower(row.hsn_code)
      if (!key) continue
      if (!productsByHsn.has(key)) productsByHsn.set(key, [])
      productsByHsn.get(key).push(row)
    }

    const touchedProductIds = new Set()

    for (const billNo of billNos) {
      if (existingBillNos.has(billNo)) {
        summary.billsSkipped.push(billNo)
        continue
      }

      const header = headerByBillNo.get(billNo) || {}
      const lines = itemsByBillNo.get(billNo) || []
      const supplier = supplierByName.get(lower(header.supplier)) || null

      const calculated = lines.map((line) => {
        const quantity = num(line.quantity) || 1
        const rate = num(line.base_rate)
        const gstRate = num(line.gst_rate)
        const amounts = calcPurchaseItem(
          rate,
          quantity,
          gstRate,
          num(line.scheme_discount),
          num(line.cash_discount),
          false,
          line.taxable_amount === '' ? null : line.taxable_amount,
        )
        const nameKey = lower(line.product_name)
        const hsnKey = lower(line.hsn_code)
        let product = productByName.get(nameKey) || null
        if (!product && hsnKey && productsByHsn.get(hsnKey)?.length === 1) {
          product = productsByHsn.get(hsnKey)[0]
        }
        return {
          product_id: product?.id || null,
          product_name: String(line.product_name).trim(),
          hsn_code: line.hsn_code || null,
          unit: line.unit || 'pcs',
          quantity,
          rate,
          mrp: num(line.mrp) || rate,
          gst_rate: gstRate,
          ...amounts,
        }
      })

      const totals = lines.length ? calcBillTotals(calculated) : null
      const subtotal = totals ? totals.subtotal : num(header.subtotal)
      const gstAmount = totals ? totals.gstAmount : num(header.gst)
      const total = totals ? totals.total : num(header.total)
      const paid = Math.min(total, num(header.paid))
      const billDate = parseCsvDate(header.date) || todayStr()

      const billRow = {
        shop_id: shopId,
        bill_no: billNo,
        supplier_id: supplier?.id || null,
        supplier_invoice_no: header['supplier invoice no'] || null,
        date: billDate,
        subtotal,
        gst_amount: gstAmount,
        total,
        paid_amount: paid,
        payment_mode: normalizePaymentMode(header['payment mode']),
        payment_status: paymentStatusFor(total, paid),
        notes: header.notes || null,
      }

      const { data: savedBill, error: insertErr } = await supabase
        .from('purchase_bills')
        .insert(billRow)
        .select('id')
        .single()
      if (insertErr) {
        summary.billsFailed.push(`${billNo}: ${insertErr.message}`)
        continue
      }

      if (calculated.length) {
        const { error: itemErr } = await supabase.from('purchase_bill_items').insert(
          calculated.map((item, index) => ({
            shop_id: shopId,
            purchase_bill_id: savedBill.id,
            product_id: item.product_id,
            sl_no: index + 1,
            product_name: item.product_name,
            hsn_code: item.hsn_code,
            unit: item.unit,
            quantity: item.quantity,
            rate: item.rate,
            mrp: item.mrp,
            base_rate: item.rate,
            gst_rate: item.gst_rate,
            sch_disc_pct: item.sch_disc_pct,
            sch_disc_amount: item.sch_disc_amount,
            cash_disc_pct: item.cash_disc_pct,
            cash_disc_amount: item.cash_disc_amount,
            taxable_amount: item.taxable_amount,
            gst_amount: item.gst_amount,
            cgst_amount: item.cgst_amount,
            sgst_amount: item.sgst_amount,
            igst_amount: item.igst_amount,
            total: item.total,
          }))
        )
        if (itemErr) {
          summary.billsFailed.push(`${billNo}: ${itemErr.message}`)
          continue
        }
        for (const item of calculated) {
          if (item.product_id) touchedProductIds.add(item.product_id)
        }
        summary.itemsImported += calculated.length
        const unlinked = calculated.filter((item) => !item.product_id)
        summary.unlinkedItems += unlinked.length
        for (const item of unlinked) summary.unlinkedItemNames.add(`${item.product_name} (${billNo})`)
      }

      try {
        await syncPurchaseCreditEntry({
          shopId,
          purchaseId: savedBill.id,
          billNo,
          billDate,
          supplierId: billRow.supplier_id,
          supplierName: supplier?.name || header.supplier || '',
          supplierPhone: supplier?.phone || '',
          payMode: billRow.payment_mode,
          paidAmount: billRow.paid_amount,
          totalAmount: billRow.total,
        })
      } catch {
        summary.creditSyncWarnings += 1
      }

      summary.billsCreated += 1
    }

    if (touchedProductIds.size) {
      await syncProductPricingFromLatestPurchases(shopId, [...touchedProductIds])
    }
    invalidatePurchaseImpactCache(shopId)
  }

  async function handleImport() {
    if (!shopId || !canImport) return
    setRunning(true)
    setError('')
    setReport(null)

    const summary = {
      suppliersCreated: 0,
      suppliersUpdated: 0,
      suppliersSkipped: 0,
      productsCreated: 0,
      productsUpdated: 0,
      productsSkipped: 0,
      billsCreated: 0,
      itemsImported: 0,
      unlinkedItems: 0,
      unlinkedItemNames: new Set(),
      creditSyncWarnings: 0,
      billsSkipped: [],
      billsFailed: [],
    }

    try {
      if (filesByKind.suppliers) {
        setProgress('Importing suppliers…')
        await importSuppliers(filesByKind.suppliers.rows, summary)
      }
      if (filesByKind.inventory) {
        setProgress('Importing inventory…')
        await importProducts(filesByKind.inventory.rows, summary)
      }
      if (filesByKind.purchases || filesByKind.items) {
        setProgress('Importing purchases…')
        await importBills(
          filesByKind.purchases?.rows || [],
          filesByKind.items?.rows || [],
          summary,
        )
      }
      setReport(summary)
      setCompleted(true)
      onImported?.()
    } catch (importErr) {
      setError(importErr?.message || 'Import failed')
    } finally {
      setProgress('')
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-lg">
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Import Purchases Data</h2>
            <p className="text-xs text-gray-500">
              Upload any one file or all four from the purchases export. Each file is detected automatically.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={running} className="text-gray-400 hover:text-gray-700 disabled:opacity-40">✕</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <label className={`block rounded-lg border-2 border-dashed px-4 py-6 text-center ${completed ? 'cursor-not-allowed border-gray-200 opacity-60' : 'cursor-pointer border-gray-300 hover:border-blue-400'}`}>
            <input type="file" accept=".csv,text/csv" multiple onChange={handleFiles} className="hidden" disabled={running || completed} />
            <span className="text-sm font-medium text-blue-700">Choose CSV files</span>
            <span className="mt-1 block text-xs text-gray-500">
              purchases · purchase-items · purchase-suppliers · purchase-inventory
            </span>
          </label>

          <div className="space-y-2">
            {Object.entries(FILE_KINDS).map(([kind, label]) => {
              const file = filesByKind[kind]
              return (
                <div key={kind} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${file ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                  <div>
                    <div className="font-medium text-gray-700">{label}</div>
                    <div className="text-xs text-gray-500">
                      {file ? `${file.name} · ${file.rows.length} row${file.rows.length === 1 ? '' : 's'}` : 'Not selected (optional)'}
                    </div>
                  </div>
                  {file && (
                    <button type="button" onClick={() => removeKind(kind)} disabled={running || completed} className="text-xs text-red-600 hover:underline disabled:opacity-50">
                      Remove
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {unknownFiles.length > 0 && (
            <div className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
              Unrecognised file{unknownFiles.length > 1 ? 's' : ''} ignored: {unknownFiles.join(', ')}
            </div>
          )}

          <div className="rounded-lg border border-gray-200 px-3 py-2">
            <div className="text-sm font-medium text-gray-700">If a supplier or product already exists</div>
            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="existing-mode"
                  value="update"
                  checked={existingMode === 'update'}
                  onChange={() => setExistingMode('update')}
                  disabled={running || completed}
                  className="mt-1"
                />
                <span>
                  Update it with the values from the file
                  <span className="block text-xs text-gray-500">Keeps one record per name and refreshes prices, GST, category, etc.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="existing-mode"
                  value="skip"
                  checked={existingMode === 'skip'}
                  onChange={() => setExistingMode('skip')}
                  disabled={running || completed}
                  className="mt-1"
                />
                <span>
                  Skip it and import only new names
                  <span className="block text-xs text-gray-500">Leaves your current records untouched. Use this when re-importing an export.</span>
                </span>
              </label>
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={replaceStock}
              onChange={(event) => setReplaceStock(event.target.checked)}
              disabled={running || completed || existingMode === 'skip' || !filesByKind.inventory}
              className="mt-1"
            />
            <span>
              Replace stock quantity from the inventory file
              <span className="block text-xs text-gray-500">
                Leave off when purchases are imported too, otherwise stock will be counted twice.
              </span>
            </span>
          </label>

          <div className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
            Suppliers and products are matched by name, so re-importing never creates duplicates. Purchase numbers that already exist are always skipped.
          </div>

          {running && (
            <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
              <span>{progress || 'Importing…'} Please wait, do not close this window.</span>
            </div>
          )}

          <div ref={resultRef} />

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {report && (
            <div className="space-y-1 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
              <div className="font-semibold">✅ Import finished — these files cannot be imported again.</div>
              <div>Suppliers: {report.suppliersCreated} added, {report.suppliersUpdated} updated{report.suppliersSkipped > 0 ? `, ${report.suppliersSkipped} skipped` : ''}</div>
              <div>Products: {report.productsCreated} added, {report.productsUpdated} updated{report.productsSkipped > 0 ? `, ${report.productsSkipped} skipped` : ''}</div>
              <div>Purchases: {report.billsCreated} created with {report.itemsImported} item lines</div>
              {report.unlinkedItems > 0 && (
                <div className="text-yellow-800">
                  <div>{report.unlinkedItems} item line(s) had no matching product and were saved as free text — stock will not update for these.</div>
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {[...report.unlinkedItemNames].map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </div>
              )}
              {report.creditSyncWarnings > 0 && (
                <div className="text-yellow-800">{report.creditSyncWarnings} bill(s) saved but Credit Book sync failed.</div>
              )}
              {report.billsSkipped.length > 0 && (
                <div className="text-yellow-800">Skipped existing: {report.billsSkipped.join(', ')}</div>
              )}
              {report.billsFailed.length > 0 && (
                <div className="text-red-700">Failed: {report.billsFailed.join(' | ')}</div>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-white px-4 py-3 rounded-b-xl">
          <span className="text-xs font-medium text-blue-700">
            {running ? (progress || 'Importing…') : progress}
          </span>
          <div className="flex flex-wrap justify-end gap-2">
            {completed ? (
              <>
                <button type="button" onClick={startNewImport} className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Import another set
                </button>
                <button type="button" onClick={onClose} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">
                  Done
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onClose} disabled={running} className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  Close
                </button>
                <button type="button" onClick={handleImport} disabled={!canImport} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                  {running ? 'Importing…' : 'Import'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
