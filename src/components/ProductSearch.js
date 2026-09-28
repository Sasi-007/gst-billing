'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'
import { loadProductSnapshot, saveProductSnapshot } from '@/lib/offlineBilling'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { getProductSubtitle } from '@/lib/productNames'

const PRODUCT_SEARCH_COLUMNS = 'id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,mrp,purchase_price,selling_price,gst_rate,stock_qty,min_stock,hsn_code,is_active,search_text'
const PRODUCT_SEARCH_LIMIT = 50

function tokenizeProductSearch(product) {
  return [
    product.name,
    product.local_name,
    product.brand,
    product.hsn_code,
    product.search_text,
    ...(Array.isArray(product.search_aliases) ? product.search_aliases : []),
  ].join(' ').toLowerCase().split(/[\s,;|/\\()[\]{}._-]+/).filter(Boolean)
}

function matchesProductSearch(product, query, terms) {
  const barcode = String(product.barcode || '').toLowerCase()
  if (barcode && barcode.includes(query)) return true

  const tokens = tokenizeProductSearch(product)
  return terms.every((term) => tokens.some((token) => token.startsWith(term)))
}

/**
 * Full-screen modal product search.
 * Props:
 *   onSelect(product)    — inventory product picked
 *   onAddFreeText(name)  — item not in inventory; add as free-text line
 *   onClose()
 */
export default function ProductSearch({ onSelect, onAddFreeText, onClose }) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [cursor,  setCursor]  = useState(0)
  const [loading, setLoading] = useState(false)
  const [purchaseHints, setPurchaseHints] = useState({})
  const debouncedQuery = useDebouncedValue(query, 180)
  const inputRef  = useRef(null)
  const itemRefs  = useRef([])
  const offlineProductsRef = useRef([])
  const { shop } = useShop()

  // Desktop: focus the search box immediately for keyboard-driven billing.
  // Touch devices: skip it — a programmatic focus never opens the virtual
  // keyboard, and leaving the field already focused stops the user's own tap
  // from firing a focus event, which would make the keyboard unreachable.
  useEffect(() => {
    const isTouch = typeof window !== 'undefined'
      && window.matchMedia?.('(hover: none) and (pointer: coarse)').matches
    if (isTouch) return
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!shop?.id) return

    let cancelled = false
    async function loadProducts() {
      const cachedProducts = await loadProductSnapshot(shop.id)
      if (!cancelled && cachedProducts.length > 0) {
        offlineProductsRef.current = cachedProducts
      }
    }

    loadProducts()
    return () => { cancelled = true }
  }, [shop?.id])

  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      setResults([])
      setPurchaseHints({})
      return
    }

    const terms = q.split(/\s+/).filter(Boolean)
    const offlineRows = offlineProductsRef.current
      .filter((product) => matchesProductSearch(product, q, terms))
      .slice(0, PRODUCT_SEARCH_LIMIT)

    if (offlineRows.length > 0) {
      setResults(offlineRows)
      setCursor(0)
      setPurchaseHints({})
      loadPurchaseHints(offlineRows)
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) {
      setResults([])
      setPurchaseHints({})
      setLoading(false)
      return
    }

    const terms = q.split(/\s+/).filter(Boolean)
    const offlineRows = offlineProductsRef.current
      .filter((product) => matchesProductSearch(product, q, terms))
      .slice(0, PRODUCT_SEARCH_LIMIT)

    if (!navigator.onLine) {
      setResults(offlineRows)
      setCursor(0)
      setPurchaseHints({})
      loadPurchaseHints(offlineRows)
      return
    }

    let cancelled = false
    async function searchProducts() {
      setLoading(true)
      try {
        const searchTerm = q.replace(/[%,]/g, ' ').trim()
        if (!searchTerm) {
          setResults([])
          setPurchaseHints({})
          return
        }
        const spacedSearchTerm = ` ${searchTerm}`
        const { data, error } = await supabase
          .from('products')
          .select(PRODUCT_SEARCH_COLUMNS)
          .eq('shop_id', shop.id)
          .eq('is_active', true)
          .or(`search_text.ilike.${searchTerm}%,search_text.ilike.%${spacedSearchTerm}%,name.ilike.${searchTerm}%,local_name.ilike.${searchTerm}%,brand.ilike.${searchTerm}%,barcode.ilike.%${searchTerm}%,hsn_code.ilike.${searchTerm}%`)
          .order('name')
          .limit(PRODUCT_SEARCH_LIMIT)

        if (error) throw error
        if (cancelled) return
        const rows = (data || []).filter((product) => matchesProductSearch(product, q, terms))
        setResults(rows)
        setCursor(0)
        setPurchaseHints({})
        loadPurchaseHints(rows)
        if (rows.length > 0) {
          const merged = mergeProductSnapshots(offlineProductsRef.current, rows)
          offlineProductsRef.current = merged
          await saveProductSnapshot(shop.id, merged)
        }
      } catch {
        if (cancelled) return
        setResults(offlineRows)
        setCursor(0)
        setPurchaseHints({})
        loadPurchaseHints(offlineRows)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    searchProducts()
    return () => { cancelled = true }
  }, [debouncedQuery, shop?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function mergeProductSnapshots(currentProducts, nextProducts) {
    const map = new Map()
    for (const product of currentProducts || []) {
      if (product?.id) map.set(product.id, product)
    }
    for (const product of nextProducts || []) {
      if (product?.id) map.set(product.id, product)
    }
    return [...map.values()].slice(-1000)
  }

  async function loadPurchaseHints(products) {
    const productIds = products.map((product) => product.id).filter(Boolean)
    if (!shop?.id || productIds.length === 0) {
      setPurchaseHints({})
      return
    }

    try {
      const { data: itemRows, error: itemErr } = await supabase
        .from('purchase_bill_items')
        .select('product_id,rate,mrp,purchase_bill_id,created_at')
        .eq('shop_id', shop.id)
        .in('product_id', productIds)
        .order('created_at', { ascending: false })
        .limit(productIds.length * 4)

      if (itemErr || !itemRows?.length) {
        setPurchaseHints({})
        return
      }

      const latestByProduct = new Map()
      itemRows.forEach((row) => {
        if (!latestByProduct.has(row.product_id)) latestByProduct.set(row.product_id, row)
      })

      const purchaseBillIds = [...new Set([...latestByProduct.values()].map((row) => row.purchase_bill_id).filter(Boolean))]
      if (purchaseBillIds.length === 0) {
        setPurchaseHints(Object.fromEntries(
          [...latestByProduct.entries()].map(([productId, row]) => [productId, {
            rate: row.rate,
            mrp: row.mrp,
            billNo: '',
            billDate: '',
            supplierName: '',
          }])
        ))
        return
      }

      const { data: billRows, error: billErr } = await supabase
        .from('purchase_bills')
        .select('id,bill_no,date,suppliers(name)')
        .in('id', purchaseBillIds)

      if (billErr) {
        setPurchaseHints({})
        return
      }

      const billMap = new Map((billRows || []).map((bill) => [bill.id, bill]))
      const hints = Object.fromEntries(
        [...latestByProduct.entries()].map(([productId, row]) => {
          const bill = billMap.get(row.purchase_bill_id)
          return [productId, {
            rate: row.rate,
            mrp: row.mrp,
            billNo: bill?.bill_no || '',
            billDate: bill?.date || '',
            supplierName: bill?.suppliers?.name || '',
          }]
        })
      )

      setPurchaseHints(hints)
    } catch {
      setPurchaseHints({})
    }
  }

  // Keep highlighted row visible
  useEffect(() => {
    itemRefs.current[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  function handleKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (results.length > 0) {
        onSelect(resolveSelectedProduct(results[cursor]))
      } else if (query.trim() && onAddFreeText) {
        // Enter with no results → add as free-text
        onAddFreeText(query.trim())
      }
    } else if (e.key === 'Escape') { onClose() }
  }

  function resolveSelectedProduct(product) {
    const hint = purchaseHints[product?.id]
    if (!hint) return product

    return {
      ...product,
      purchase_price: hint.rate ?? product.purchase_price,
      mrp: hint.mrp ?? product.mrp,
    }
  }

  function parseStockQty(value) {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  function formatStockQty(value) {
    if (!Number.isFinite(value)) return ''
    if (Number.isInteger(value)) return String(value)
    return value.toFixed(3).replace(/\.?0+$/, '')
  }

  const trimmed = query.trim()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-4 sm:pt-16 bg-black/60 px-2"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden">

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <span className="text-gray-400 text-lg flex-shrink-0">🔍</span>
          <input
            ref={inputRef}
            type="text"
            name="no-autofill-product-search"
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-autocomplete="none"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search by name, Tamil/local name, Tanglish alias, barcode, brand or HSN…"
            className="flex-1 text-base outline-none min-w-0"
          />
          {loading && <span className="text-xs text-gray-400 animate-pulse flex-shrink-0">searching…</span>}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none flex-shrink-0">✕</button>
        </div>

        {/* Results list — capped to the visible area so the on-screen
            keyboard never hides the whole list on phones */}
        <div className="max-h-[45vh] sm:max-h-72 overflow-y-auto overscroll-contain">
          {!trimmed && (
            <div className="px-4 py-5 text-center text-gray-400 text-sm">
              Start typing to search products
            </div>
          )}

          {trimmed && !loading && results.length === 0 && (
            <div className="p-4">
              <p className="text-sm text-gray-500 mb-3">
                No products found for <strong>&ldquo;{trimmed}&rdquo;</strong>
              </p>
              <div className="space-y-2">
                {onAddFreeText && (
                  <button
                    onClick={() => onAddFreeText(trimmed)}
                    className="w-full text-left px-3 py-2.5 bg-blue-50 border border-blue-200
                               text-blue-700 rounded-lg text-sm hover:bg-blue-100 transition-colors"
                  >
                    <span className="font-medium">+ Add &ldquo;{trimmed}&rdquo; directly to bill</span>
                    <span className="block text-xs text-blue-500 mt-0.5">
                      Free-text item (not linked to inventory) — you can enter price manually
                    </span>
                  </button>
                )}
                <a
                  href={`/inventory/new?name=${encodeURIComponent(trimmed)}`}
                  onClick={onClose}
                  className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200
                             text-green-700 rounded-lg text-sm hover:bg-green-100 transition-colors"
                >
                  <span>📦</span>
                  <span>
                    <span className="font-medium">Add &ldquo;{trimmed}&rdquo; to Inventory first</span>
                    <span className="block text-xs text-green-500 mt-0.5">Opens inventory page → come back to bill</span>
                  </span>
                  <span className="ml-auto">→</span>
                </a>
              </div>
            </div>
          )}

          {results.map((p, i) => {
          const hint = purchaseHints[p.id]
          const hasHistoryHint = Boolean(hint?.rate || hint?.mrp || hint?.supplierName || hint?.billDate)
          const stockQty = parseStockQty(p.stock_qty)
          const hasStockQty = stockQty !== null
          const isOutOfStock = hasStockQty && stockQty <= 0
          const stockText = !hasStockQty
            ? 'Stock not set'
            : isOutOfStock
              ? '0 in stock · Out of stock'
              : `${formatStockQty(stockQty)} in stock`
          const fallbackPurchasePrice = p.purchase_price > 0 ? fmt(p.purchase_price) : null
          const fallbackMrp = p.mrp > 0 ? fmt(p.mrp) : null
          const purchaseHintText = hasHistoryHint
            ? [
                hint?.rate ? `Last buy ${fmt(hint.rate)}` : null,
                hint?.mrp ? `MRP ${fmt(hint.mrp)}` : null,
                hint?.supplierName || null,
                hint?.billDate ? new Date(`${hint.billDate}T00:00:00`).toLocaleDateString('en-IN') : null,
              ].filter(Boolean).join(' · ')
            : [
                fallbackPurchasePrice ? `Buy ${fallbackPurchasePrice}` : null,
                fallbackMrp ? `MRP ${fallbackMrp}` : null,
              ].filter(Boolean).join(' · ')

          const productSubtitle = getProductSubtitle(p)

          return (
            <div
              key={p.id}
              ref={el => (itemRefs.current[i] = el)}
              className={`flex items-center px-4 py-2.5 cursor-pointer border-b last:border-0 transition-colors ${
                i === cursor
                  ? 'bg-blue-50 border-l-4 border-l-blue-500'
                  : 'hover:bg-gray-50 border-l-4 border-l-transparent'
              }`}
              onClick={() => onSelect(resolveSelectedProduct(p))}
              onMouseEnter={() => setCursor(i)}
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{p.name}</div>
                {productSubtitle && (
                  <div className="text-xs text-gray-500 truncate">{productSubtitle}</div>
                )}
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {p.brand && <span className="text-xs bg-gray-100 text-gray-600 px-1.5 rounded">{p.brand}</span>}
                  {p.barcode && <span className="text-xs font-mono text-gray-400">{p.barcode}</span>}
                  <span className="text-xs text-gray-400">{p.unit}</span>
                </div>
                {purchaseHintText && (
                  <div className="mt-1 text-xs text-amber-700 truncate">
                    {purchaseHintText}
                  </div>
                )}
              </div>
              <div className="text-right ml-3 flex-shrink-0">
                <div className="font-bold text-blue-700 text-sm">{fmt(p.selling_price || p.mrp)}</div>
                <div className="text-xs text-gray-400">
                  GST {p.gst_rate}% ·{' '}
                  <span className={
                    !hasStockQty
                      ? 'text-gray-500'
                      : isOutOfStock
                        ? 'text-red-500 font-semibold'
                        : 'text-green-600'
                  }>
                    {stockText}
                  </span>
                </div>
              </div>
            </div>
          )
          })}
        </div>

        {/* Keyboard hints — desktop only; meaningless on touch devices */}
        <div className="hidden md:flex px-4 py-1.5 bg-gray-50 border-t text-xs text-gray-400 flex-wrap gap-3">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          {trimmed && results.length === 0 && onAddFreeText && (
            <span className="text-blue-500">Enter → add as free-text item</span>
          )}
          <span>Esc close</span>
        </div>
      </div>
    </div>
  )
}
