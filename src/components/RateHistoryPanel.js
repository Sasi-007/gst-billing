'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  describeChange,
  fetchProductPriceHistory,
  isOpeningRow,
  sourceIcon,
  sourceLabel,
} from '../lib/priceHistory'

function fmt(value) {
  const amount = Number(value || 0)
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function ChangeBadge({ row }) {
  const change = describeChange(row)

  if (!change) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
        {isOpeningRow(row) ? 'Opening rate' : 'No rate change'}
      </span>
    )
  }

  const up = change.direction === 'up'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        up ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
      }`}
    >
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      {fmt(change.prev)} → {fmt(change.next)}
      {change.percent !== null && <span className="opacity-75">({change.percent.toFixed(1)}%)</span>}
    </span>
  )
}

/**
 * Rate timeline for a single product.
 *
 * Rows come from a trigger on `products`, so this shows every rate change
 * regardless of which screen made it.
 */
export default function RateHistoryPanel({ shopId, productId, refreshKey = 0 }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    if (!shopId || !productId) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      setRows(await fetchProductPriceHistory(shopId, productId))
    } catch (err) {
      // The feature needs a migration; say so instead of showing a raw error.
      const message = err?.message || 'Could not load rate history'
      setError(
        /product_price_history/i.test(message)
          ? 'Rate history is not set up yet. Run the latest database update to enable it.'
          : message
      )
    } finally {
      setLoading(false)
    }
  }, [shopId, productId])

  useEffect(() => { load() }, [load, refreshKey])

  const visible = expanded ? rows : rows.slice(0, 5)

  return (
    <div className="col-span-2 rounded-xl border bg-gray-50 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-gray-900">Rate history</h2>
        <p className="text-xs text-gray-500">
          Every purchase rate, selling rate and MRP change for this product, with the date it took effect.
        </p>
      </div>

      {loading ? (
        <div className="mt-3 text-sm text-gray-500">Loading rate history…</div>
      ) : error ? (
        <div className="mt-3 text-sm text-red-600">{error}</div>
      ) : rows.length === 0 ? (
        <div className="mt-3 text-sm text-gray-500">
          No rate changes recorded yet. The next time you change a rate it will appear here.
        </div>
      ) : (
        <>
          {/* Cards on phones, table from sm up — a 6-column table is unreadable at 390px. */}
          <div className="mt-3 space-y-2 sm:hidden">
            {visible.map((row) => (
              <div key={row.id} className="rounded-lg border bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-900">{formatDate(row.effective_date)}</span>
                  <ChangeBadge row={row} />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[11px] text-gray-500">Purchase</div>
                    <div className="text-xs font-medium text-gray-900">{fmt(row.purchase_price)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500">Selling</div>
                    <div className="text-xs font-medium text-gray-900">{fmt(row.selling_price)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500">MRP</div>
                    <div className="text-xs font-medium text-gray-900">{fmt(row.mrp)}</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-gray-500">
                  {sourceIcon(row.source)} {sourceLabel(row.source)}
                  {row.note ? ` — ${row.note}` : ''}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 hidden overflow-x-auto rounded-lg border bg-white sm:block">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Change</th>
                  <th className="px-3 py-2 text-right">Purchase</th>
                  <th className="px-3 py-2 text-right">Selling</th>
                  <th className="px-3 py-2 text-right">MRP</th>
                  <th className="px-3 py-2 text-left">Source</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(row.effective_date)}</td>
                    <td className="px-3 py-2"><ChangeBadge row={row} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{fmt(row.purchase_price)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-gray-900">{fmt(row.selling_price)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{fmt(row.mrp)}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      <div>{sourceIcon(row.source)} {sourceLabel(row.source)}</div>
                      {row.note && <div className="mt-0.5 text-gray-500">{row.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length > 5 && (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              {expanded ? 'Show less' : `Show all ${rows.length} changes`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
