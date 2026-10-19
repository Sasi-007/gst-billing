'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { fetchAllRows } from '@/lib/supabaseBatch'
import { clearPageCacheByPrefix } from '@/lib/pageCache'

/**
 * Bulk rate update.
 *
 * When a supplier revises a whole price list, editing twenty products one form
 * at a time is the slow path people avoid — so rates quietly go stale. This
 * screen edits many products in one pass and still records one history row per
 * product, because the database trigger on `products` logs every change and
 * each product is sent as its own update tagged `last_price_source: 'bulk'`.
 */

const RATE_FIELDS = [
  { key: 'purchase_price', label: 'Purchase', short: 'Buy' },
  { key: 'selling_price', label: 'Selling', short: 'Sell' },
  { key: 'mrp', label: 'MRP', short: 'MRP' },
]

const PRODUCT_COLUMNS =
  'id,name,local_name,brand,unit,barcode,purchase_price,selling_price,mrp,category_id,supplier_id,is_active'

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function round2(value) {
  return Math.round(num(value) * 100) / 100
}

/** '' means "leave this rate alone"; anything else is a new value. */
function isBlank(value) {
  return value === '' || value === null || value === undefined
}

function matches(product, terms) {
  if (!terms.length) return true
  const haystack = [product.name, product.local_name, product.brand, product.barcode]
    .join(' ')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export default function BulkRatesPage() {
  const { shop, loading: shopLoading } = useShop()

  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const debouncedQuery = useDebouncedValue(query, 180)

  // product_id -> { purchase_price, selling_price, mrp } of raw input strings
  const [drafts, setDrafts] = useState({})
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null)

  const [adjustPercent, setAdjustPercent] = useState('')
  const [adjustField, setAdjustField] = useState('selling_price')

  usePageLoadingState('bulk-rates-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) return
    setLoading(true)
    setError('')
    try {
      const [productRows, categoryRows, supplierRows] = await Promise.all([
        fetchAllRows(() => supabase
          .from('products')
          .select(PRODUCT_COLUMNS)
          .eq('shop_id', shop.id)
          .order('name')),
        fetchAllRows(() => supabase.from('categories').select('id,name').eq('shop_id', shop.id).order('name')),
        fetchAllRows(() => supabase.from('suppliers').select('id,name').eq('shop_id', shop.id).order('name')),
      ])
      setProducts(productRows)
      setCategories(categoryRows)
      setSuppliers(supplierRows)
    } catch (err) {
      setError(err.message || 'Failed to load products')
    } finally {
      setLoading(false)
    }
  }, [shop?.id])

  useEffect(() => { load() }, [load])

  const terms = useMemo(
    () => debouncedQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [debouncedQuery]
  )

  const visible = useMemo(() => products.filter((product) => (
    matches(product, terms)
    && (!categoryId || product.category_id === categoryId)
    && (!supplierId || product.supplier_id === supplierId)
  )), [products, terms, categoryId, supplierId])

  /**
   * Only rates that actually differ from the stored value count as edits —
   * otherwise re-typing the same number would write a no-op history row.
   */
  const pendingChanges = useMemo(() => {
    const changes = []
    products.forEach((product) => {
      const draft = drafts[product.id]
      if (!draft) return

      const updates = {}
      RATE_FIELDS.forEach(({ key }) => {
        const raw = draft[key]
        if (isBlank(raw) || !Number.isFinite(Number(raw))) return
        const next = round2(raw)
        if (next === round2(product[key])) return
        updates[key] = next
      })

      if (Object.keys(updates).length) changes.push({ product, updates })
    })
    return changes
  }, [products, drafts])

  const setDraftValue = useCallback((productId, key, value) => {
    setDrafts((prev) => ({
      ...prev,
      [productId]: { ...(prev[productId] || {}), [key]: value },
    }))
    setSaveResult(null)
  }, [])

  /** Fills the draft of every *currently visible* product with current ± X%. */
  const applyPercent = useCallback(() => {
    const percent = Number(adjustPercent)
    if (!Number.isFinite(percent) || percent === 0) return

    setDrafts((prev) => {
      const next = { ...prev }
      visible.forEach((product) => {
        const base = num(product[adjustField])
        if (base <= 0) return
        const value = round2(base * (1 + percent / 100))
        next[product.id] = { ...(next[product.id] || {}), [adjustField]: String(value) }
      })
      return next
    })
    setSaveResult(null)
  }, [adjustPercent, adjustField, visible])

  const clearDrafts = useCallback(() => {
    setDrafts({})
    setSaveResult(null)
  }, [])

  async function handleSave() {
    if (!pendingChanges.length || saving) return
    setSaving(true)
    setError('')
    setSaveResult(null)

    const trimmedNote = note.trim()
    const failures = []
    let succeeded = 0

    // One update per product: the trigger needs each product's own before and
    // after values to write a correct history row.
    for (const { product, updates } of pendingChanges) {
      const { error: updateError } = await supabase
        .from('products')
        .update({
          ...updates,
          last_price_source: 'bulk',
          last_price_note: trimmedNote || null,
        })
        .eq('id', product.id)
        .eq('shop_id', shop.id)

      if (updateError) {
        failures.push({ name: product.name, message: updateError.message })
      } else {
        succeeded += 1
      }
    }

    // Billing and inventory read cached product lists; stale rates there would
    // undo the point of this screen.
    clearPageCacheByPrefix([`inventory:${shop.id}:`])
    await load()
    setDrafts({})
    setNote('')
    setSaving(false)
    setSaveResult({ succeeded, failures })
    if (failures.length) {
      setError(`${failures.length} product(s) could not be updated. ${failures[0].message}`)
    }
  }

  if (shopLoading || loading) {
    return <LoadingPlaceholder label="Loading products" rows={5} fullPage />
  }

  return (
    <div className="p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-gray-900 sm:text-xl">Bulk rate update</h1>
          <p className="text-xs text-gray-500 sm:text-sm">
            Revise many rates at once. Every change is saved to the product&apos;s rate history.
          </p>
        </div>
        <Link href="/inventory" className="text-sm text-blue-600 hover:underline">Back to Inventory</Link>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {saveResult && !saveResult.failures.length && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          Updated {saveResult.succeeded} product{saveResult.succeeded === 1 ? '' : 's'}.
        </div>
      )}

      <div className="rounded-xl border bg-white p-3 shadow-sm">
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, brand or barcode"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
          <select
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">All suppliers</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
          <div>
            <label className="block text-[11px] text-gray-500">Adjust</label>
            <select
              value={adjustField}
              onChange={(event) => setAdjustField(event.target.value)}
              className="rounded-lg border px-2 py-2 text-sm"
            >
              {RATE_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>{field.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-gray-500">Percent</label>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={adjustPercent}
              onChange={(event) => setAdjustPercent(event.target.value)}
              placeholder="e.g. 5 or -3"
              className="w-28 rounded-lg border px-2 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={applyPercent}
            className="rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
            disabled={!adjustPercent || !visible.length}
          >
            Apply to {visible.length} shown
          </button>
          {Object.keys(drafts).length > 0 && (
            <button
              type="button"
              onClick={clearDrafts}
              className="rounded-lg border px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Clear edits
            </button>
          )}
        </div>

        <p className="mt-2 text-[11px] text-gray-400">
          Leave a box empty to keep that rate unchanged. Only values that actually differ are saved.
        </p>
      </div>

      {!visible.length ? (
        <div className="mt-3 rounded-xl border bg-white p-6 text-center text-sm text-gray-500">
          No products match these filters.
        </div>
      ) : (
        <>
          {/* Phone: one card per product */}
          <div className="mt-3 space-y-2 sm:hidden">
            {visible.map((product) => (
              <div key={product.id} className="rounded-xl border bg-white p-3 shadow-sm">
                <div className="text-sm font-semibold text-gray-900">{product.name}</div>
                <div className="text-[11px] text-gray-500">
                  {[product.local_name, product.brand, product.unit].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {RATE_FIELDS.map((field) => (
                    <div key={field.key}>
                      <label className="block text-[10px] text-gray-500">
                        {field.short} · now {fmt(num(product[field.key]))}
                      </label>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        value={drafts[product.id]?.[field.key] ?? ''}
                        onChange={(event) => setDraftValue(product.id, field.key, event.target.value)}
                        placeholder="—"
                        className="w-full rounded-lg border px-2 py-2 text-sm"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Tablet and up: dense table */}
          <div className="mt-3 hidden overflow-x-auto rounded-xl border bg-white shadow-sm sm:block">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  {RATE_FIELDS.map((field) => (
                    <th key={field.key} className="px-3 py-2 text-right">{field.label} (now)</th>
                  ))}
                  {RATE_FIELDS.map((field) => (
                    <th key={`new-${field.key}`} className="px-3 py-2 text-right">New {field.label.toLowerCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((product) => (
                  <tr key={product.id} className="align-middle">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">{product.name}</div>
                      <div className="text-[11px] text-gray-500">
                        {[product.local_name, product.brand, product.unit].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    {RATE_FIELDS.map((field) => (
                      <td key={field.key} className="px-3 py-2 text-right text-gray-600">
                        {fmt(num(product[field.key]))}
                      </td>
                    ))}
                    {RATE_FIELDS.map((field) => (
                      <td key={`new-${field.key}`} className="px-3 py-2 text-right">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={drafts[product.id]?.[field.key] ?? ''}
                          onChange={(event) => setDraftValue(product.id, field.key, event.target.value)}
                          placeholder="—"
                          className="w-24 rounded-lg border px-2 py-1.5 text-right text-sm"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Sticky save bar — stays reachable part-way down a long list, and sits
          above the mobile bottom nav rather than behind it. */}
      <div className="sticky bottom-16 z-20 -mx-3 mt-3 border-t bg-white/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4 lg:bottom-0">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Reason for rate change (optional)"
            className="w-full rounded-lg border px-3 py-2 text-sm sm:flex-1"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500">
              {pendingChanges.length} change{pendingChanges.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={handleSave}
              disabled={!pendingChanges.length || saving}
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save rate changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
