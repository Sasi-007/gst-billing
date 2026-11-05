'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { fmt, formatQty } from '@/lib/gst'
import { brandReportToCsvRows, loadBrandReport } from '@/lib/brandReports'

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

export default function BrandDetailPage() {
  const { shop } = useShop()
  const params = useParams()
  const brandName = useMemo(() => {
    try {
      return decodeURIComponent(String(params?.name || ''))
    } catch {
      return String(params?.name || '')
    }
  }, [params?.name])

  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('months')
  usePageLoadingState('brand-detail-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id || !brandName) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setReport(await loadBrandReport(shop.id, brandName))
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load brand report')
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [shop?.id, brandName])

  useEffect(() => { load() }, [load])

  function downloadCsv() {
    if (!report) return
    const csv = brandReportToCsvRows(report)
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `brand-${brandName.replace(/[^\w-]+/g, '_')}-audit.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const totals = report?.totals

  return (
    <div className="p-3 sm:p-4 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="min-w-0">
          <div className="text-sm text-gray-500">
            <Link href="/brands" className="hover:underline">← All Brands</Link>
          </div>
          <h1 className="text-xl font-bold truncate">{brandName}</h1>
          <p className="text-xs text-gray-500">Month-wise purchase, sales and stock for internal audit.</p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/inventory?brand=${encodeURIComponent(brandName)}`}
            className="flex-1 sm:flex-none text-center px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200"
          >
            Products
          </Link>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!report?.months?.length}
            className="flex-1 sm:flex-none px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <LoadingPlaceholder label="Loading brand report" rows={6} fullPage />
      ) : !report || !report.products.length ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
          No products found under this brand.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 mb-4">
            <Stat label="Total Purchase" value={`${fmt(totals.purchaseValue)}`} sub={`${formatQty(totals.purchaseQty)} qty in`} />
            <Stat label="Total Sales" value={`${fmt(totals.salesValue)}`} sub={`${formatQty(totals.salesQty)} qty out`} tone="blue" />
            <Stat
              label="Gross Profit"
              value={`${fmt(totals.grossProfit)}`}
              sub={totals.salesValue > 0 ? `${((totals.grossProfit / totals.salesValue) * 100).toFixed(1)}% margin` : 'no sales yet'}
              tone={totals.grossProfit >= 0 ? 'green' : 'red'}
            />
            <Stat
              label="Stock On Hand"
              value={`${fmt(totals.closingValue)}`}
              sub={`${formatQty(totals.closingQty)} qty · ${totals.productCount} products`}
            />
          </div>

          <div className="flex gap-2 mb-3 overflow-x-auto">
            {[['months', 'Monthly Sheet'], ['products', 'Products']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${
                  tab === key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'months' && (
            report.months.length === 0 ? (
              <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
                No purchases or sales recorded for this brand yet.
              </div>
            ) : (
              <>
                {/* Mobile: stacked month cards */}
                <div className="space-y-2 sm:hidden">
                  {report.months.map((month) => (
                    <div key={month.key} className="bg-white rounded-xl border p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-semibold text-gray-900">{month.label}</div>
                        <div className={`text-sm font-medium ${month.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {fmt(month.grossProfit)}
                        </div>
                      </div>
                      <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                        <dt className="text-gray-500">Purchase</dt>
                        <dd className="text-right">{fmt(month.purchaseValue)} <span className="text-xs text-gray-400">({formatQty(month.purchaseQty)})</span></dd>
                        <dt className="text-gray-500">Sales</dt>
                        <dd className="text-right">{fmt(month.salesValue)} <span className="text-xs text-gray-400">({formatQty(month.salesQty)})</span></dd>
                        <dt className="text-gray-500">Cost of goods sold</dt>
                        <dd className="text-right">{fmt(month.cogs)}</dd>
                        <dt className="text-gray-500">Remaining stock</dt>
                        <dd className="text-right">{fmt(month.closingValue)} <span className="text-xs text-gray-400">({formatQty(month.closingQty)})</span></dd>
                      </dl>
                    </div>
                  ))}
                </div>

                {/* Desktop: audit table */}
                <div className="hidden sm:block bg-white rounded-xl border overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                        <th className="px-3 py-2 text-left">Month</th>
                        <th className="px-3 py-2 text-right">Purchase ₹</th>
                        <th className="px-3 py-2 text-right">Qty In</th>
                        <th className="px-3 py-2 text-right">Sales ₹</th>
                        <th className="px-3 py-2 text-right">Qty Out</th>
                        <th className="px-3 py-2 text-right">COGS ₹</th>
                        <th className="px-3 py-2 text-right">Gross Profit ₹</th>
                        <th className="px-3 py-2 text-right">Remaining Stock ₹</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.months.map((month) => (
                        <tr key={month.key} className="border-b last:border-0">
                          <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{month.label}</td>
                          <td className="px-3 py-2 text-right">{fmt(month.purchaseValue)}</td>
                          <td className="px-3 py-2 text-right text-gray-500">{formatQty(month.purchaseQty)}</td>
                          <td className="px-3 py-2 text-right">{fmt(month.salesValue)}</td>
                          <td className="px-3 py-2 text-right text-gray-500">{formatQty(month.salesQty)}</td>
                          <td className="px-3 py-2 text-right text-gray-500">{fmt(month.cogs)}</td>
                          <td className={`px-3 py-2 text-right font-medium ${month.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {fmt(month.grossProfit)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {fmt(month.closingValue)}
                            <span className="text-xs text-gray-400"> ({formatQty(month.closingQty)})</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 font-semibold">
                        <td className="px-3 py-2">Total</td>
                        <td className="px-3 py-2 text-right">{fmt(totals.purchaseValue)}</td>
                        <td className="px-3 py-2 text-right">{formatQty(totals.purchaseQty)}</td>
                        <td className="px-3 py-2 text-right">{fmt(totals.salesValue)}</td>
                        <td className="px-3 py-2 text-right">{formatQty(totals.salesQty)}</td>
                        <td className="px-3 py-2 text-right">{fmt(totals.cogs)}</td>
                        <td className={`px-3 py-2 text-right ${totals.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {fmt(totals.grossProfit)}
                        </td>
                        <td className="px-3 py-2 text-right">{fmt(totals.closingValue)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <p className="mt-2 text-[11px] text-gray-400">
                  Remaining stock is derived by rolling today&apos;s on-hand quantity backwards through each month&apos;s
                  purchases and sales, valued at the current average purchase cost ({fmt(totals.avgCost)}/unit).
                </p>
              </>
            )
          )}

          {tab === 'products' && (
            <div className="bg-white rounded-xl border divide-y">
              {report.products
                .slice()
                .sort((a, b) => b.salesValue - a.salesValue)
                .map((product) => (
                  <div key={product.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <Link href={`/inventory/${product.id}`} className="font-medium text-gray-900 hover:underline block truncate">
                        {product.name}
                      </Link>
                      <div className="text-xs text-gray-400 truncate">
                        {[product.local_name, product.categories?.name, product.suppliers?.name].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 sm:flex sm:gap-6 gap-3 text-xs sm:text-sm sm:text-right">
                      <div>
                        <div className="text-[11px] text-gray-400">Sales</div>
                        <div>{fmt(product.salesValue)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-400">Profit</div>
                        <div className={product.grossProfit >= 0 ? 'text-green-700' : 'text-red-700'}>{fmt(product.grossProfit)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-400">Stock</div>
                        <div>{formatQty(product.stock_qty)} {product.unit}</div>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
