'use client'

import { useState, useEffect, useRef } from 'react'
import { fmt } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'
import { getBillProductName } from '@/lib/productNames'
import { fetchSuggestionCandidates, buildAutoFillPlanWithFallback, MAX_VARIANCE_PCT } from '@/lib/billSuggestions'

/**
 * Auto-fill a bill to an approximate value.
 * Props:
 *   rateFor(product)  — rate the bill row would use for a product
 *   onApply(lines)    — apply the generated lines to the bill
 *   onClose()
 */
export default function AutoBillModal({ rateFor, onApply, onClose }) {
  const { shop } = useShop()
  const [amount, setAmount] = useState('')
  const [maxLines, setMaxLines] = useState(8)
  const [plan, setPlan] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const candidatesRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function generate() {
    const target = parseFloat(amount)
    if (!Number.isFinite(target) || target <= 0) {
      setError('Enter a bill amount first')
      return
    }
    if (!shop?.id) { setError('Shop not loaded'); return }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError('Auto fill needs an internet connection')
      return
    }

    setLoading(true)
    setError('')
    try {
      if (!candidatesRef.current?.pool?.length) {
        candidatesRef.current = await fetchSuggestionCandidates(shop.id)
      }
      const candidates = candidatesRef.current
      if (!candidates.pool.length) {
        setPlan(null)
        setError('No items in stock to bill — add stock first')
        return
      }

      const built = buildAutoFillPlanWithFallback(candidates, target, {
        rateFor,
        maxLines: Math.max(1, Number(maxLines) || 8),
      })
      if (!built.lines.length) {
        setPlan(null)
        setError('Could not reach that amount with the available items')
        return
      }
      setPlan({ ...built, target })
    } catch (err) {
      setPlan(null)
      setError(err?.message || 'Auto fill failed')
    } finally {
      setLoading(false)
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (plan) onApply(plan.lines)
      else generate()
    }
  }

  const diff = plan ? plan.total - plan.target : 0
  const diffPct = plan && plan.target ? (diff / plan.target) * 100 : 0
  const inBand = Math.abs(diffPct) <= MAX_VARIANCE_PCT
  // Stock simply cannot reach the band — say so instead of showing a silent shortfall.
  const shortOfStock = plan && plan.maxPossible > 0 && !inBand && plan.total < plan.target

  return (
    <div className="no-print fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/40 px-3 py-6 sm:py-12">
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-base font-semibold text-gray-900">Auto fill bill by amount</div>
            <div className="text-xs text-gray-500">
              Picks in-stock items that are not on your last 2 invoices · lands within ±{MAX_VARIANCE_PCT}%
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-3 py-1 text-sm text-gray-600 hover:bg-gray-50"
          >
            Close
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-end gap-3 border-b px-4 py-3">
          <label className="flex min-w-0 flex-1 flex-col text-xs font-medium text-gray-600 sm:flex-none">
            Target bill value (₹)
            <input
              ref={inputRef}
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setPlan(null) }}
              onKeyDown={handleKey}
              placeholder="1000"
              className="mt-1 w-full rounded border px-2 py-2 text-sm sm:w-40 sm:py-1.5"
            />
          </label>

          <label className="flex w-24 shrink-0 flex-col text-xs font-medium text-gray-600 sm:w-auto">
            Max items
            <input
              type="number"
              min="1"
              max="30"
              step="1"
              value={maxLines}
              onChange={(e) => { setMaxLines(e.target.value); setPlan(null) }}
              onKeyDown={handleKey}
              className="mt-1 w-full rounded border px-2 py-2 text-sm sm:w-24 sm:py-1.5"
            />
          </label>

          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 sm:w-auto sm:py-1.5"
          >
            {loading ? 'Picking…' : plan ? 'Shuffle again' : 'Generate items'}
          </button>
        </div>

        {error && (
          <div className="px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        {plan && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left sm:px-4">Item</th>
                    <th className="px-1 py-2 text-right sm:px-2">Qty</th>
                    <th className="px-1 py-2 text-right sm:px-2">Rate</th>
                    <th className="px-3 py-2 text-right sm:px-4">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((line) => (
                    <tr key={line.product.id} className="border-t">
                      <td className="px-3 py-2 sm:px-4">
                        <div className="font-medium text-gray-900">{getBillProductName(line.product)}</div>
                        <div className="text-xs text-gray-500">
                          {line.product.stock_qty} in stock · GST {line.product.gst_rate || 0}%
                        </div>
                      </td>
                      <td className="px-1 py-2 text-right tabular-nums sm:px-2">{line.quantity}</td>
                      <td className="px-1 py-2 text-right tabular-nums sm:px-2">{fmt(line.rate)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums sm:px-4">{fmt(line.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {plan.relaxed && plan.tier?.note && (
              <div className="shrink-0 border-t bg-sky-50 px-4 py-2 text-xs text-sky-800">
                Fresh items ran out — this bill {plan.tier.note} to reach the amount.
              </div>
            )}

            {shortOfStock && (
              <div className="shrink-0 border-t bg-amber-50 px-4 py-2 text-xs text-amber-800">
                {plan.poolCeiling > plan.maxPossible && plan.poolCeiling >= plan.target
                  ? <>Only {plan.lines.length} items fit this bill — raise “Max items” to reach {fmt(plan.target)}.</>
                  : <>Stock on hand only reaches about {fmt(plan.poolCeiling || plan.maxPossible)} at realistic quantities — restock or lower the target to bill {fmt(plan.target)}.</>}
              </div>
            )}

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
              <div className="text-sm text-gray-600">
                Total <span className="font-semibold text-gray-900">{fmt(plan.total)}</span>
                {' '}vs target {fmt(plan.target)}
                <span className={`ml-2 text-xs font-semibold ${inBand ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {diff >= 0 ? '+' : '−'}{fmt(Math.abs(diff))} ({diffPct >= 0 ? '+' : '−'}{Math.abs(diffPct).toFixed(1)}%)
                </span>
              </div>
              <button
                type="button"
                onClick={() => onApply(plan.lines)}
                className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 sm:w-auto sm:py-1.5"
              >
                Add {plan.lines.length} item{plan.lines.length > 1 ? 's' : ''} to bill
              </button>
            </div>
          </>
        )}

        {!plan && !error && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            Enter an amount — items are picked so the bill value lands close to it.
          </div>
        )}
      </div>
    </div>
  )
}
