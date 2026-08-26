'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import Link from 'next/link'

export default function InventoryPage() {
  const { shop } = useShop()
  const [search,   setSearch]   = useState('')
  const [filter,   setFilter]   = useState('all')
  const [catId,    setCatId]    = useState('')
  const debouncedSearch = useDebouncedValue(search)
  const cacheKey = shop?.id ? `inventory:${shop.id}:${debouncedSearch}:${filter}:${catId}` : ''
  const catsCacheKey = shop?.id ? `inventory-categories:${shop.id}` : ''
  const initialListCache = readPageCache(cacheKey)
  const initialCatsCache = readPageCache(catsCacheKey)
  const [products, setProducts] = useState(() => initialListCache?.products || [])
  const [loading,  setLoading]  = useState(() => !initialListCache)
  const [cats,     setCats]     = useState(() => initialCatsCache?.cats || [])
  usePageLoadingState('inventory-page', loading)

  useEffect(() => {
    if (!shop?.id) return

    const cached = readPageCache(catsCacheKey)
    if (cached?.cats) setCats(cached.cats)

    supabase
      .from('categories')
      .select('id,name,shop_id')
      .eq('shop_id', shop.id)
      .order('name')
      .then(({ data }) => {
        const nextCats = data || []
        setCats(nextCats)
        writePageCache(catsCacheKey, { cats: nextCats })
      })
  }, [catsCacheKey, shop?.id])

  const load = useCallback(async () => {
    if (!shop?.id) {
      setProducts([])
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.products) {
      setProducts(cached.products)
      setLoading(false)
    } else {
      setLoading(true)
    }

    let q = supabase
      .from('products')
      .select('id,name,brand,barcode,unit,purchase_price,mrp,selling_price,gst_rate,stock_qty,min_stock,is_active,suppliers(name),categories(name)')
      .eq('shop_id', shop.id)
      .order('name')
      .limit(200)

    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase()
      q = q.or(`search_text.ilike.%${term}%,name.ilike.%${term}%,brand.ilike.%${term}%,barcode.ilike.%${term}%,hsn_code.ilike.%${term}%`)
    }
    if (filter === 'low')     q = q.gt('min_stock', 0)   // further filtered client-side
    if (filter === 'out')     q = q.lte('stock_qty', 0)
    if (filter === 'inactive')q = q.eq('is_active', false)
    else                      q = q.eq('is_active', true)
    if (catId)                q = q.eq('category_id', catId)

    const { data } = await q
    let rows = data || []
    if (filter === 'low') rows = rows.filter(p => p.stock_qty <= p.min_stock)
    setProducts(rows)
    writePageCache(cacheKey, { products: rows })
    setLoading(false)
  }, [cacheKey, catId, debouncedSearch, filter, shop?.id])

  useEffect(() => { load() }, [load])

  async function toggleActive(id, val) {
    await supabase.from('products').update({ is_active: val }).eq('id', id).eq('shop_id', shop?.id)
    load()
  }

  const lowCount = products.filter(p => p.stock_qty > 0 && p.stock_qty <= p.min_stock).length
  const outCount = products.filter(p => p.stock_qty <= 0).length

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Inventory</h1>
          <div className="flex gap-3 text-xs mt-0.5">
            {outCount > 0 && <span className="text-red-600 font-medium">⚠ {outCount} out of stock</span>}
            {lowCount > 0 && <span className="text-yellow-600 font-medium">⚡ {lowCount} low stock</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/categories"
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
          >
            Categories
          </Link>
          <Link
            href="/inventory/new"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            + Add Product
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input
          autoFocus
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search by name, barcode, brand, HSN…"
          className="flex-1 min-w-48 border rounded-lg px-3 py-2 text-sm"
        />
        {search !== debouncedSearch && (
          <span className="self-center text-xs text-blue-600">Searching…</span>
        )}
        <select value={catId} onChange={e => setCatId(e.target.value)}
          className="border rounded-lg px-2 py-2 text-sm">
          <option value="">All Categories</option>
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filter} onChange={e => setFilter(e.target.value)}
          className="border rounded-lg px-2 py-2 text-sm">
          <option value="all">All Active</option>
          <option value="low">Low Stock</option>
          <option value="out">Out of Stock</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <LoadingPlaceholder label="Loading inventory" rows={4} fullPage />
      ) : products.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No products found</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                {['Product','Brand','Barcode','Cat','Unit','Purchase','MRP','Selling','GST%','Stock','Supplier',''].map(h => (
                  <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map(p => {
                const isOut = p.stock_qty <= 0
                const isLow = !isOut && p.min_stock > 0 && p.stock_qty <= p.min_stock
                return (
                  <tr key={p.id}
                    className={`border-b hover:bg-gray-50 ${isOut ? 'bg-red-50' : isLow ? 'bg-yellow-50' : ''}`}
                  >
                    <td className="px-3 py-2 font-medium max-w-[180px] truncate" title={p.name}>{p.name}</td>
                    <td className="px-3 py-2 text-gray-500">{p.brand || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">{p.barcode || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{p.categories?.name || '—'}</td>
                    <td className="px-3 py-2 text-center text-xs">{p.unit}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(p.purchase_price)}</td>
                    <td className="px-3 py-2 text-right">{fmt(p.mrp)}</td>
                    <td className="px-3 py-2 text-right font-medium text-blue-700">{fmt(p.selling_price || p.mrp)}</td>
                    <td className="px-3 py-2 text-center">{p.gst_rate}%</td>
                    <td className={`px-3 py-2 text-right font-semibold ${
                      isOut ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-green-700'
                    }`}>
                      {p.stock_qty}
                      {isOut && ' ⚠'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-400">{p.suppliers?.name || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/inventory/${p.id}`}
                        className="text-blue-600 hover:underline text-xs mr-2">Edit</Link>
                      <button
                        onClick={() => toggleActive(p.id, !p.is_active)}
                        className={`text-xs ${p.is_active ? 'text-gray-400 hover:text-red-500' : 'text-green-600 hover:text-green-700'}`}
                      >
                        {p.is_active ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="px-3 py-2 text-xs text-gray-400">{products.length} products</div>
        </div>
      )}
    </div>
  )
}
