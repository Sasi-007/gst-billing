'use client'

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { clearPageCacheByPrefix, readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import InventoryFilterPanel from '@/components/InventoryFilterPanel'
import { countRules, emptyFilterTree, filterTreeToPostgrest, makeGroup, makeRule, treeHasField } from '@/lib/inventoryFilters'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { describeChange, fetchLatestPriceChanges, sourceLabel } from '@/lib/priceHistory'

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
const LIST_SELECT = 'id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,purchase_price,mrp,selling_price,gst_rate,stock_qty,min_stock,hsn_code,category_id,supplier_id,is_active,suppliers(name),categories(name)'
const VALUE_SELECT = 'id,stock_qty,min_stock,purchase_price,selling_price,mrp'

// `column` is what PostgREST orders by. Category and supplier live on joined
// tables, so they order through the embedded resource (`categories(name)`),
// falling back to the product name if the database rejects that form.
const INVENTORY_SORT_COLUMNS = [
  { key: 'name',           label: 'Product',  column: 'name' },
  { key: 'brand',          label: 'Brand',    column: 'brand' },
  { key: 'barcode',        label: 'Barcode',  column: 'barcode' },
  { key: 'category',       label: 'Cat',      column: 'categories(name)', referenced: true },
  { key: 'unit',           label: 'Unit',     column: 'unit', align: 'center' },
  { key: 'purchase_price', label: 'Purchase', column: 'purchase_price', align: 'right' },
  { key: 'mrp',            label: 'MRP',      column: 'mrp', align: 'right' },
  { key: 'selling_price',  label: 'Selling',  column: 'selling_price', align: 'right' },
  { key: 'gst_rate',       label: 'GST%',     column: 'gst_rate', align: 'center' },
  { key: 'stock_qty',      label: 'Stock',    column: 'stock_qty', align: 'right' },
  { key: 'supplier',       label: 'Supplier', column: 'suppliers(name)', referenced: true },
]

function SortArrows({ active, direction }) {
  const upActive = active && direction === 'asc'
  const downActive = active && direction === 'desc'
  return (
    <span className="inline-flex flex-col leading-[0.55rem] ml-1 align-middle">
      <span className={upActive ? 'text-blue-600 text-[11px]' : 'text-gray-300 text-[8px]'}>▲</span>
      <span className={downActive ? 'text-blue-600 text-[11px]' : 'text-gray-300 text-[8px]'}>▼</span>
    </span>
  )
}

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

function supplierFilterTree(supplierId) {
  const rule = makeRule('supplier_id')
  rule.value = supplierId
  return makeGroup('and', [rule])
}

// Stock worth of a set of product rows: cost side uses the purchase price, retail
// side uses selling price (falling back to MRP).
// Only products actually holding stock carry value. Zero-stock rows would add
// nothing but inflate the product count, and negative stock (a data error)
// would wrongly subtract value, so both are excluded and counted separately.
function summarizeStockValue(rows) {
  return (rows || []).reduce((acc, product) => {
    const qty = Number(product.stock_qty) || 0
    if (qty <= 0) {
      acc.emptyProducts += 1
      if (qty < 0) acc.negativeProducts += 1
      return acc
    }
    const cost = Number(product.purchase_price) || 0
    const sale = Number(product.selling_price) || Number(product.mrp) || 0
    acc.products += 1
    acc.units += qty
    acc.purchaseValue += qty * cost
    acc.sellingValue += qty * sale
    if (cost <= 0) acc.missingCost += 1
    return acc
  }, { products: 0, units: 0, purchaseValue: 0, sellingValue: 0, missingCost: 0, emptyProducts: 0, negativeProducts: 0 })
}

function formatHistoryDate(value) {  if (!value) return '—'
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-IN')
}

function PriceDelta({ current, previous }) {
  const now = Number(current || 0)
  const before = Number(previous)
  if (!Number.isFinite(before) || before === 0 || now === before) return null
  const diff = now - before
  const pct = (diff / before) * 100
  return (
    <span className={`ml-1 text-[11px] font-medium ${diff > 0 ? 'text-red-600' : 'text-green-600'}`}>
      {diff > 0 ? '▲' : '▼'} {fmt(Math.abs(diff))} ({Math.abs(pct).toFixed(1)}%)
    </span>
  )
}

// Inline purchase summary for one product: every purchase of it, newest first,
// with the rate/MRP movement against the previous purchase so a supplier price
// or MRP revision is obvious at a glance.
function ProductPurchaseHistory({ shopId, product, colSpan }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!shopId || !product?.id) return
    let cancelled = false

    async function loadHistory() {
      setError('')
      setRows(null)

      const { data: itemRows, error: itemErr } = await supabase
        .from('purchase_bill_items')
        .select('id,purchase_bill_id,quantity,rate,mrp,total,created_at')
        .eq('shop_id', shopId)
        .eq('product_id', product.id)
        .order('created_at', { ascending: false })
        .limit(25)
      if (cancelled) return
      if (itemErr) {
        setError(itemErr.message || 'Failed to load purchase history')
        setRows([])
        return
      }

      const billIds = [...new Set((itemRows || []).map((row) => row.purchase_bill_id).filter(Boolean))]
      const { data: billRows } = billIds.length
        ? await supabase.from('purchase_bills').select('id,bill_no,date,suppliers(name)').in('id', billIds)
        : { data: [] }
      if (cancelled) return

      const billMap = new Map((billRows || []).map((bill) => [bill.id, bill]))
      const merged = (itemRows || [])
        .map((row) => {
          const bill = billMap.get(row.purchase_bill_id)
          return {
            ...row,
            bill_no: bill?.bill_no || '—',
            bill_date: bill?.date || null,
            supplier_name: bill?.suppliers?.name || '—',
          }
        })
        .sort((a, b) => String(b.bill_date || b.created_at || '').localeCompare(String(a.bill_date || a.created_at || '')))

      setRows(merged)
    }

    loadHistory()
    return () => { cancelled = true }
  }, [product?.id, shopId])

  const summary = (rows || []).reduce((acc, row) => {
    const qty = Number(row.quantity) || 0
    acc.qty += qty
    acc.value += Number(row.total) || (qty * (Number(row.rate) || 0))
    return acc
  }, { qty: 0, value: 0 })
  const latest = rows?.[0] || null
  const avgRate = summary.qty > 0 ? summary.value / summary.qty : 0

  const body = (
    <div className="bg-blue-50/60 border-t px-3 py-3">
      {rows === null ? (
        <div className="text-sm text-gray-500">Loading purchase history…</div>
      ) : error ? (
        <div className="text-sm text-red-600">{error}</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500">
          No purchase bills recorded for {product.name} yet. Stock values use the saved purchase price {fmt(product.purchase_price)}.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <div className="rounded-lg border bg-white px-3 py-2">
              <div className="text-[11px] text-gray-500">Last purchase rate</div>
              <div className="text-sm font-semibold text-gray-900">
                {fmt(latest.rate)}
                <PriceDelta current={latest.rate} previous={rows[1]?.rate} />
              </div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <div className="text-[11px] text-gray-500">Last purchase MRP</div>
              <div className="text-sm font-semibold text-gray-900">
                {fmt(latest.mrp)}
                <PriceDelta current={latest.mrp} previous={rows[1]?.mrp} />
              </div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <div className="text-[11px] text-gray-500">Average rate</div>
              <div className="text-sm font-semibold text-gray-900">{fmt(avgRate)}</div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <div className="text-[11px] text-gray-500">Total purchased</div>
              <div className="text-sm font-semibold text-gray-900">{summary.qty} {product.unit}</div>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2">
              <div className="text-[11px] text-gray-500">Total purchase value</div>
              <div className="text-sm font-semibold text-gray-900">{fmt(summary.value)}</div>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Purchase No</th>
                  <th className="px-3 py-2 text-left">Supplier</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">MRP</th>
                  <th className="px-3 py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const older = rows[index + 1]
                  return (
                    <tr key={row.id} className="border-t">
                      <td className="px-3 py-2">{formatHistoryDate(row.bill_date || row.created_at)}</td>
                      <td className="px-3 py-2 font-medium text-gray-900">{row.bill_no}</td>
                      <td className="px-3 py-2 text-gray-600">{row.supplier_name}</td>
                      <td className="px-3 py-2 text-right">{row.quantity}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {fmt(row.rate)}
                        <PriceDelta current={row.rate} previous={older?.rate} />
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {fmt(row.mrp)}
                        <PriceDelta current={row.mrp} previous={older?.mrp} />
                      </td>
                      <td className="px-3 py-2 text-right">{fmt(row.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
            <span>
              Current master: purchase {fmt(product.purchase_price)} · MRP {fmt(product.mrp)} · selling {fmt(product.selling_price || product.mrp)}.
              Each purchase keeps its own rate and MRP, so old bills stay accurate when a supplier revises prices.
            </span>
            <Link href={`/inventory/${product.id}`} className="text-blue-600 hover:underline">
              Open product to apply the latest rate &amp; MRP →
            </Link>
          </div>
        </>
      )}
    </div>
  )

  if (!colSpan) return body
  return (
    <tr className="border-b">
      <td colSpan={colSpan} className="p-0">{body}</td>
    </tr>
  )
}

export default function InventoryPage() {
  const { shop } = useShop()
  const searchParams = useSearchParams()
  const supplierParam = searchParams?.get('supplier') || ''
  const [search,   setSearch]   = useState('')
  const [filter,   setFilter]   = useState('all')
  const [catId,    setCatId]    = useState('')
  const [page,     setPage]     = useState(0)
  // Seeded on the first render so a ?supplier= deep link never fetches unfiltered.
  const [advTree,  setAdvTree]  = useState(() => (
    supplierParam ? supplierFilterTree(supplierParam) : emptyFilterTree()
  ))
  const [showAdvanced, setShowAdvanced] = useState(Boolean(supplierParam))
  const [queryError, setQueryError] = useState('')
  const [selected, setSelected] = useState(() => new Map())
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  // Set when the database rejects ordering through a joined table, so the list
  // silently falls back to product-name order instead of showing no rows.
  const [sortFallback, setSortFallback] = useState('')
  const [expandedProductId, setExpandedProductId] = useState(null)
  const debouncedSearch = useDebouncedValue(search)
  const advFilter = filterTreeToPostgrest(advTree)
  const advCount = countRules(advTree)
  const advUsesActive = treeHasField(advTree, 'is_active')
  const cacheKey = shop?.id ? `inventory:${shop.id}:${debouncedSearch}:${filter}:${catId}:${advFilter}:${sortKey}:${sortDir}:${page}` : ''
  const catsCacheKey = shop?.id ? `inventory-categories:${shop.id}` : ''
  const initialListCache = readPageCache(cacheKey)
  const initialCatsCache = readPageCache(catsCacheKey)
  const [products, setProducts] = useState(() => initialListCache?.products || [])
  const [totalCount, setTotalCount] = useState(() => initialListCache?.totalCount ?? null)
  const [loading,  setLoading]  = useState(() => !initialListCache)
  const [cats,     setCats]     = useState(() => initialCatsCache?.cats || [])
  const [suppliers, setSuppliers] = useState(() => initialCatsCache?.suppliers || [])
  const [csvBusy, setCsvBusy] = useState(false)
  const [latestRateChanges, setLatestRateChanges] = useState(new Map())
  const [matchingTotals, setMatchingTotals] = useState(null)
  const [totalsLoading, setTotalsLoading] = useState(false)
  // Guards against a slower earlier request overwriting newer results.
  const loadSeq = useRef(0)
  const [csvMessage, setCsvMessage] = useState('')
  const csvInputRef = useRef(null)
  usePageLoadingState('inventory-page', loading)

  // Any change to search/filter/category should reset back to page 1.
  useEffect(() => {
    setPage(0)
  }, [debouncedSearch, filter, catId, advFilter, sortKey, sortDir])

  // A row's purchase history belongs to that row only — close it when the list changes.
  useEffect(() => {
    setExpandedProductId(null)
  }, [debouncedSearch, filter, catId, advFilter, sortKey, sortDir, page])

  function handleSort(key) {
    setSortDir((prevDir) => (key === sortKey ? (prevDir === 'asc' ? 'desc' : 'asc') : 'asc'))
    setSortKey(key)
  }

  // Deep link: /inventory?supplier=<id> pre-applies a supplier condition.
  // The initial value is seeded in useState, so this only handles later changes.
  const appliedSupplierParam = useRef(supplierParam)
  useEffect(() => {
    if (appliedSupplierParam.current === supplierParam) return
    appliedSupplierParam.current = supplierParam
    if (!supplierParam) return
    setAdvTree(supplierFilterTree(supplierParam))
    setShowAdvanced(true)
  }, [supplierParam])

  useEffect(() => {
    if (!shop?.id) return

    const cached = readPageCache(catsCacheKey)
    if (cached?.cats) setCats(cached.cats)
    if (cached?.suppliers) setSuppliers(cached.suppliers)

    Promise.all([
      supabase.from('categories').select('id,name,shop_id').eq('shop_id', shop.id).order('name'),
      supabase.from('suppliers').select('id,name').eq('shop_id', shop.id).eq('is_active', true).order('name'),
    ]).then(([catsRes, suppliersRes]) => {
      const nextCats = catsRes.data || []
      const nextSuppliers = suppliersRes.data || []
      setCats(nextCats)
      setSuppliers(nextSuppliers)
      writePageCache(catsCacheKey, { cats: nextCats, suppliers: nextSuppliers })
    })
  }, [catsCacheKey, shop?.id])

  function buildProductsQuery({ select, count, orderColumn }) {
    const sortColumn = INVENTORY_SORT_COLUMNS.find((col) => col.key === sortKey)
    const column = orderColumn || sortColumn?.column || 'name'
    const ascending = sortDir === 'asc'

    let q = supabase
      .from('products')
      .select(select, count ? { count } : undefined)
      .eq('shop_id', shop.id)
      .order(column, { ascending, nullsFirst: false })
    if (column !== 'name') q = q.order('name', { ascending: true })

    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase()
      q = q.or(`search_text.ilike.%${term}%,name.ilike.%${term}%,local_name.ilike.%${term}%,brand.ilike.%${term}%,barcode.ilike.%${term}%,hsn_code.ilike.%${term}%`)
    }
    if (filter === 'low')     q = q.gt('min_stock', 0)   // further filtered client-side
    if (filter === 'out')     q = q.lte('stock_qty', 0)
    if (filter === 'instock') q = q.neq('stock_qty', 0)
    if (filter === 'nongst')  q = q.eq('gst_rate', 0)
    if (filter === 'gst')     q = q.gt('gst_rate', 0)
    if (filter === 'inactive')q = q.eq('is_active', false)
    else if (!advUsesActive)  q = q.eq('is_active', true)
    if (catId)                q = q.eq('category_id', catId)
    if (advFilter)            q = q.or(advFilter)

    return q
  }

  const load = useCallback(async () => {
    if (!shop?.id) {
      setProducts([])
      setTotalCount(0)
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.products) {
      setProducts(cached.products)
      setTotalCount(cached.totalCount ?? null)
      setLoading(false)
    } else {
      setLoading(true)
    }

    const from = page * INVENTORY_LIST_LIMIT
    const to = from + INVENTORY_LIST_LIMIT - 1
    const seq = ++loadSeq.current
    const sortColumn = INVENTORY_SORT_COLUMNS.find((col) => col.key === sortKey)
    let { data, count, error } = await buildProductsQuery({
      select: LIST_SELECT,
      count: 'exact',
    }).range(from, to)

    // Ordering through a joined table is not supported everywhere — retry on the
    // product name so a sort click can never leave the page empty.
    if (error && sortColumn?.referenced) {
      const retry = await buildProductsQuery({ select: LIST_SELECT, count: 'exact', orderColumn: 'name' }).range(from, to)
      if (!retry.error) {
        data = retry.data
        count = retry.count
        error = null
        if (seq === loadSeq.current) setSortFallback(sortColumn.label)
      }
    } else if (seq === loadSeq.current) {
      setSortFallback('')
    }

    if (seq !== loadSeq.current) return
    if (error) {
      setQueryError(error.message)
      setProducts([])
      setTotalCount(0)
      setLoading(false)
      return
    }
    setQueryError('')
    let rows = data || []
    if (filter === 'low') rows = rows.filter(p => p.stock_qty <= p.min_stock)
    setProducts(rows)
    setTotalCount(typeof count === 'number' ? count : null)
    writePageCache(cacheKey, { products: rows, totalCount: count })
    setLoading(false)
  }, [cacheKey, catId, debouncedSearch, filter, page, shop?.id, advFilter, advUsesActive, sortKey, sortDir])

  useEffect(() => { load() }, [load])

  // Latest rate change per visible product, for the ▲/▼ indicator. Kept out of
  // load() so a failure here (e.g. migration not applied) never blocks the list.
  useEffect(() => {
    let cancelled = false
    if (!shop?.id || products.length === 0) {
      setLatestRateChanges(new Map())
      return
    }
    fetchLatestPriceChanges(shop.id, products.map((p) => p.id))
      .then((map) => { if (!cancelled) setLatestRateChanges(map) })
      .catch(() => { if (!cancelled) setLatestRateChanges(new Map()) })
    return () => { cancelled = true }
  }, [shop?.id, products])

  // Stock value across everything the current filters match (not just this page),
  // so applying a filter immediately shows what that selection is worth.
  useEffect(() => {
    if (!shop?.id) {
      setMatchingTotals(null)
      return
    }

    let cancelled = false
    setTotalsLoading(true)

    async function loadTotals() {
      try {
        const rows = await fetchAllMatchingProducts(VALUE_SELECT, { orderColumn: 'name' })
        if (cancelled) return
        setMatchingTotals(summarizeStockValue(rows))
      } catch {
        if (!cancelled) setMatchingTotals(null)
      } finally {
        if (!cancelled) setTotalsLoading(false)
      }
    }

    loadTotals()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop?.id, debouncedSearch, filter, catId, advFilter, advUsesActive])

  const pageTotals = summarizeStockValue(products)

  async function toggleActive(id, val) {
    await supabase.from('products').update({ is_active: val }).eq('id', id).eq('shop_id', shop?.id)
    load()
  }

  // Checks whether products have any historical sale/purchase line items, so the
  // delete confirmation can warn before severing that history (FK is ON DELETE
  // SET NULL — the bill/purchase itself is never touched, only the product link).
  async function findProductsWithHistory(productIds) {
    if (!shop?.id || !productIds.length) return new Set()

    const [saleRes, purchaseRes] = await Promise.all([
      supabase.from('bill_items').select('product_id').eq('shop_id', shop.id).in('product_id', productIds),
      supabase.from('purchase_bill_items').select('product_id').eq('shop_id', shop.id).in('product_id', productIds),
    ])
    if (saleRes.error) throw saleRes.error
    if (purchaseRes.error) throw purchaseRes.error

    const used = new Set()
    ;(saleRes.data || []).forEach((row) => used.add(row.product_id))
    ;(purchaseRes.data || []).forEach((row) => used.add(row.product_id))
    return used
  }

  async function deleteProductsByIds(productIds) {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('shop_id', shop.id)
      .in('id', productIds)
    if (error) throw error

    clearPageCacheByPrefix([`inventory:${shop.id}:`])
    setProducts((prev) => prev.filter((p) => !productIds.includes(p.id)))
    setSelected((prev) => {
      const next = new Map(prev)
      productIds.forEach((id) => next.delete(id))
      return next
    })
  }

  async function handleDeleteProduct(product) {
    if (!shop?.id || !product?.id) return

    try {
      const used = await findProductsWithHistory([product.id])
      let message = `Delete "${product.name}"? This cannot be undone.`
      if (used.has(product.id)) {
        message += '\n\n⚠ This product has existing sale/purchase bills. Those bills will NOT be deleted or changed in '
          + 'total, but they will lose their link to this product (reports grouped by product will no longer include '
          + 'this history). Consider clicking "Disable" instead if you just want to hide it from new bills.'
      }
      if (!window.confirm(message)) return

      await deleteProductsByIds([product.id])
      setCsvMessage('')
    } catch (error) {
      setCsvMessage(`Delete failed: ${error.message}`)
    }
  }

  async function handleDeleteSelected() {
    if (!shop?.id || selected.size === 0) return
    const ids = Array.from(selected.keys())
    const names = Array.from(selected.values()).map((p) => p.name)

    try {
      const used = await findProductsWithHistory(ids)
      let message = `Delete ${ids.length} selected product${ids.length > 1 ? 's' : ''}?\n\n${names.slice(0, 10).join(', ')}`
        + (names.length > 10 ? `, +${names.length - 10} more` : '')
        + '\n\nThis cannot be undone.'
      if (used.size) {
        message += `\n\n⚠ ${used.size} of these have existing sale/purchase bills. Those bills will NOT be deleted or `
          + 'changed in total, but they will lose their link to these products (reports grouped by product will no '
          + 'longer include this history). Consider "Disable" instead if you just want to hide them from new bills.'
      }
      if (!window.confirm(message)) return

      await deleteProductsByIds(ids)
      setCsvMessage('')
    } catch (error) {
      setCsvMessage(`Delete failed: ${error.message}`)
    }
  }

  function toggleSelect(product) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(product.id)) next.delete(product.id)
      else next.set(product.id, product)
      return next
    })
  }

  function toggleSelectPage() {
    setSelected((prev) => {
      const next = new Map(prev)
      const allSelected = products.length > 0 && products.every((p) => next.has(p.id))
      for (const product of products) {
        if (allSelected) next.delete(product.id)
        else next.set(product.id, product)
      }
      return next
    })
  }

  async function selectAllMatching() {
    setCsvBusy(true)
    setCsvMessage('')
    try {
      const rows = await fetchAllMatchingProducts()
      setSelected(new Map(rows.map((row) => [row.id, row])))
    } catch (error) {
      setCsvMessage(`Select all failed: ${error.message}`)
    } finally {
      setCsvBusy(false)
    }
  }

  async function fetchAllMatchingProducts(select = LIST_SELECT, { orderColumn } = {}) {
    const CSV_BATCH_SIZE = 1000
    const all = []
    let from = 0

    // Paginate in batches so the export isn't bound by PostgREST's default row cap.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const to = from + CSV_BATCH_SIZE - 1
      const { data, error } = await buildProductsQuery({ select, orderColumn }).range(from, to)
      if (error) throw error
      const rows = data || []
      all.push(...rows)
      if (rows.length < CSV_BATCH_SIZE) break
      from += CSV_BATCH_SIZE
    }

    return filter === 'low' ? all.filter(p => p.stock_qty <= p.min_stock) : all
  }

  function rowsToCsvBlob(rows) {
    const csvRows = [
      CSV_COLUMNS.join(','),
      ...rows.map((product) => CSV_COLUMNS.map((column) => {
        if (column === 'category') return escapeCsv(product.categories?.name || '')
        return escapeCsv(product[column])
      }).join(',')),
    ]
    return new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' })
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  function csvFileName(scope) {
    return `inventory-${scope}-${shop?.name || 'shop'}-${new Date().toISOString().slice(0, 10)}.csv`
  }

  async function downloadCsv() {
    setCsvBusy(true)
    setCsvMessage('')
    try {
      const allProducts = await fetchAllMatchingProducts()
      saveBlob(rowsToCsvBlob(allProducts), csvFileName('filtered'))
    } catch (error) {
      setCsvMessage(`CSV export failed: ${error.message}`)
    } finally {
      setCsvBusy(false)
    }
  }

  function downloadSelectedCsv() {
    const rows = Array.from(selected.values())
    if (!rows.length) return
    setCsvMessage('')
    try {
      saveBlob(rowsToCsvBlob(rows), csvFileName(`selected-${rows.length}`))
    } catch (error) {
      setCsvMessage(`CSV export failed: ${error.message}`)
    }
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
            .update({ ...payload, last_price_source: 'import' })
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
  const selectedCount = selected.size
  const allPageSelected = products.length > 0 && products.every(p => selected.has(p.id))

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
            onClick={downloadSelectedCsv}
            disabled={selectedCount === 0}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-40"
          >
            Download Selected{selectedCount ? ` (${selectedCount})` : ''}
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={csvBusy}
            className="px-4 py-2 bg-white border text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-60"
          >
            {csvBusy ? 'Preparing…' : 'Download Filtered CSV'}
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
            href="/inventory/quick-add"
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium"
          >
            ⚡ Quick Add
          </Link>
          <Link
            href="/inventory/bulk-rates"
            className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium"
          >
            📋 Bulk Rates
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
          csvMessage.includes('failed') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
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
          <option value="instock">In Stock (Qty ≠ 0)</option>
          <option value="gst">GST Items Only</option>
          <option value="nongst">Non-GST (0%)</option>
          <option value="inactive">Inactive</option>
        </select>
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className={`px-3 py-2 rounded-lg text-sm font-medium border ${
            advCount > 0 ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          {showAdvanced ? '▲' : '▼'} Advanced Filters{advCount > 0 ? ` (${advCount})` : ''}
        </button>
        {advCount > 0 && !showAdvanced && (
          <button
            type="button"
            onClick={() => setAdvTree(emptyFilterTree())}
            className="px-3 py-2 rounded-lg text-sm border text-gray-600 hover:bg-gray-50"
          >
            Clear advanced
          </button>
        )}
      </div>

      {showAdvanced && (
        <div className="mb-3">
          <InventoryFilterPanel
            appliedTree={advTree}
            onApply={setAdvTree}
            onClear={() => setAdvTree(emptyFilterTree())}
            sources={{ categories: cats, suppliers }}
            resultCount={totalCount}
            queryError={queryError}
          />
        </div>
      )}

      {/* Selection toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-xs text-gray-600">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allPageSelected}
            onChange={toggleSelectPage}
            className="h-4 w-4"
          />
          Select page ({products.length})
        </label>
        <button
          type="button"
          onClick={selectAllMatching}
          disabled={csvBusy}
          className="text-blue-600 hover:underline disabled:opacity-50"
        >
          Select all {totalCount != null ? totalCount : ''} matching
        </button>
        {selectedCount > 0 && (
          <>
            <span className="font-medium text-gray-800">{selectedCount} selected</span>
            <button
              type="button"
              onClick={handleDeleteSelected}
              className="text-red-600 hover:underline font-medium"
            >
              Delete Selected ({selectedCount})
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Map())}
              className="text-gray-500 hover:text-red-600"
            >
              Clear selection
            </button>
          </>
        )}
      </div>

      {/* Product list */}
      {sortFallback && (
        <div className="mb-2 rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
          Sorting by {sortFallback} is not supported by the database — showing product-name order instead.
        </div>
      )}
      {loading ? (
        <LoadingPlaceholder label="Loading inventory" rows={4} fullPage />
      ) : products.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No products found</div>
      ) : (
        <div className="rounded-lg border bg-white">
          {/* Mobile: stacked cards */}
          <div className="md:hidden divide-y">
            {products.map(p => {
              const isOut = p.stock_qty <= 0
              const isLow = !isOut && p.min_stock > 0 && p.stock_qty <= p.min_stock
              return (
                <div key={p.id} className={`p-3 ${isOut ? 'bg-red-50' : isLow ? 'bg-yellow-50' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p)}
                      className="mt-1 h-4 w-4 shrink-0"
                      aria-label={`Select ${p.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-gray-900 truncate">{p.name}</div>
                      {p.local_name && <div className="text-xs text-gray-500 truncate">{p.local_name}</div>}
                      <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
                        {p.brand && <span>{p.brand}</span>}
                        {p.categories?.name && <span>{p.categories.name}</span>}
                        {p.barcode && <span className="font-mono">{p.barcode}</span>}
                      </div>
                    </div>
                    <div className={`shrink-0 text-right font-semibold ${
                      isOut ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-green-700'
                    }`}>
                      {p.stock_qty} {p.unit}
                      {isOut && ' ⚠'}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-sm">
                    <div className="flex items-center gap-3">
                      <span className="text-gray-500">Pur: {fmt(p.purchase_price)}</span>
                      <span className="text-gray-500">MRP: {fmt(p.mrp)}</span>
                      <span className="font-medium text-blue-700">Sell: {fmt(p.selling_price || p.mrp)}</span>
                      {(() => {
                        const change = describeChange(latestRateChanges.get(p.id))
                        if (!change) return null
                        const up = change.direction === 'up'
                        return (
                          <span
                            title={`${sourceLabel(latestRateChanges.get(p.id)?.source)} on ${latestRateChanges.get(p.id)?.effective_date}`}
                            className={`text-xs font-medium ${up ? 'text-red-600' : 'text-green-600'}`}
                          >
                            {up ? '▲' : '▼'}{fmt(change.prev)}
                          </span>
                        )
                      })()}
                    </div>
                    {Number(p.gst_rate) > 0
                      ? <span className="text-xs text-gray-500">{p.gst_rate}%</span>
                      : <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Non-GST</span>}
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-gray-400 truncate">{p.suppliers?.name || '—'}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        onClick={() => setExpandedProductId(id => (id === p.id ? null : p.id))}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {expandedProductId === p.id ? '▲ Purchases' : '▼ Purchases'}
                      </button>
                      <Link href={`/inventory/${p.id}`}
                        className="text-blue-600 hover:underline text-xs">Edit</Link>
                      <button
                        onClick={() => toggleActive(p.id, !p.is_active)}
                        className={`text-xs ${p.is_active ? 'text-gray-400 hover:text-red-500' : 'text-green-600 hover:text-green-700'}`}
                      >
                        {p.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => handleDeleteProduct(p)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {expandedProductId === p.id && (
                    <div className="-mx-3 mt-2">
                      <ProductPurchaseHistory shopId={shop?.id} product={p} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Desktop/tablet: table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={toggleSelectPage}
                      className="h-4 w-4"
                      aria-label="Select all rows on this page"
                    />
                  </th>
                  <th className="px-3 py-2 w-6" aria-label="Purchase history" />
                  {INVENTORY_SORT_COLUMNS.map(col => (
                    <th key={col.key} className="px-3 py-2 text-left whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleSort(col.key)}
                        title={`Sort by ${col.label}`}
                        className={`inline-flex items-center font-medium hover:text-blue-700 ${
                          sortKey === col.key ? 'text-blue-700' : 'text-gray-600'
                        }`}
                      >
                        {col.label}
                        <SortArrows active={sortKey === col.key} direction={sortDir} />
                      </button>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-left whitespace-nowrap" />
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const isOut = p.stock_qty <= 0
                  const isLow = !isOut && p.min_stock > 0 && p.stock_qty <= p.min_stock
                  const isExpanded = expandedProductId === p.id
                  return (
                    <Fragment key={p.id}>
                    <tr
                      onClick={() => setExpandedProductId(id => (id === p.id ? null : p.id))}
                      className={`border-b cursor-pointer hover:bg-gray-50 ${isOut ? 'bg-red-50' : isLow ? 'bg-yellow-50' : ''} ${selected.has(p.id) ? 'bg-blue-50' : ''} ${isExpanded ? 'bg-blue-50' : ''}`}
                      title="Click to see purchase history"
                    >
                      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => toggleSelect(p)}
                          className="h-4 w-4"
                          aria-label={`Select ${p.name}`}
                        />
                      </td>
                      <td className="px-1 py-2 text-center text-gray-400">
                        <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                      </td>
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
                      <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}>
                        <Link href={`/inventory/${p.id}`}
                          className="text-blue-600 hover:underline text-xs mr-2">Edit</Link>
                        <button
                          onClick={() => toggleActive(p.id, !p.is_active)}
                          className={`text-xs mr-2 ${p.is_active ? 'text-gray-400 hover:text-red-500' : 'text-green-600 hover:text-green-700'}`}
                        >
                          {p.is_active ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => handleDeleteProduct(p)}
                          className="text-xs text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <ProductPurchaseHistory
                        shopId={shop?.id}
                        product={p}
                        colSpan={INVENTORY_SORT_COLUMNS.length + 3}
                      />
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t bg-gray-50 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className="font-semibold text-gray-700">
                Stock value — this page: <span className="text-teal-700">{fmt(pageTotals.purchaseValue)}</span>
              </span>
              <span className="text-gray-500">
                Selling value {fmt(pageTotals.sellingValue)} · {pageTotals.products} in-stock product{pageTotals.products === 1 ? '' : 's'} · {Math.round(pageTotals.units * 1000) / 1000} units
              </span>
              {pageTotals.emptyProducts > 0 && (
                <span className="text-gray-400">
                  {pageTotals.emptyProducts} with no stock excluded
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1">
              <span className="font-semibold text-gray-700">
                All {totalCount != null ? totalCount : ''} matching {advCount > 0 || debouncedSearch || catId || filter !== 'all' ? '(filtered)' : ''}:{' '}
                <span className="text-teal-700">
                  {totalsLoading && !matchingTotals ? 'calculating…' : fmt(matchingTotals?.purchaseValue || 0)}
                </span>
              </span>
              {matchingTotals && (
                <span className="text-gray-500">
                  Selling value {fmt(matchingTotals.sellingValue)} · {matchingTotals.products} in-stock product{matchingTotals.products === 1 ? '' : 's'} · {Math.round(matchingTotals.units * 1000) / 1000} units
                </span>
              )}
              {matchingTotals?.emptyProducts > 0 && (
                <span className="text-gray-400">
                  {matchingTotals.emptyProducts} with no stock excluded
                </span>
              )}
              {matchingTotals?.negativeProducts > 0 && (
                <span className="text-red-600">
                  {matchingTotals.negativeProducts} product{matchingTotals.negativeProducts > 1 ? 's have' : ' has'} negative stock
                </span>
              )}
              {matchingTotals?.missingCost > 0 && (
                <span className="text-orange-600">
                  {matchingTotals.missingCost} in-stock product{matchingTotals.missingCost > 1 ? 's have' : ' has'} no purchase price
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 border-t text-xs text-gray-500">
            <span>
              {totalCount != null
                ? `Showing ${products.length === 0 ? 0 : page * INVENTORY_LIST_LIMIT + 1}–${page * INVENTORY_LIST_LIMIT + products.length} of ${totalCount} products`
                : `${products.length} products`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <span className="text-gray-600">Page {page + 1}{totalCount != null ? ` of ${Math.max(1, Math.ceil(totalCount / INVENTORY_LIST_LIMIT))}` : ''}</span>
              <button
                type="button"
                onClick={() => setPage(p => p + 1)}
                disabled={
                  totalCount != null
                    ? page * INVENTORY_LIST_LIMIT + products.length >= totalCount
                    : products.length < INVENTORY_LIST_LIMIT
                }
                className="px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
