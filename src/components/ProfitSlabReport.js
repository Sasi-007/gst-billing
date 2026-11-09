'use client'

import { useMemo, useState, Fragment } from 'react'
import Link from 'next/link'
import { fmt } from '../lib/gst'
import { buildProfitBySlab } from '../lib/salesAnalysis'

const SORT_OPTIONS = [
  { key: 'profit', label: 'Profit (high → low)' },
  { key: 'profitAsc', label: 'Profit (low → high)' },
  { key: 'margin', label: 'Margin %' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'date', label: 'Date (newest)' },
]

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

function marginText(value) {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`
}

// Ranks invoices by the profit they earned, and lets that profit be read either
// for the whole bill or for one GST slab inside it — so a bill carrying both 5%
// and 18% lines reports as three separate categories.
export default function ProfitSlabReport({ data, dateFrom, dateTo, searchTerm = '' }) {
  const [slab, setSlab] = useState('all')
  const [sortKey, setSortKey] = useState('profit')
  const [minProfit, setMinProfit] = useState('')
  const [lossOnly, setLossOnly] = useState(false)
  const [expandedIds, setExpandedIds] = useState([])

  const { billRows, slabSummaries } = useMemo(
    () => buildProfitBySlab({ bills: data?.bills || [], items: data?.items || [] }),
    [data],
  )

  const visibleRows = useMemo(() => {
    const term = String(searchTerm || '').trim().toLowerCase()
    const threshold = parseFloat(minProfit)

    const scoped = billRows
      .map((row) => {
        const bucket = slab === 'all' ? row : row.slabByKey[slab]
        if (!bucket) return null
        return { row, bucket }
      })
      .filter(Boolean)
      .filter(({ row }) => (
        !term ||
        String(row.bill_no || '').toLowerCase().includes(term) ||
        String(row.customer_name || '').toLowerCase().includes(term)
      ))
      .filter(({ bucket }) => (lossOnly ? bucket.profit < 0 : true))
      .filter(({ bucket }) => (Number.isFinite(threshold) ? bucket.profit >= threshold : true))

    const sorted = [...scoped]
    sorted.sort((left, right) => {
      if (sortKey === 'profitAsc') return left.bucket.profit - right.bucket.profit
      if (sortKey === 'margin') return (right.bucket.marginPct ?? -Infinity) - (left.bucket.marginPct ?? -Infinity)
      if (sortKey === 'revenue') return right.bucket.revenue - left.bucket.revenue
      if (sortKey === 'date') return String(right.row.date).localeCompare(String(left.row.date))
      return right.bucket.profit - left.bucket.profit
    })
    return sorted
  }, [billRows, slab, sortKey, minProfit, lossOnly, searchTerm])

  const visibleTotals = useMemo(() => visibleRows.reduce((acc, { bucket }) => ({
    revenue: acc.revenue + bucket.revenue,
    cost: acc.cost + bucket.cost,
    profit: acc.profit + bucket.profit,
    gst: acc.gst + bucket.gst,
  }), { revenue: 0, cost: 0, profit: 0, gst: 0 }), [visibleRows])

  function toggleExpanded(id) {
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]))
  }

  function handleExport() {
    const rows = visibleRows.map(({ row, bucket }) => ({
      Date: row.date,
      'Bill No': row.bill_no,
      Customer: row.customer_name || '',
      Category: slab === 'all' ? 'All slabs' : `${slab}%`,
      Revenue: bucket.revenue,
      'Taxable Value': bucket.taxable,
      GST: bucket.gst,
      Cost: bucket.cost,
      Profit: bucket.profit,
      'Margin %': bucket.marginPct ?? '',
      'Slabs In Bill': row.slabs.map((entry) => entry.label).join(' / '),
    }))
    if (!rows.length) return
    downloadCsv(`profit-by-slab-${slab}-${dateFrom}-to-${dateTo}.csv`, Object.keys(rows[0]), rows)
  }

  const categories = [{ key: 'all', label: 'All slabs' }, ...slabSummaries.map((entry) => ({ key: entry.slab, label: entry.label }))]
  const missingCost = billRows.some((row) => !row.hasCostData)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Profit (filtered)', value: fmt(visibleTotals.profit), cls: visibleTotals.profit < 0 ? 'text-red-700' : 'text-emerald-700' },
          { label: 'Revenue', value: fmt(visibleTotals.revenue), cls: 'text-blue-700' },
          { label: 'Cost', value: fmt(visibleTotals.cost), cls: 'text-gray-700' },
          { label: 'Margin On Cost', value: visibleTotals.cost > 0 ? `${((visibleTotals.profit / visibleTotals.cost) * 100).toFixed(1)}%` : '—', cls: 'text-purple-700' },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className={`text-xl font-bold mt-1 ${card.cls}`}>{card.value}</div>
            <div className="text-[11px] text-gray-400">{visibleRows.length} invoice{visibleRows.length === 1 ? '' : 's'}</div>
          </div>
        ))}
      </div>

      {slabSummaries.length > 0 && (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <div className="px-3 py-2 border-b text-xs font-semibold text-gray-600">Profit by GST slab for the period</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['Slab', 'Bills', 'Lines', 'Revenue', 'Taxable', 'GST', 'Cost', 'Profit', 'Margin'].map((header) => (
                  <th key={header} className="px-3 py-2 text-left">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slabSummaries.map((entry) => (
                <tr
                  key={entry.slab}
                  className={`border-b cursor-pointer hover:bg-blue-50 ${slab === entry.slab ? 'bg-blue-50' : ''}`}
                  onClick={() => setSlab(entry.slab)}
                >
                  <td className="px-3 py-1.5 font-semibold">{entry.label}</td>
                  <td className="px-3 py-1.5 text-right">{entry.billCount}</td>
                  <td className="px-3 py-1.5 text-right">{entry.lineCount}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(entry.revenue)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(entry.taxable)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(entry.gst)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(entry.cost)}</td>
                  <td className={`px-3 py-1.5 text-right font-semibold ${entry.profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmt(entry.profit)}</td>
                  <td className="px-3 py-1.5 text-right">{marginText(entry.marginPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-white border rounded-lg p-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-600">Category</span>
        {categories.map((category) => (
          <button
            key={category.key}
            type="button"
            onClick={() => setSlab(category.key)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
              slab === category.key ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {category.label}
          </button>
        ))}
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          className="ml-auto border rounded px-2 py-1 text-xs bg-white"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>
        <label className="text-xs text-gray-600 flex items-center gap-1">
          Profit ≥
          <input
            type="number"
            value={minProfit}
            onChange={(e) => setMinProfit(e.target.value)}
            className="w-24 border rounded px-2 py-1 text-xs"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <input type="checkbox" checked={lossOnly} onChange={(e) => setLossOnly(e.target.checked)} />
          Loss only
        </label>
        <button
          type="button"
          onClick={handleExport}
          disabled={visibleRows.length === 0}
          className="px-3 py-1.5 rounded-lg border bg-white text-gray-700 text-xs font-medium hover:bg-gray-50 disabled:opacity-60"
        >
          Export CSV
        </button>
      </div>

      {missingCost && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Some invoices have no purchase-cost snapshot on their lines, so their profit reads as the full sale value. Keep purchase prices filled in inventory for accurate margins.
        </div>
      )}

      {visibleRows.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
          No invoices match this profit view
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['', 'Date', 'Bill No', 'Customer', 'Slabs', 'Revenue', 'Cost', 'Profit', 'Margin'].map((header, index) => (
                  <th key={`${header}-${index}`} className="px-3 py-2 text-left whitespace-nowrap">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ row, bucket }) => (
                <Fragment key={row.id}>
                  <tr className="border-b hover:bg-gray-50">
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(row.id)}
                        className="text-gray-400 hover:text-blue-700"
                        aria-label={`Show slab split for ${row.bill_no}`}
                      >
                        {expandedIds.includes(row.id) ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="px-3 py-1.5">{new Date(`${row.date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                    <td className="px-3 py-1.5 font-mono font-medium">
                      <Link href={`/billing/${row.id}`} className="text-blue-700 hover:underline">{row.bill_no}</Link>
                    </td>
                    <td className="px-3 py-1.5 text-gray-600">{row.customer_name || '—'}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {row.slabs.map((entry) => (
                          <span
                            key={entry.slab}
                            className={`px-1 rounded text-[10px] font-medium ${
                              slab === entry.slab ? 'bg-blue-200 text-blue-900' : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {entry.label}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">{fmt(bucket.revenue)}</td>
                    <td className="px-3 py-1.5 text-right text-gray-600">{fmt(bucket.cost)}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${bucket.profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmt(bucket.profit)}</td>
                    <td className="px-3 py-1.5 text-right">{marginText(bucket.marginPct)}</td>
                  </tr>
                  {expandedIds.includes(row.id) && (
                    <tr className="border-b bg-gray-50/70">
                      <td className="px-3 py-2" colSpan={9}>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-[11px] text-gray-500">
                              {['Category', 'Lines', 'Qty', 'Revenue', 'Taxable', 'GST', 'Cost', 'Profit', 'Margin'].map((header) => (
                                <th key={header} className="px-2 py-1 text-left">{header}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {row.slabs.map((entry) => (
                              <tr key={entry.slab}>
                                <td className="px-2 py-1 font-medium">{entry.label}</td>
                                <td className="px-2 py-1 text-right">{entry.lineCount}</td>
                                <td className="px-2 py-1 text-right">{entry.quantity}</td>
                                <td className="px-2 py-1 text-right">{fmt(entry.revenue)}</td>
                                <td className="px-2 py-1 text-right">{fmt(entry.taxable)}</td>
                                <td className="px-2 py-1 text-right">{fmt(entry.gst)}</td>
                                <td className="px-2 py-1 text-right">{fmt(entry.cost)}</td>
                                <td className={`px-2 py-1 text-right ${entry.profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmt(entry.profit)}</td>
                                <td className="px-2 py-1 text-right">{marginText(entry.marginPct)}</td>
                              </tr>
                            ))}
                            <tr className="border-t font-semibold">
                              <td className="px-2 py-1">Whole bill</td>
                              <td className="px-2 py-1 text-right">{row.lineCount}</td>
                              <td className="px-2 py-1 text-right">{row.quantity}</td>
                              <td className="px-2 py-1 text-right">{fmt(row.revenue)}</td>
                              <td className="px-2 py-1 text-right">{fmt(row.taxable)}</td>
                              <td className="px-2 py-1 text-right">{fmt(row.gst)}</td>
                              <td className="px-2 py-1 text-right">{fmt(row.cost)}</td>
                              <td className={`px-2 py-1 text-right ${row.profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmt(row.profit)}</td>
                              <td className="px-2 py-1 text-right">{marginText(row.marginPct)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 border-t-2 font-semibold text-gray-800">
                <td className="px-3 py-2" colSpan={5}>
                  {slab === 'all' ? 'All slabs' : `${slab}% slab`} · {visibleRows.length} invoice{visibleRows.length === 1 ? '' : 's'}
                </td>
                <td className="px-3 py-2 text-right">{fmt(visibleTotals.revenue)}</td>
                <td className="px-3 py-2 text-right">{fmt(visibleTotals.cost)}</td>
                <td className={`px-3 py-2 text-right ${visibleTotals.profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmt(visibleTotals.profit)}</td>
                <td className="px-3 py-2" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
