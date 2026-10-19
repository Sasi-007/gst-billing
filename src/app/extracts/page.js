'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { fmt } from '@/lib/gst'
import { todayStr } from '@/lib/finance'
import { createZipBlob, saveBlob } from '@/lib/zip'
import {
  buildExtractPack,
  fetchAvailableMonths,
  fetchPeriodDataset,
} from '@/lib/monthlyExtract'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export default function ExtractsPage() {
  const { shop, loading: shopLoading } = useShop()

  const [mode, setMode] = useState('month')
  const [months, setMonths] = useState([])
  const [selectedMonth, setSelectedMonth] = useState('')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState(todayStr())
  const [loadingMonths, setLoadingMonths] = useState(true)
  const [monthsError, setMonthsError] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    if (shopLoading) return
    if (!shop?.id) {
      setLoadingMonths(false)
      setMonthsError('No shop is selected for this account.')
      return
    }
    let cancelled = false

    async function loadMonths() {
      setLoadingMonths(true)
      setMonthsError('')
      try {
        const available = await fetchAvailableMonths(shop.id)
        if (cancelled) return
        setMonths(available)
        setSelectedMonth((current) => current || available[0]?.value || '')
        if (available.length > 0) {
          const oldest = available[available.length - 1]
          setCustomFrom((current) => current || oldest.dateFrom)
        }
      } catch (err) {
        if (!cancelled) setMonthsError(err.message || 'Could not read available periods')
      } finally {
        if (!cancelled) setLoadingMonths(false)
      }
    }

    loadMonths()
    return () => { cancelled = true }
  }, [shop?.id, shopLoading])

  useEffect(() => {
    setResult(null)
    setError('')
    setStatus('')
  }, [mode, selectedMonth, customFrom, customTo])

  usePageLoadingState('extracts', shopLoading || loadingMonths)

  const period = useMemo(() => {
    if (mode === 'month') {
      const entry = months.find((m) => m.value === selectedMonth)
      if (!entry) return null
      return { dateFrom: entry.dateFrom, dateTo: entry.dateTo, label: entry.label, slug: entry.value }
    }
    if (!customFrom || !customTo) return null
    if (customFrom > customTo) return null
    return {
      dateFrom: customFrom,
      dateTo: customTo,
      label: `${customFrom} to ${customTo}`,
      slug: `${customFrom}_to_${customTo}`,
    }
  }, [mode, months, selectedMonth, customFrom, customTo])

  const customRangeInvalid = mode === 'custom' && customFrom && customTo && customFrom > customTo

  const runExtract = useCallback(async () => {
    if (!shop?.id || !period) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      setStatus('Reading records for the period…')
      const dataset = await fetchPeriodDataset({
        shopId: shop.id,
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
      })

      setStatus('Building files…')
      const pack = buildExtractPack({ dataset, shop, periodLabel: period.label })

      setStatus('Packing archive…')
      const folder = `${slug(shop.name) || 'shop'}-extract-${period.slug}`
      const blob = createZipBlob(
        pack.files.map((file) => ({ ...file, name: `${folder}/${file.name}` })),
        { modifiedAt: new Date() }
      )

      saveBlob(blob, `${folder}.zip`)
      setResult({ summary: pack.summary, fileCount: pack.files.length, sizeKb: Math.max(1, Math.round(blob.size / 1024)) })
      setStatus('')
    } catch (err) {
      setError(err.message || 'Extract failed')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }, [shop, period])

  if (shopLoading || loadingMonths) {
    return <LoadingPlaceholder label="Loading extract periods" />
  }

  const invoicePackHref = period
    ? `/reports/invoice-pack?dateFrom=${period.dateFrom}&dateTo=${period.dateTo}`
    : '/reports/invoice-pack'
  const stockPackHref = period
    ? `/reports/stock-pack?dateFrom=${period.dateFrom}&dateTo=${period.dateTo}&label=${encodeURIComponent(period.label)}`
    : '/reports/stock-pack'

  return (
    <div className="p-3 sm:p-4 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg sm:text-xl font-bold text-gray-900">Monthly Extract</h1>
        <p className="mt-1 text-xs sm:text-sm text-gray-500">
          One download with the full books for a finalised period — GST registers, stock on hand,
          suppliers, customers and a re-importable inventory backup.
        </p>
      </div>

      {monthsError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{monthsError}</div>
      )}

      {months.length === 0 && !monthsError ? (
        <div className="rounded-xl border bg-white p-6 text-center text-sm text-gray-500">
          No sales or purchase records yet, so there is nothing to extract.
        </div>
      ) : (
        <>
          <div className="rounded-xl border bg-white p-3 sm:p-4">
            <div className="inline-flex rounded-lg border bg-gray-50 p-0.5 text-xs font-medium">
              {[
                { key: 'month', label: 'Full month' },
                { key: 'custom', label: 'Custom dates' },
              ].map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setMode(option.key)}
                  className={`rounded-md px-3 py-1.5 ${mode === option.key ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {mode === 'month' ? (
              <div className="mt-3">
                <label htmlFor="extract-month" className="block text-xs font-medium text-gray-600">
                  Month to extract
                </label>
                <select
                  id="extract-month"
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm sm:max-w-xs"
                >
                  {months.map((entry) => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-gray-400">
                  Only months that actually have sales or purchase records are listed.
                </p>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-md">
                <div>
                  <label htmlFor="extract-from" className="block text-xs font-medium text-gray-600">From</label>
                  <input
                    id="extract-from"
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="extract-to" className="block text-xs font-medium text-gray-600">To</label>
                  <input
                    id="extract-to"
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              </div>
            )}

            {customRangeInvalid && (
              <p className="mt-2 text-xs text-red-600">&quot;From&quot; date must be on or before the &quot;To&quot; date.</p>
            )}

            {period && (
              <p className="mt-3 text-xs text-gray-500">
                Extracting <span className="font-semibold text-gray-700">{period.label}</span>
                {' '}({period.dateFrom} → {period.dateTo})
              </p>
            )}

            <button
              type="button"
              onClick={runExtract}
              disabled={busy || !period}
              className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 sm:w-auto sm:px-6"
            >
              {busy ? (status || 'Working…') : 'Extract everything (ZIP)'}
            </button>

            {busy && status && (
              <p className="mt-2 text-xs text-blue-700">{status}</p>
            )}
            {error && (
              <p className="mt-2 text-xs text-red-600">{error}</p>
            )}
          </div>

          {result && (
            <div className="rounded-xl border border-green-200 bg-green-50 p-3 sm:p-4">
              <div className="text-sm font-semibold text-green-800">
                Downloaded {result.fileCount} files ({result.sizeKb} KB) for {result.summary.periodLabel}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {[
                  { label: 'Sales', value: fmt(result.summary.totalSales), sub: `${result.summary.invoiceCount} invoices` },
                  { label: 'Purchases', value: fmt(result.summary.totalPurchases), sub: `${result.summary.purchaseCount} bills` },
                  { label: 'Net GST payable', value: fmt(result.summary.netPayable), sub: `Output ${fmt(result.summary.outputGst)}` },
                  { label: 'Stock on hand', value: fmt(result.summary.stockValueCost), sub: `${result.summary.stockItemCount} products` },
                  {
                    label: 'Rate revisions',
                    value: result.summary.rateHistoryAvailable ? String(result.summary.rateChangeCount) : '—',
                    sub: result.summary.rateHistoryAvailable ? 'in this period' : 'not tracked',
                  },
                ].map((card) => (
                  <div key={card.label} className="rounded-lg border bg-white px-2 py-2">
                    <div className="text-[10px] text-gray-500">{card.label}</div>
                    <div className="text-sm font-bold text-gray-900 break-words">{card.value}</div>
                    <div className="text-[10px] text-gray-400">{card.sub}</div>
                  </div>
                ))}
              </div>
              {result.summary.stockAsOn?.isHistorical && (
                <p className="mt-2 text-[11px] text-green-800">
                  Stock is valued as at {result.summary.dateTo}: {result.summary.stockAsOn.laterPurchaseUnits} units
                  purchased and {result.summary.stockAsOn.laterSaleUnits} units sold on{' '}
                  {result.summary.stockAsOn.laterBills} later bills were reversed out, so it will differ from the
                  live Inventory screen.
                </p>
              )}
            </div>
          )}

          <div className="rounded-xl border bg-white p-3 sm:p-4">
            <div className="text-sm font-semibold text-gray-800">PDFs for this period</div>
            <p className="mt-1 text-xs text-gray-500">
              These open a preview with a Download PDF button that builds the file on the
              device — no print dialog needed, so it works on phones too.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Link
                href={invoicePackHref}
                className="rounded-lg bg-red-600 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-red-700"
              >
                Open consolidated invoice PDF
              </Link>
              <Link
                href={stockPackHref}
                className="rounded-lg bg-teal-600 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-teal-700"
              >
                Open stock &amp; supplier PDF
              </Link>
            </div>
          </div>

          <div className="rounded-xl border bg-white p-3 sm:p-4">
            <div className="text-sm font-semibold text-gray-800">What the ZIP contains</div>
            <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-gray-600 sm:grid-cols-2">
              {[
                'Sales register (GSTR-1 rate-wise layout)',
                'B2B and B2C sales, plus B2C rate summary',
                'Sales line items and invoice summary',
                'Purchase register, line items and summary',
                'GST tax summary with net payable',
                'HSN summary for GSTR-1 table 12',
                'Expenses recorded in the period',
                'Stock on hand as at the period end (quantity above zero), valued',
                'Full inventory backup, re-importable',
                'Rate revisions recorded during the period',
                'Supplier and customer masters with period totals',
                'Outstanding receivables and payables',
                'Quotations and estimates (non-GST bills)',
              ].map((item) => (
                <li key={item} className="flex gap-1.5">
                  <span className="text-green-600">✓</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
