'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { fmt } from '@/lib/gst'
import { balanceSheetToCsv, loadMonthlyBalanceSheet } from '@/lib/balanceSheet'

function Stat({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'text-gray-900',
    green: 'text-green-700',
    red: 'text-red-700',
    blue: 'text-blue-700',
  }
  return (
    <div className="bg-white rounded-xl border p-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function BalanceSheetPage() {
  const { shop } = useShop()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [year, setYear] = useState('all')
  const [showGst, setShowGst] = useState(false)
  usePageLoadingState('balance-sheet-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setData(await loadMonthlyBalanceSheet(shop.id))
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load balance sheet')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [shop?.id])

  useEffect(() => { load() }, [load])

  const years = useMemo(() => (
    [...new Set((data?.months || []).map((month) => month.financialYear))]
  ), [data])

  const months = useMemo(() => {
    const all = data?.months || []
    return year === 'all' ? all : all.filter((month) => month.financialYear === year)
  }, [data, year])

  const periodTotals = useMemo(() => {
    if (!months.length) return null
    const sum = months.reduce((acc, month) => ({
      salesValue: acc.salesValue + month.salesValue,
      purchaseValue: acc.purchaseValue + month.purchaseValue,
      cogs: acc.cogs + month.cogs,
      salesGst: acc.salesGst + month.salesGst,
      purchaseGst: acc.purchaseGst + month.purchaseGst,
      billCount: acc.billCount + month.billCount,
      purchaseCount: acc.purchaseCount + month.purchaseCount,
    }), { salesValue: 0, purchaseValue: 0, cogs: 0, salesGst: 0, purchaseGst: 0, billCount: 0, purchaseCount: 0 })

    // months are newest-first, so the period opens at the oldest row.
    sum.openingStockValue = months[months.length - 1].openingStockValue
    sum.closingStockValue = months[0].closingStockValue
    sum.grossProfit = sum.salesValue - sum.cogs
    sum.marginPct = sum.salesValue > 0 ? (sum.grossProfit / sum.salesValue) * 100 : 0
    sum.netGst = sum.salesGst - sum.purchaseGst
    return sum
  }, [months])

  function downloadCsv() {
    const csv = balanceSheetToCsv(months)
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `balance-sheet-${year === 'all' ? 'all-months' : `fy-${year}`}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-3 sm:p-4 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Balance Sheet</h1>
          <p className="text-xs text-gray-500 mt-1">
            Month-wise sales, purchases and remaining stock for the whole shop.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="flex-1 sm:flex-none border rounded-lg px-3 py-2 text-sm bg-white"
          >
            <option value="all">All months</option>
            {years.map((item) => <option key={item} value={item}>FY {item}</option>)}
          </select>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!months.length}
            className="flex-1 sm:flex-none px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <LoadingPlaceholder label="Loading balance sheet" rows={6} fullPage />
      ) : !months.length ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
          No sales or purchases recorded yet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 mb-4">
            <Stat
              label="Total Sales"
              value={`${fmt(periodTotals.salesValue)}`}
              sub={`${periodTotals.billCount} bills`}
              tone="blue"
            />
            <Stat
              label="Total Purchase"
              value={`${fmt(periodTotals.purchaseValue)}`}
              sub={`${periodTotals.purchaseCount} purchase bills`}
            />
            <Stat
              label="Gross Profit"
              value={`${fmt(periodTotals.grossProfit)}`}
              sub={`${periodTotals.marginPct.toFixed(1)}% margin`}
              tone={periodTotals.grossProfit >= 0 ? 'green' : 'red'}
            />
            <Stat
              label="Remaining Stock"
              value={`${fmt(periodTotals.closingStockValue)}`}
              sub="at current purchase cost"
            />
          </div>

          <div className="flex items-center justify-between gap-2 mb-2">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={showGst}
                onChange={(e) => setShowGst(e.target.checked)}
                className="rounded"
              />
              Show GST columns
            </label>
            <span className="text-xs text-gray-400">{months.length} month(s)</span>
          </div>

          {/* Mobile: one card per month */}
          <div className="space-y-2 sm:hidden">
            {months.map((month) => (
              <div key={month.key} className="bg-white rounded-xl border p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold text-gray-900">{month.label}</div>
                  <div className={`text-sm font-medium ${month.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {fmt(month.grossProfit)}
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt className="text-gray-500">Opening stock</dt>
                  <dd className="text-right">{fmt(month.openingStockValue)}</dd>
                  <dt className="text-gray-500">Purchase</dt>
                  <dd className="text-right">{fmt(month.purchaseValue)}</dd>
                  <dt className="text-gray-500">Sales</dt>
                  <dd className="text-right">{fmt(month.salesValue)}</dd>
                  <dt className="text-gray-500">Cost of goods sold</dt>
                  <dd className="text-right">{fmt(month.cogs)}</dd>
                  <dt className="text-gray-500 font-medium">Remaining stock</dt>
                  <dd className="text-right font-medium">{fmt(month.closingStockValue)}</dd>
                  {showGst && (
                    <>
                      <dt className="text-gray-500">Sales GST</dt>
                      <dd className="text-right">{fmt(month.salesGst)}</dd>
                      <dt className="text-gray-500">Purchase GST</dt>
                      <dd className="text-right">{fmt(month.purchaseGst)}</dd>
                      <dt className="text-gray-500">Net GST</dt>
                      <dd className="text-right">{fmt(month.netGst)}</dd>
                    </>
                  )}
                </dl>
              </div>
            ))}
          </div>

          {/* Desktop: audit table */}
          <div className="hidden sm:block bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: showGst ? 1040 : 800 }}>
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  <th className="px-3 py-2 text-left">Month</th>
                  <th className="px-3 py-2 text-right">Opening Stock ₹</th>
                  <th className="px-3 py-2 text-right">Purchase ₹</th>
                  <th className="px-3 py-2 text-right">Sales ₹</th>
                  <th className="px-3 py-2 text-right">COGS ₹</th>
                  <th className="px-3 py-2 text-right">Gross Profit ₹</th>
                  <th className="px-3 py-2 text-right">Remaining Stock ₹</th>
                  {showGst && <th className="px-3 py-2 text-right">Sales GST ₹</th>}
                  {showGst && <th className="px-3 py-2 text-right">Purchase GST ₹</th>}
                  {showGst && <th className="px-3 py-2 text-right">Net GST ₹</th>}
                </tr>
              </thead>
              <tbody>
                {months.map((month) => (
                  <tr key={month.key} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{month.label}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(month.openingStockValue)}</td>
                    <td className="px-3 py-2 text-right">{fmt(month.purchaseValue)}</td>
                    <td className="px-3 py-2 text-right">{fmt(month.salesValue)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(month.cogs)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${month.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {fmt(month.grossProfit)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{fmt(month.closingStockValue)}</td>
                    {showGst && <td className="px-3 py-2 text-right text-gray-500">{fmt(month.salesGst)}</td>}
                    {showGst && <td className="px-3 py-2 text-right text-gray-500">{fmt(month.purchaseGst)}</td>}
                    {showGst && <td className="px-3 py-2 text-right text-gray-500">{fmt(month.netGst)}</td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right">{fmt(periodTotals.openingStockValue)}</td>
                  <td className="px-3 py-2 text-right">{fmt(periodTotals.purchaseValue)}</td>
                  <td className="px-3 py-2 text-right">{fmt(periodTotals.salesValue)}</td>
                  <td className="px-3 py-2 text-right">{fmt(periodTotals.cogs)}</td>
                  <td className={`px-3 py-2 text-right ${periodTotals.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {fmt(periodTotals.grossProfit)}
                  </td>
                  <td className="px-3 py-2 text-right">{fmt(periodTotals.closingStockValue)}</td>
                  {showGst && <td className="px-3 py-2 text-right">{fmt(periodTotals.salesGst)}</td>}
                  {showGst && <td className="px-3 py-2 text-right">{fmt(periodTotals.purchaseGst)}</td>}
                  {showGst && <td className="px-3 py-2 text-right">{fmt(periodTotals.netGst)}</td>}
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="mt-2 text-[11px] text-gray-400">
            Sales and purchases are GST-inclusive bill totals. Remaining stock is derived by rolling today&apos;s stock
            value ({fmt(data.totals.closingStockValue)} across {data.totals.productCount} products) backwards through
            each month&apos;s purchases and cost of goods sold, since stock is not snapshotted month-end.
            For a single-period cash view see <Link href="/summary" className="underline">Summary</Link>.
          </p>
        </>
      )}
    </div>
  )
}
