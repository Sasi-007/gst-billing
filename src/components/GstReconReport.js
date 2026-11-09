'use client'

import { useMemo, useState, Fragment } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'
import { fmt } from '../lib/gst'
import { useConfirm } from '../context/ConfirmDialogContext'
import {
  buildGstRecon,
  buildMasterRateWarnings,
  num,
  recomputeBillItemTax,
  recomputeBillTotals,
  resolveExpectedGstRates,
} from '../lib/salesAnalysis'

const CONFIDENCE_LABELS = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const SOURCE_LABELS = {
  purchase: 'Supplier purchase bill',
  history: 'Product rate history',
  sales: 'Majority of past sales',
}

function confidenceClass(confidence) {
  if (confidence === 'high') return 'bg-red-100 text-red-700'
  if (confidence === 'medium') return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-600'
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

// Catches the "product was re-added to inventory at the wrong GST rate" typo:
// every invoice line is checked against the rate the supplier charged, the rate
// the product used to carry and the rate it was mostly billed at, and the tax
// the shop would have to absorb is totalled up.
export default function GstReconReport({ data, dateFrom, dateTo, shopId, onChanged }) {
  const { confirm, alert } = useConfirm()
  const [minConfidence, setMinConfidence] = useState('medium')
  const [expandedKeys, setExpandedKeys] = useState([])
  const [busyKey, setBusyKey] = useState('')

  const expectedByProduct = useMemo(() => resolveExpectedGstRates({
    products: data?.products || [],
    purchaseItems: data?.purchaseItems || [],
    priceHistory: data?.priceHistory || [],
    salesItems: data?.productSalesItems || [],
    purchaseDateById: new Map((data?.purchaseBills || []).map((bill) => [bill.id, bill.date])),
  }), [data])

  const recon = useMemo(() => buildGstRecon({
    bills: data?.bills || [],
    items: data?.items || [],
    expectedByProduct,
    minConfidence,
  }), [data, expectedByProduct, minConfidence])

  const masterWarnings = useMemo(
    () => buildMasterRateWarnings(expectedByProduct, data?.products || []),
    [expectedByProduct, data],
  )

  function toggleExpanded(key) {
    setExpandedKeys((prev) => (prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key]))
  }

  async function handleFixProductRate(row) {
    const ok = await confirm({
      title: 'Correct the product rate',
      message: `Set "${row.productName}" GST rate to ${row.expectedRate}% in inventory?`,
      details: `Current master rate is ${row.masterRate}%. Already-issued invoices are left untouched by this action.`,
      tone: 'warning',
      confirmLabel: `Set ${row.expectedRate}%`,
    })
    if (!ok) return

    setBusyKey(`product:${row.key}`)
    try {
      const { error } = await supabase
        .from('products')
        .update({ gst_rate: row.expectedRate })
        .eq('id', row.productId)
        .eq('shop_id', shopId)
      if (error) throw error
      await alert({ title: 'Rate corrected', message: `${row.productName} now carries ${row.expectedRate}% GST.` })
      onChanged?.()
    } catch (error) {
      await alert({ title: 'Update failed', message: error?.message || 'Could not update the product rate.', tone: 'danger' })
    } finally {
      setBusyKey('')
    }
  }

  // Re-splits the tax inside each affected invoice line and rebuilds that
  // bill's tax columns. The amount the customer paid never changes.
  async function handleFixBills(row) {
    const billIds = [...new Set(row.lines.map((line) => line.billId))]
    const ok = await confirm({
      title: 'Recompute GST on issued bills',
      message: `Recompute ${row.lines.length} line${row.lines.length === 1 ? '' : 's'} across ${billIds.length} bill${billIds.length === 1 ? '' : 's'} at ${row.expectedRate}%?`,
      details: 'Bill totals stay exactly as billed — only the taxable value and GST split inside them are corrected. This rewrites issued invoices, so only do it if the rate was genuinely a typo.',
      tone: 'danger',
      confirmLabel: 'Recompute bills',
      requireText: 'RECOMPUTE',
    })
    if (!ok) return

    setBusyKey(`bills:${row.key}`)
    try {
      const affectedItemIds = new Set(row.lines.map((line) => line.itemId))
      for (const billId of billIds) {
        const { data: billRows, error: billErr } = await supabase
          .from('bills')
          .select('id,igst_amount')
          .eq('id', billId)
          .eq('shop_id', shopId)
          .maybeSingle()
        if (billErr) throw billErr
        if (!billRows) continue

        const { data: items, error: itemsErr } = await supabase
          .from('bill_items')
          .select('id,quantity,gst_rate,gst_amount,base_rate,discount_amount,total')
          .eq('bill_id', billId)
          .eq('shop_id', shopId)
        if (itemsErr) throw itemsErr

        const updatedItems = (items || []).map((item) => (
          affectedItemIds.has(item.id)
            ? { ...item, ...recomputeBillItemTax(item, row.expectedRate) }
            : item
        ))

        for (const item of updatedItems) {
          if (!affectedItemIds.has(item.id)) continue
          const { error: updateErr } = await supabase
            .from('bill_items')
            .update({
              gst_rate: item.gst_rate,
              gst_amount: item.gst_amount,
              base_rate: item.base_rate,
            })
            .eq('id', item.id)
            .eq('shop_id', shopId)
          if (updateErr) throw updateErr
        }

        const totals = recomputeBillTotals(updatedItems, { isInterstate: num(billRows.igst_amount) > 0 })
        const { error: billUpdateErr } = await supabase
          .from('bills')
          .update({
            subtotal: totals.subtotal,
            gst_amount: totals.gst_amount,
            cgst_amount: totals.cgst_amount,
            sgst_amount: totals.sgst_amount,
            igst_amount: totals.igst_amount,
          })
          .eq('id', billId)
          .eq('shop_id', shopId)
        if (billUpdateErr) throw billUpdateErr
      }

      await alert({ title: 'Bills recomputed', message: `${billIds.length} bill${billIds.length === 1 ? '' : 's'} now report ${row.expectedRate}% on ${row.productName}.` })
      onChanged?.()
    } catch (error) {
      await alert({ title: 'Recompute failed', message: error?.message || 'Could not update the bills.', tone: 'danger' })
    } finally {
      setBusyKey('')
    }
  }

  function handleExport() {
    const rows = recon.lines.map((line) => ({
      Date: line.billDate,
      'Bill No': line.billNo,
      Customer: line.customerName,
      Product: line.productName,
      HSN: line.hsnCode,
      Qty: line.quantity,
      'Line Total': line.lineTotal,
      'Billed GST %': line.chargedRate,
      'Expected GST %': line.expectedRate,
      'GST Charged': line.chargedGst,
      'Tax Shortfall': line.shortfall,
      Confidence: CONFIDENCE_LABELS[line.confidence] || line.confidence,
      Evidence: SOURCE_LABELS[line.primarySource] || line.primarySource,
    }))
    if (!rows.length) return
    downloadCsv(`gst-recon-${dateFrom}-to-${dateTo}.csv`, Object.keys(rows[0]), rows)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Tax At Risk', value: fmt(recon.totals.shortfall), cls: recon.totals.shortfall > 0 ? 'text-red-700' : 'text-green-700' },
          { label: 'Products Affected', value: recon.totals.productCount, cls: 'text-gray-800' },
          { label: 'Bills Affected', value: recon.totals.billCount, cls: 'text-gray-800' },
          { label: 'Revenue On Wrong Rate', value: fmt(recon.totals.revenue), cls: 'text-orange-700' },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className={`text-xl font-bold mt-1 ${card.cls}`}>{card.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-white border rounded-lg p-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-gray-600 flex items-center gap-2">
          Evidence strength
          <select
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-white"
          >
            <option value="high">High only (supplier bill + another trail agree)</option>
            <option value="medium">Medium and above</option>
            <option value="low">Show everything</option>
          </select>
        </label>
        <button
          type="button"
          onClick={handleExport}
          disabled={recon.lines.length === 0}
          className="px-3 py-1.5 rounded-lg border bg-white text-gray-700 text-xs font-medium hover:bg-gray-50 disabled:opacity-60"
        >
          Export CSV
        </button>
        <span className="text-[11px] text-gray-400">
          Compares every billed line against the supplier&apos;s rate, the product&apos;s rate history and its usual billed rate.
        </span>
      </div>

      {masterWarnings.length > 0 && (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <div className="px-3 py-2 border-b bg-amber-50 text-xs font-semibold text-amber-800">
            Inventory rates that disagree with the evidence ({masterWarnings.length}) — fix these to stop the error reaching the next bill
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['Product', 'HSN', 'Inventory Rate', 'Expected', 'Evidence', 'Stock', 'Action'].map((header) => (
                  <th key={header} className="px-3 py-2 text-left">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {masterWarnings.map((row) => (
                <tr key={row.productId} className="border-b">
                  <td className="px-3 py-1.5">
                    <Link href={`/inventory/${row.productId}`} className="text-blue-700 hover:underline">{row.productName}</Link>
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">{row.hsnCode || '—'}</td>
                  <td className="px-3 py-1.5 font-medium text-red-600">{row.masterRate}%</td>
                  <td className="px-3 py-1.5 font-medium text-green-700">{row.expectedRate}%</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">
                    {row.candidates.map((candidate) => `${SOURCE_LABELS[candidate.source]}: ${candidate.rate}%`).join(' · ')}
                  </td>
                  <td className="px-3 py-1.5 text-right">{row.stockQty}</td>
                  <td className="px-3 py-1.5">
                    <button
                      type="button"
                      onClick={() => handleFixProductRate({
                        key: `master-${row.productId}`,
                        productId: row.productId,
                        productName: row.productName,
                        masterRate: row.masterRate,
                        expectedRate: row.expectedRate,
                      })}
                      disabled={busyKey === `product:master-${row.productId}`}
                      className="px-2 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-60"
                    >
                      {busyKey === `product:master-${row.productId}` ? 'Saving…' : `Set ${row.expectedRate}%`}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recon.products.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
          No GST mismatches found between {dateFrom} and {dateTo} at this evidence level
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <div className="px-3 py-2 border-b bg-red-50 text-xs font-semibold text-red-800">
            Invoice lines billed at the wrong rate ({recon.totals.lineCount})
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['', 'Product', 'Billed', 'Expected', 'Bills', 'Qty', 'Revenue', 'Tax At Risk', 'Evidence', 'Fix'].map((header, index) => (
                  <th key={`${header}-${index}`} className="px-3 py-2 text-left whitespace-nowrap">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recon.products.map((row) => (
                <Fragment key={row.key}>
                  <tr className="border-b hover:bg-gray-50">
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(row.key)}
                        className="text-gray-400 hover:text-blue-700"
                        aria-label={`Show bills for ${row.productName}`}
                      >
                        {expandedKeys.includes(row.key) ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{row.productName}</div>
                      <div className="text-[11px] text-gray-400">
                        {row.hsnCode ? `HSN ${row.hsnCode} · ` : ''}Inventory rate {row.masterRate}%
                      </div>
                    </td>
                    <td className="px-3 py-1.5 font-medium text-red-600">{row.chargedRate}%</td>
                    <td className="px-3 py-1.5 font-medium text-green-700">{row.expectedRate}%</td>
                    <td className="px-3 py-1.5 text-right">{row.billCount}</td>
                    <td className="px-3 py-1.5 text-right">{row.quantity}</td>
                    <td className="px-3 py-1.5 text-right">{fmt(row.revenue)}</td>
                    <td className="px-3 py-1.5 text-right font-semibold text-red-700">{fmt(row.shortfall)}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] ${confidenceClass(row.confidence)}`}>
                        {CONFIDENCE_LABELS[row.confidence]}
                      </span>
                      <div className="text-[11px] text-gray-400 mt-0.5">{SOURCE_LABELS[row.primarySource]}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-col gap-1">
                        {row.masterMismatch && (
                          <button
                            type="button"
                            onClick={() => handleFixProductRate(row)}
                            disabled={busyKey === `product:${row.key}`}
                            className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] hover:bg-blue-700 disabled:opacity-60"
                          >
                            {busyKey === `product:${row.key}` ? 'Saving…' : 'Fix inventory rate'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleFixBills(row)}
                          disabled={busyKey === `bills:${row.key}`}
                          className="px-2 py-1 rounded bg-amber-600 text-white text-[11px] hover:bg-amber-700 disabled:opacity-60"
                        >
                          {busyKey === `bills:${row.key}` ? 'Working…' : `Recompute ${row.billCount} bill${row.billCount === 1 ? '' : 's'}`}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedKeys.includes(row.key) && (
                    <tr className="border-b bg-gray-50/70">
                      <td className="px-3 py-2" colSpan={10}>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-[11px] text-gray-500">
                              {['Date', 'Bill No', 'Customer', 'Qty', 'Line Total', 'GST Charged', 'Tax At Risk'].map((header) => (
                                <th key={header} className="px-2 py-1 text-left">{header}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {row.lines.map((line) => (
                              <tr key={line.itemId}>
                                <td className="px-2 py-1">{line.billDate}</td>
                                <td className="px-2 py-1 font-mono">
                                  <Link href={`/billing/${line.billId}`} className="text-blue-700 hover:underline">{line.billNo}</Link>
                                </td>
                                <td className="px-2 py-1 text-gray-600">{line.customerName || '—'}</td>
                                <td className="px-2 py-1 text-right">{line.quantity}</td>
                                <td className="px-2 py-1 text-right">{fmt(line.lineTotal)}</td>
                                <td className="px-2 py-1 text-right">{fmt(line.chargedGst)}</td>
                                <td className="px-2 py-1 text-right text-red-700">{fmt(line.shortfall)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
