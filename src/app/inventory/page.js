'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { clearPageCacheByPrefix, readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import Link from 'next/link'

const CSV_COLUMNS = [
  'name',
  'local_name',
  'search_aliases',
  'bill_name_mode',
  'brand',
  'barcode',
  'category',
  'unit',
  'purchase_price',
  'mrp',
  'selling_price',
  'gst_rate',
  'stock_qty',
  'min_stock',
  'hsn_code',
  'is_active',
]
const INVENTORY_LIST_LIMIT = 50

function escapeCsv(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"' && inQuotes && next === '"') {
      cell += '"'
      i += 1
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      row.push(cell)
      cell = ''
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function toNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

function toBool(value, fallback = true) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return fallback
  return ['true', 'yes', '1', 'active'].includes(text)
}

function normalizeHeader(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
  return {
    product: 'name',
    product_name: 'name',
    tamil_name: 'local_name',
    tamil_local_name: 'local_name',
    local: 'local_name',
    aliases: 'search_aliases',
    tanglish_aliases: 'search_aliases',
    bill_display_name: 'bill_name_mode',
    cat: 'category',
    category_name: 'category',
    purchase: 'purchase_price',
    purchase_rate: 'purchase_price',
    cost_price: 'purchase_price',
    sale_price: 'selling_price',
    sales_price: 'selling_price',
    selling: 'selling_price',
    gst: 'gst_rate',
    gst_percent: 'gst_rate',
    gst_percentage: 'gst_rate',
    stock: 'stock_qty',
    min_stock_qty: 'min_stock',
    hsn: 'hsn_code',
    active: 'is_active',
  }[key] || key
}

function normalizeBillNameMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return ['english', 'local', 'both'].includes(mode) ? mode : 'english'
}

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
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvMessage, setCsvMessage] = useState('')
  const csvInputRef = useRef(null)
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
      .select('id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,purchase_price,mrp,selling_price,gst_rate,stock_qty,min_stock,hsn_code,category_id,supplier_id,is_active,suppliers(name),categories(name)')
      .eq('shop_id', shop.id)
      .order('name')
      .limit(INVENTORY_LIST_LIMIT)

    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase()
      q = q.or(`search_text.ilike.%${term}%,name.ilike.%${term}%,local_name.ilike.%${term}%,brand.ilike.%${term}%,barcode.ilike.%${term}%,hsn_code.ilike.%${term}%`)
    }
    if (filter === 'low')     q = q.gt('min_stock', 0)   // further filtered client-side
    if (filter === 'out')     q = q.lte('stock_qty', 0)
    if (filter === 'nongst')     q = q.eq('gst_rate', 0)
    if (filter === 'gst')     q = q.gt('gst_rate', 0)
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

  function downloadCsv() {
    const csvRows = [
      CSV_COLUMNS.join(','),
      ...products.map((product) => CSV_COLUMNS.map((column) => {
        if (column === 'category') return escapeCsv(product.categories?.name || '')
        return escapeCsv(product[column])
      }).join(',')),
    ]
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `inventory-${shop?.name || 'shop'}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  function downloadSampleCsv() {
    const sample = [
      CSV_COLUMNS.join(','),
      CSV_COLUMNS.map((column) => escapeCsv({
        name: 'Tata Salt 1KG',
        local_name: 'டாடா உப்பு',
        search_aliases: 'salt, uppu',
        bill_name_mode: 'local',
        brand: 'Tata',
        barcode: '',
        category: 'DAIRY',
        unit: 'pcs',
        purchase_price: '25',
        mrp: '32',
        selling_price: '30',
        gst_rate: '5',
        stock_qty: '20',
        min_stock: '5',
        hsn_code: '',
        is_active: 'true',
      }[column])).join(','),
    ].join('\n')
    const blob = new Blob([sample], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'inventory-upload-sample.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  async function handleCsvUpload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !shop?.id) return

    setCsvBusy(true)
    setCsvMessage('')
    try {
      const rows = parseCsv(await file.text())
      if (rows.length < 2) throw new Error('CSV file has no product rows')

      const headers = rows[0].map(normalizeHeader)
      if (!headers.includes('name')) {
        throw new Error('CSV must have a name or product_name column')
      }
      const categoryByName = new Map(cats.map((cat) => [String(cat.name || '').trim().toLowerCase(), cat.id]))
      let created = 0
      let updated = 0
      let skipped = 0

      for (const [rowIndex, row] of rows.slice(1).entries()) {
        const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
        const name = String(record.name || '').trim()
        if (!name) {
          skipped += 1
          continue
        }

        const aliases = String(record.search_aliases || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        const categoryName = String(record.category || '').trim().toLowerCase()
        const payload = {
          shop_id: shop.id,
          name,
          local_name: String(record.local_name || '').trim() || null,
          search_aliases: aliases,
          bill_name_mode: normalizeBillNameMode(record.bill_name_mode),
          brand: String(record.brand || '').trim() || null,
          barcode: String(record.barcode || '').trim() || null,
          category_id: categoryByName.get(categoryName) || null,
          unit: String(record.unit || '').trim() || 'pcs',
          purchase_price: toNumber(record.purchase_price),
          mrp: toNumber(record.mrp),
          selling_price: toNumber(record.selling_price || record.mrp),
          gst_rate: toNumber(record.gst_rate, 0),
          stock_qty: toNumber(record.stock_qty, 0),
          min_stock: toNumber(record.min_stock, 0),
          hsn_code: String(record.hsn_code || '').trim() || null,
          is_active: toBool(record.is_active, true),
          updated_at: new Date().toISOString(),
        }

        let existing = null
        if (payload.barcode) {
          const { data, error } = await supabase
            .from('products')
            .select('id')
            .eq('shop_id', shop.id)
            .eq('barcode', payload.barcode)
            .limit(1)
          if (error) throw error
          existing = data?.[0] || null
        }
        if (!existing) {
          const { data, error } = await supabase
            .from('products')
            .select('id')
            .eq('shop_id', shop.id)
            .ilike('name', name)
            .limit(1)
          if (error) throw error
          existing = data?.[0] || null
        }

        if (existing?.id) {
          const { error } = await supabase
            .from('products')
            .update(payload)
            .eq('id', existing.id)
            .eq('shop_id', shop.id)
          if (error) throw new Error(`Row ${rowIndex + 2}: ${error.message}`)
          updated += 1
        } else {
          const { error } = await supabase.from('products').insert(payload)
          if (error) throw new Error(`Row ${rowIndex + 2}: ${error.message}`)
          created += 1
        }
      }

      clearPageCacheByPrefix([`inventory:${shop.id}:`])
      setCsvMessage(`CSV uploaded: ${created} added, ${updated} updated, ${skipped} skipped`)
      await load()
    } catch (error) {
      setCsvMessage(`CSV upload failed: ${error.message}`)
    } finally {
      setCsvBusy(false)
    }
  }

  const lowCount = products.filter(p => p.stock_qty > 0 && p.stock_qty <= p.min_stock).length
  const outCount = products.filter(p => p.stock_qty <= 0).length

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Inventory</h1>
          <div className="flex gap-3 text-xs mt-0.5">
            {outCount > 0 && <span className="text-red-600 font-medium">⚠ {outCount} out of stock</span>}
            {lowCount > 0 && <span className="text-yellow-600 font-medium">⚡ {lowCount} low stock</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={downloadCsv}
            className="px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
          >
            Download CSV
          </button>
          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            disabled={csvBusy}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-60"
          >
            {csvBusy ? 'Uploading…' : 'Upload CSV'}
          </button>
          <button
            type="button"
            onClick={downloadSampleCsv}
            className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 text-xs font-medium"
          >
            Sample
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvUpload}
            className="hidden"
          />
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
      {csvMessage && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${
          csvMessage.startsWith('CSV upload failed') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
        }`}>
          {csvMessage}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input
          autoFocus
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search by name, Tamil/local name, Tanglish alias, barcode, brand, HSN…"
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
          <option value="gst">GST Items Only</option>
          <option value="nongst">Non-GST (0%)</option>
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
                    <td className="px-3 py-2 max-w-[220px]" title={[p.name, p.local_name].filter(Boolean).join(' / ')}>
                      <div className="font-medium truncate">{p.name}</div>
                      {p.local_name && <div className="text-xs text-gray-500 truncate">{p.local_name}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-500">{p.brand || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">{p.barcode || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{p.categories?.name || '—'}</td>
                    <td className="px-3 py-2 text-center text-xs">{p.unit}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{fmt(p.purchase_price)}</td>
                    <td className="px-3 py-2 text-right">{fmt(p.mrp)}</td>
                    <td className="px-3 py-2 text-right font-medium text-blue-700">{fmt(p.selling_price || p.mrp)}</td>
                    <td className="px-3 py-2 text-center">
                      {Number(p.gst_rate) > 0
                        ? `${p.gst_rate}%`
                        : <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Non-GST</span>}
                    </td>
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
