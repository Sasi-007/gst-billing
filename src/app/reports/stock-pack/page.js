'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { todayStr } from '@/lib/finance'
import { printWithContent, exportPdfWithContent } from '@/lib/print'
import { fetchAllRows } from '@/lib/supabaseBatch'
import { buildStockOnHand, fetchStockAsOn } from '@/lib/monthlyExtract'
import { num, round2 } from '@/lib/gstRegisters'
import { useShop } from '@/context/ShopContext'

export default function StockPackPage() {
  const searchParams = useSearchParams()
  const { shop, loading: shopLoading } = useShop()
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || todayStr()
  const periodLabel = searchParams.get('label') || ''

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stockRows, setStockRows] = useState([])
  const [stockAsOn, setStockAsOn] = useState(null)
  const [suppliers, setSuppliers] = useState([])
  const [printShop, setPrintShop] = useState(null)
  const [mounted, setMounted] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')
  const [pdfError, setPdfError] = useState('')

  useEffect(() => setMounted(true), [])

  async function handleDownloadPdf() {
    setPdfBusy(true)
    setPdfError('')
    setPdfStatus('Building PDF…')
    try {
      await exportPdfWithContent(undefined, {
        fileName: `stock-report-${dateTo}.pdf`,
        title: 'Stock Report',
        onStatus: (message) => setPdfError(message),
        onProgress: (done, total) => setPdfStatus(`Sheet ${done} of ${total}…`),
      })
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  useEffect(() => {
    if (!shop?.id) return
    let cancelled = false

    async function loadStockPack() {
      setLoading(true)
      setError('')
      try {
        const [{ data: latestShop, error: shopErr }, products, supplierRows] = await Promise.all([
          supabase.from('shops').select('*').eq('id', shop.id).single(),
          fetchAllRows(() => supabase
            .from('products')
            .select('id,name,local_name,brand,barcode,unit,hsn_code,purchase_price,mrp,selling_price,gst_rate,stock_qty,min_stock,is_active,categories(name),suppliers(name,phone)')
            .eq('shop_id', shop.id)),
          fetchAllRows(() => supabase
            .from('suppliers')
            .select('*')
            .eq('shop_id', shop.id)),
        ])
        if (shopErr) throw shopErr
        if (cancelled) return

        // Quantities must reflect the period end, not today: an extract is
        // normally taken weeks after the month closed.
        const asOn = await fetchStockAsOn({ shopId: shop.id, asOnDate: dateTo, products })
        if (cancelled) return

        setPrintShop({ ...shop, ...latestShop })
        setStockAsOn(asOn)
        setStockRows(buildStockOnHand(products, asOn.quantities))
        setSuppliers([...supplierRows].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))))
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load stock pack')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadStockPack()
    return () => { cancelled = true }
  }, [shop, dateTo])

  const totals = useMemo(() => ({
    cost: stockRows.reduce((sum, row) => sum + num(row['Stock Value (Cost)']), 0),
    selling: stockRows.reduce((sum, row) => sum + num(row['Stock Value (Selling)']), 0),
    units: stockRows.reduce((sum, row) => sum + num(row.Quantity), 0),
  }), [stockRows])

  if (shopLoading || loading) {
    return <div className="p-4 text-gray-500">Loading stock report...</div>
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="mb-3 text-sm text-red-600">{error}</div>
        <Link href="/extracts" className="text-sm text-blue-600 hover:underline">Back to Extracts</Link>
      </div>
    )
  }

  const s = printShop || shop || {}
  const heading = periodLabel || (dateFrom ? `${dateFrom} to ${dateTo}` : `As on ${dateTo}`)
  const printedAt = new Date().toLocaleString('en-IN')
  const stockBasisNote = stockAsOn?.isHistorical
    ? `Quantities as at close of ${dateTo} — ${stockAsOn.laterPurchaseUnits} units purchased and `
      + `${stockAsOn.laterSaleUnits} units sold on ${stockAsOn.laterBills} later bills have been reversed out.`
    : ''

  return (
    <>
      <div className="no-print p-4">
        <div className="max-w-3xl rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-gray-900">Stock &amp; Supplier PDF</h1>
              <p className="mt-1 text-sm text-gray-500">
                {heading} · {stockRows.length} products in stock · {suppliers.length} suppliers
              </p>
              {stockBasisNote && (
                <p className="mt-1 text-xs text-amber-700">{stockBasisNote}</p>
              )}
              <p className="mt-2 text-xs text-gray-500">
                Download PDF builds the file directly, so it works on phones as well as desktop.
                {stockAsOn?.isHistorical
                  ? ' Rates shown are the current ones; only quantities are rewound to the period end.'
                  : ' Stock quantities are the live values at this moment.'}
              </p>
            </div>
            <div className="flex gap-2">
              <Link href="/extracts" className="rounded-lg border px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Back
              </Link>
              <button
                type="button"
                onClick={() => printWithContent(undefined, {
                  fileName: `stock-report-${dateTo}.pdf`,
                  title: 'Stock Report',
                })}
                disabled={(stockRows.length === 0 && suppliers.length === 0) || pdfBusy}
                className="rounded-lg border px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                Print
              </button>
              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={(stockRows.length === 0 && suppliers.length === 0) || pdfBusy}
                className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {pdfBusy ? pdfStatus || 'Building PDF…' : 'Download PDF'}
              </button>
            </div>
          </div>

          {pdfError && (
            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{pdfError}</div>
          )}

          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border p-2">
              <div className="text-[11px] text-gray-500">Stock Value (Cost)</div>
              <div className="text-base font-bold text-teal-700">{fmt(totals.cost)}</div>
            </div>
            <div className="rounded-lg border p-2">
              <div className="text-[11px] text-gray-500">Stock Value (Selling)</div>
              <div className="text-base font-bold text-blue-700">{fmt(totals.selling)}</div>
            </div>
            <div className="rounded-lg border p-2">
              <div className="text-[11px] text-gray-500">Total Units</div>
              <div className="text-base font-bold text-gray-800">{round2(totals.units)}</div>
            </div>
          </div>
        </div>
      </div>

      {mounted && createPortal(
        <div className="stock-pack-print">
          <div className="print-only">
            <div className="report-sheet">
              <div className="report-head">
                <h1>{s?.name || 'My Shop'}</h1>
                {s?.address && <p>{s.address}</p>}
                {s?.gstin && <p>GSTIN: {s.gstin}</p>}
                <h2>STOCK ON HAND</h2>
                <p>{heading} · Printed {printedAt}</p>
                {stockBasisNote && <p>{stockBasisNote}</p>}
              </div>

              <table className="report-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Product</th>
                    <th>Brand</th>
                    <th>Category</th>
                    <th>HSN</th>
                    <th className="tc">GST%</th>
                    <th className="tr">Qty</th>
                    <th>Unit</th>
                    <th className="tr">Cost</th>
                    <th className="tr">Sell</th>
                    <th className="tr">MRP</th>
                    <th className="tr">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.length === 0 ? (
                    <tr><td colSpan={12} className="tc">No stock on hand</td></tr>
                  ) : stockRows.map((row, index) => (
                    <tr key={`${row.Product}-${index}`}>
                      <td className="tc">{index + 1}</td>
                      <td>{row.Product}{row['Local Name'] ? ` (${row['Local Name']})` : ''}</td>
                      <td>{row.Brand || '—'}</td>
                      <td>{row.Category || '—'}</td>
                      <td>{row.HSN || '—'}</td>
                      <td className="tc">{row['GST Rate']}</td>
                      <td className="tr">{row.Quantity}</td>
                      <td>{row.Unit}</td>
                      <td className="tr">{row['Purchase Price'].toFixed(2)}</td>
                      <td className="tr">{row['Selling Price'].toFixed(2)}</td>
                      <td className="tr">{row.MRP.toFixed(2)}</td>
                      <td className="tr">{row['Stock Value (Cost)'].toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6} className="tr"><strong>Total</strong></td>
                    <td className="tr"><strong>{round2(totals.units)}</strong></td>
                    <td colSpan={4}></td>
                    <td className="tr"><strong>{round2(totals.cost).toFixed(2)}</strong></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="print-only">
            <div className="report-sheet">
              <div className="report-head">
                <h1>{s?.name || 'My Shop'}</h1>
                <h2>SUPPLIER DIRECTORY</h2>
                <p>{suppliers.length} suppliers · Printed {printedAt}</p>
              </div>

              <table className="report-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Supplier</th>
                    <th>Contact</th>
                    <th>Phone</th>
                    <th>GSTIN</th>
                    <th>Address</th>
                    <th>City</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.length === 0 ? (
                    <tr><td colSpan={8} className="tc">No suppliers recorded</td></tr>
                  ) : suppliers.map((supplier, index) => (
                    <tr key={supplier.id}>
                      <td className="tc">{index + 1}</td>
                      <td>{supplier.name || '—'}</td>
                      <td>{supplier.contact_person || '—'}</td>
                      <td>{supplier.phone || '—'}</td>
                      <td>{supplier.gstin || '—'}</td>
                      <td>{supplier.address || '—'}</td>
                      <td>{supplier.city || '—'}</td>
                      <td>{supplier.state || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
