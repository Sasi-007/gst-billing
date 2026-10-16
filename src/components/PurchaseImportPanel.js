'use client'

import { useMemo, useState } from 'react'
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
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')

  const detectedKinds = useMemo(() => Object.keys(filesByKind), [filesByKind])
  const canImport = detectedKinds.length > 0 && !running

  async function handleFiles(event) {
    const picked = Array.from(event.target.files || [])
    event.target.value = ''
    if (!picked.length) return

    setError('')
    setReport(null)
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

    for (const row of named) {
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
      const match = existingByName.get(lower(row.name))
      if (match) {
        const { error: updErr } = await supabase
          .from('suppliers')
          .update(payload)
          .eq('shop_id', shopId)
          .eq('id', match.id)
        if (updErr) throw updErr
        summary.suppliersUpdated += 1
      } else {
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

    for (const row of named) {
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
      const match = existingByName.get(lower(row.name))
      if (match) {
        // Stock is normally driven by purchase and sale history, so it is only
        // overwritten when the user explicitly asks for it.
        const updatePayload = replaceStock ? { ...payload, stock_qty: num(row.stock_qty) } : payload
        const { error: updErr } = await supabase
          .from('products')
          .update(updatePayload)
          .eq('shop_id', shopId)
          .eq('id', match.id)
        if (updErr) throw updErr
        summary.productsUpdated += 1
      } else {
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
        summary.unlinkedItems += calculated.filter((item) => !item.product_id).length
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
      productsCreated: 0,
      productsUpdated: 0,
      billsCreated: 0,
      itemsImported: 0,
      unlinkedItems: 0,
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
      onImported?.()
    } catch (importErr) {
      setError(importErr?.message || 'Import failed')
    } finally {
      setProgress('')
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Import Purchases Data</h2>
            <p className="text-xs text-gray-500">
              Upload any one file or all four from the purchases export. Each file is detected automatically.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <label className="block cursor-pointer rounded-lg border-2 border-dashed border-gray-300 px-4 py-6 text-center hover:border-blue-400">
            <input type="file" accept=".csv,text/csv" multiple onChange={handleFiles} className="hidden" disabled={running} />
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
                    <button type="button" onClick={() => removeKind(kind)} disabled={running} className="text-xs text-red-600 hover:underline disabled:opacity-50">
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

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={replaceStock}
              onChange={(event) => setReplaceStock(event.target.checked)}
              disabled={running || !filesByKind.inventory}
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
            Suppliers and products are matched by name and updated; purchase numbers that already exist are skipped.
          </div>

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {report && (
            <div className="space-y-1 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
              <div>Suppliers: {report.suppliersCreated} added, {report.suppliersUpdated} updated</div>
              <div>Products: {report.productsCreated} added, {report.productsUpdated} updated</div>
              <div>Purchases: {report.billsCreated} created with {report.itemsImported} item lines</div>
              {report.unlinkedItems > 0 && (
                <div className="text-yellow-800">{report.unlinkedItems} item line(s) had no matching product and were saved as free text.</div>
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

        <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
          <span className="text-xs text-gray-500">{progress}</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={running} className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              Close
            </button>
            <button type="button" onClick={handleImport} disabled={!canImport} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {running ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
