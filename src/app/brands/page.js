'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { fmt, formatQty } from '@/lib/gst'
import {
  cleanBrandName,
  clearBrand,
  findDuplicateBrandGroups,
  loadBrandSummary,
  looksLikeSameBrand,
  mergeBrands,
  normalizeBrandKey,
} from '@/lib/brands'

export default function BrandsPage() {
  const { shop } = useShop()
  const [brands, setBrands] = useState([])
  const [unbrandedCount, setUnbrandedCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [editingName, setEditingName] = useState('')
  const [editingValue, setEditingValue] = useState('')
  const [mergeSource, setMergeSource] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [groupTargets, setGroupTargets] = useState({})
  usePageLoadingState('brands-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setBrands([])
      setUnbrandedCount(0)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const summary = await loadBrandSummary(shop.id)
      setBrands(summary.brands)
      setUnbrandedCount(summary.unbrandedCount)
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load brands')
      setBrands([])
    } finally {
      setLoading(false)
    }
  }, [shop?.id])

  useEffect(() => { load() }, [load])

  const duplicateGroups = useMemo(() => findDuplicateBrandGroups(brands), [brands])

  const visibleBrands = useMemo(() => {
    const term = search.trim()
    if (!term) return brands
    const lower = term.toLowerCase()
    const key = normalizeBrandKey(term)
    // Fuzzy so a misspelled search still finds the brand it belongs to.
    return brands.filter((brand) => (
      brand.name.toLowerCase().includes(lower)
      || (key && normalizeBrandKey(brand.name).includes(key))
      || looksLikeSameBrand(brand.name, term)
    ))
  }, [brands, search])

  const totals = useMemo(() => brands.reduce((acc, brand) => ({
    products: acc.products + brand.productCount,
    stockValue: acc.stockValue + brand.stockValue,
  }), { products: 0, stockValue: 0 }), [brands])

  async function runMerge(sources, target, busyKey) {
    setBusy(busyKey)
    setError('')
    setNotice('')
    try {
      const moved = await mergeBrands(shop?.id, sources, target)
      setNotice(moved
        ? `Moved ${moved} product(s) to "${cleanBrandName(target)}".`
        : 'Nothing to merge — products already use that brand.')
      await load()
    } catch (err) {
      setError(err.message || 'Merge failed')
    } finally {
      setBusy('')
    }
  }

  async function saveRename(brand) {
    const next = cleanBrandName(editingValue)
    if (!next) return
    if (next === brand.name) {
      setEditingName('')
      return
    }
    const existing = brands.find((item) => (
      item.name !== brand.name && normalizeBrandKey(item.name) === normalizeBrandKey(next)
    ))
    if (existing && !confirm(`"${existing.name}" already exists. Merge "${brand.name}" into it?`)) return

    await runMerge([brand.name], existing ? existing.name : next, `rename:${brand.name}`)
    setEditingName('')
    setEditingValue('')
  }

  async function removeBrand(brand) {
    if (!confirm(`Clear the brand on ${brand.productCount} product(s) of "${brand.name}"? The products themselves are kept.`)) return
    setBusy(`clear:${brand.name}`)
    setError('')
    setNotice('')
    try {
      const cleared = await clearBrand(shop.id, brand.name)
      setNotice(`Cleared brand on ${cleared} product(s).`)
      await load()
    } catch (err) {
      setError(err.message || 'Failed to clear brand')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="p-3 sm:p-4 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="min-w-0">
          <div className="text-sm text-gray-500">
            <Link href="/inventory" className="hover:underline">← Back to Inventory</Link>
          </div>
          <h1 className="text-xl font-bold">Brands</h1>
          <p className="text-xs text-gray-500 mt-1">
            Merge misspelled brands so every product reports under one correct name.
          </p>
        </div>
        <div className="text-sm text-gray-500 sm:text-right">
          <div>{brands.length} brands</div>
          <div className="text-xs">{totals.products} products · {fmt(totals.stockValue)} stock</div>
        </div>
      </div>

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{notice}</div>}

      {loading ? (
        <LoadingPlaceholder label="Loading brands" rows={6} fullPage />
      ) : (
        <>
          {duplicateGroups.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
              <div className="font-semibold text-amber-900 text-sm mb-1">
                ⚠️ {duplicateGroups.length} possible duplicate brand group(s)
              </div>
              <p className="text-xs text-amber-800 mb-3">
                These names look like spellings of the same brand. Pick the correct one and merge — every product moves to it.
              </p>
              <div className="space-y-3">
                {duplicateGroups.map((group) => {
                  const target = groupTargets[group.id] || group.suggested
                  const busyKey = `group:${group.id}`
                  return (
                    <div key={group.id} className="bg-white border border-amber-200 rounded-lg p-3">
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {group.members.map((member) => (
                          <span key={member.name} className="text-xs bg-gray-100 text-gray-700 rounded px-2 py-1">
                            {member.name} <span className="text-gray-400">({member.productCount})</span>
                          </span>
                        ))}
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                        <label className="text-xs text-gray-600">Keep</label>
                        <select
                          value={target}
                          onChange={(e) => setGroupTargets((prev) => ({ ...prev, [group.id]: e.target.value }))}
                          className="flex-1 border rounded-lg px-3 py-2 text-sm"
                        >
                          {group.members.map((member) => (
                            <option key={member.name} value={member.name}>
                              {member.name} ({member.productCount} products)
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => runMerge(group.members.map((member) => member.name), target, busyKey)}
                          disabled={busy === busyKey}
                          className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
                        >
                          {busy === busyKey ? 'Merging…' : `Merge ${group.members.length} → 1`}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border p-4 mb-4">
            <div className="text-sm font-semibold text-gray-800 mb-2">Manual merge</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={mergeSource}
                onChange={(e) => setMergeSource(e.target.value)}
                className="flex-1 border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Move products from…</option>
                {brands.map((brand) => (
                  <option key={brand.name} value={brand.name}>{brand.name} ({brand.productCount})</option>
                ))}
              </select>
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                className="flex-1 border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">…into</option>
                {brands.filter((brand) => brand.name !== mergeSource).map((brand) => (
                  <option key={brand.name} value={brand.name}>{brand.name} ({brand.productCount})</option>
                ))}
              </select>
              <button
                type="button"
                onClick={async () => {
                  await runMerge([mergeSource], mergeTarget, 'manual')
                  setMergeSource('')
                  setMergeTarget('')
                }}
                disabled={!mergeSource || !mergeTarget || busy === 'manual'}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {busy === 'manual' ? 'Merging…' : 'Merge'}
              </button>
            </div>
          </div>

          <div className="mb-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Search brand"
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {brands.length === 0 ? (
            <div className="bg-white rounded-xl border p-8 text-center text-gray-400">
              No brands yet — set a brand while adding inventory items.
            </div>
          ) : (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="divide-y">
                {visibleBrands.map((brand) => {
                  const renameKey = `rename:${brand.name}`
                  const clearKey = `clear:${brand.name}`
                  return (
                    <div key={brand.name} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2">
                      {editingName === brand.name ? (
                        <>
                          <input
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value.toUpperCase())}
                            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), saveRename(brand))}
                            className="flex-1 border rounded-lg px-3 py-2 text-sm"
                            autoFocus
                          />
                          <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2">
                            <button
                              type="button"
                              onClick={() => saveRename(brand)}
                              disabled={busy === renameKey || !editingValue.trim()}
                              className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
                            >
                              {busy === renameKey ? '…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setEditingName(''); setEditingValue('') }}
                              className="px-3 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex-1 min-w-0">
                            <Link
                              href={`/brands/${encodeURIComponent(brand.name)}`}
                              className="font-medium text-gray-900 truncate block hover:text-blue-700 hover:underline"
                            >
                              {brand.name}
                            </Link>
                            <div className="text-xs text-gray-400">
                              {brand.productCount} product(s) · {brand.activeCount} active · {formatQty(brand.stockQty)} in stock · {fmt(brand.stockValue)}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2">
                            <Link
                              href={`/brands/${encodeURIComponent(brand.name)}`}
                              className="px-3 py-2 rounded-lg bg-blue-50 text-blue-700 text-sm hover:bg-blue-100 text-center"
                            >
                              Report
                            </Link>
                            <Link
                              href={`/inventory?brand=${encodeURIComponent(brand.name)}`}
                              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200 text-center"
                            >
                              Products
                            </Link>
                            <button
                              type="button"
                              onClick={() => { setEditingName(brand.name); setEditingValue(brand.name) }}
                              className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              onClick={() => removeBrand(brand)}
                              disabled={busy === clearKey}
                              className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm hover:bg-red-100 disabled:opacity-50"
                            >
                              {busy === clearKey ? '…' : 'Clear'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {unbrandedCount > 0 && (
            <div className="mt-3 text-xs text-gray-500">{unbrandedCount} product(s) have no brand set.</div>
          )}
        </>
      )}
    </div>
  )
}
