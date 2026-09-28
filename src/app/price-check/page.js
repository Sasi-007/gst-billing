'use client'

import { useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { fmt } from '@/lib/gst'
import { useShop } from "@/context/ShopContext"
import { loadProductSnapshot, saveProductSnapshot } from "@/lib/offlineBilling"
import { useDebouncedValue } from "@/lib/useDebouncedValue"
import { getBillProductName, getProductSubtitle } from "@/lib/productNames"

const PRODUCT_SEARCH_COLUMNS = 'id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,mrp,purchase_price,selling_price,stock_qty,is_active,search_text'
const PRODUCT_SEARCH_LIMIT = 50
const DEFAULT_PRODUCT_LIMIT = 20

function tokenizeProductSearch(product) {
  return [
    product.name,
    product.local_name,
    product.brand,
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

export default function PriceCheckPage() {
    const { shop } = useShop()
    const [query, setQuery ] = useState('')
    const [products, setProducts] = useState([])
    const [loading, setLoading] = useState(false)
    const [editing, setEditing] = useState(null)
    const [saving, setSaving] = useState(false)
    const debouncedQuery = useDebouncedValue(query, 180)
    const inputRef = useRef(null)
    const offlineProductRef = useRef([])

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    useEffect(() => {
        if (!shop?.id) return
        let cancelled = false

        async function loadCachedProducts() {
            const cached = await loadProductSnapshot(shop.id)
            if (!cancelled && cached.length > 0){
                offlineProductRef.current = cached
                setProducts(cached.slice(0, DEFAULT_PRODUCT_LIMIT))
            }       
        }
        loadCachedProducts()
        return () => { cancelled = true }
    }, [shop?.id])
    
    useEffect(() => {
        if(!shop?.id) return
        const immediateQuery = query.trim().toLowerCase()
        const immediateTerms = immediateQuery.split(/\s+/).filter(Boolean)
        const immediateRows = getOfflineProductResults(offlineProductRef.current, immediateQuery, immediateTerms)
        setProducts(immediateRows)
    }, [query, shop?.id])

    useEffect(()=> {
        if(!shop?.id) return

        const q = debouncedQuery.trim().toLowerCase()
        const terms = q.split(/\s+/).filter(Boolean)
        const offlineRows = getOfflineProductResults(offlineProductRef.current, q, terms)

        if(!navigator.onLine) {
            setLoading(false)
            setProducts(offlineRows)
            setLoading(false)
            return
        }

        let cancelled = false
        async function loadProducts() {
            setLoading(true)
            try {
                let request = supabase
                    .from('products')
                    .select(PRODUCT_SEARCH_COLUMNS)
                    .eq('shop_id', shop.id)
                    .eq('is_active', true)
                    .order('name')
                    .limit(q ? PRODUCT_SEARCH_LIMIT : DEFAULT_PRODUCT_LIMIT)

                if (q) {
                const searchTerm = q.replace(/[%,]/g, ' ').trim()
                if (!searchTerm) {
                    setProducts([])
                    return
                }
                const spacedSearchTerm = ` ${searchTerm}`
                request = request.or(`search_text.ilike.${searchTerm}%,search_text.ilike.%${spacedSearchTerm}%,name.ilike.${searchTerm}%,local_name.ilike.${searchTerm}%,brand.ilike.${searchTerm}%,barcode.ilike.%${searchTerm}%`)
                }

                const { data, error } = await request
                if(error) throw error
                if (cancelled) return
                const rows = (data || []).filter((product) => !q || matchesProductSearch(product, q, terms))
                setProducts(rows)
                if (rows.length > 0) {
                    const merged = mergeProductSnapshots(offlineProductRef.current, rows)
                    offlineProductRef.current = merged
                    await saveProductSnapshot(shop.id, merged)
                }
            } catch {
                if(!cancelled) setProducts(offlineRows)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }

        loadProducts()
        return () => { cancelled = true }
    }, [debouncedQuery, shop?.id])

    const q = query.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    const isSearching = terms.length > 0
    const results = products

    function startEdit(product, field) {
        setEditing({ id: product.id, field, value: String(product[field] ?? '')})
    }

    function cancelEdit() {
        setEditing(null)
    }

    async function commitEdit() {
        if (!editing) return
        const {id,field, value} = editing
        const nextValue = round2Safe(value)
        setEditing(null)

        const product = products.find((p) => p.id === id)
        if( !product || Number(product[field] || 0) === nextValue) return

        setSaving(true)

        try{
            const { error } = await supabase
                .from('products')
                .update({ [field]: nextValue })
                .eq('id', id)
                .eq('shop_id', shop.id)
            if(error) throw error

            const updated = products.map((p) => (p.id === id ? {...p, [field]: nextValue}:p))
            setProducts(updated)
            const merged = mergeProductSnapshots(offlineProductRef.current, updated)
            offlineProductRef.current = merged
            await saveProductSnapshot(shop.id, merged)
        } catch (err) {
            alert('Could not save price.' + (err?.message || 'Please check your connection and try again.'))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="max-w-3xl mx-auto p-4 space-y-4">
            <div>
                <h1 className="text-2xl font-bold text-gray-800">💰 Price Check</h1>
                <p className="text-sm text-gray-500">
                    Search by name, brand or scan barcode to instantly see the price - no need to start a bill.
                    Tap a price to edit it if the rate has changed.
                </p>
            </div>

            <input 
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type product name or scan barcode..."
                className="w-full border-2 border-blue-300 focus:border-blue-500 rounded-xl px-4 py-4 text-xl outline-none shadow-sm" autoComplete="off"
            />

            {loading && products.length === 0 && (
                <p className="text-gray-400 text-center py-8">Loading Products...</p>
            )}

            {!loading && isSearching && results.length === 0 && (
                 <p className="text-gray-400 text-center py-8">No Matching product found.</p>
            )}

            {!loading && !isSearching && products.length > 0 && (
                <p className="text-xs text-gray-400 -mb-1">
                    Showing {results.length} products - keep typing to search more.
                </p>
            )}

            <div className="space-y-2">
                {results.map((p) => {
                    const isOut = (p.stock_qty ?? 0) <= 0
                    const showMrp = p.mrp && p.selling_price && Number(p.mrp) !== Number(p.selling_price)
                    return (
                        <div key={p.id} className="flex items-center justify-between gap-3 bg-white border rounded-xl px-4 py-3 shadow-sm">
                            <div className="min-w-0">
                                <div className="font-semibold text-gray-800 text-lg truncate">
                                    {getBillProductName(p)}
                                    {p.brand ? <span className="text-gray-400 font-normal"> . {p.brand}</span> : null}
                                </div>
                                {getProductSubtitle(p) && (
                                    <div className="text-xs text-gray-400 truncate">
                                        {getProductSubtitle(p)}
                                    </div>
                                )}
                                <div className="text-xs text-gray-400">
                                    {p.unit || 'pcs'}
                                    {isOut ? <span className="ml-2 text-red-500 font-medium">Out of stock</span> : <span className="ml-2">In Stock: {p.stock_qty}</span>}
                            </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                                <PriceCell
                                    label="purchase"
                                    colorClass="text-gray-600"
                                    isEditing={editing?.id === p.id && editing?.field === 'purchase_price'}
                                    value={p.purchase_price}
                                    editValue={editing?.value}
                                    onStartEdit={()=>startEdit(p,'purchase_price')}
                                    onChange={()=> setEditing((e)=>(e ? { ...e, value: v } : e))}
                                    onCommit = {commitEdit}
                                    onCancel = {cancelEdit}
                                    disabled = {saving}
                                />
                                <PriceCell
                                    label="Selling"
                                    colorClass="text-blue-700"
                                    big
                                    strikeValue={showMrp ? p.mrp : null}
                                    isEditing = {editing?.id === p.id && editing?.field === 'selling_price'}
                                    value={p.selling_price || p.mrp || 0}
                                    editValue = {editing?.value}
                                    onStartEdit = {() => startEdit(p, 'selling_price')}
                                    onChange = {(v) => setEditing((e) => (e ? {...e, value: v} : e))}
                                    onCommit = {commitEdit}
                                    onCancel = {cancelEdit}
                                    disabled = {saving}
                                />
                        </div>
                    </div>
                    )
                })}
            </div>
        </div>
    )
}

function getOfflineProductResults(products, q, terms) {
  const rows = terms.length > 0
    ? (products || []).filter((product) => matchesProductSearch(product, q, terms))
    : [...(products || [])]

  return rows
    .sort((a, b) => {
      const aBarcode = String(a.barcode || '').toLowerCase() === q
      const bBarcode = String(b.barcode || '').toLowerCase() === q
      if (aBarcode !== bBarcode) return aBarcode ? -1 : 1
      return String(a.name || '').localeCompare(String(b.name || ''))
    })
    .slice(0, terms.length > 0 ? PRODUCT_SEARCH_LIMIT : DEFAULT_PRODUCT_LIMIT)
}

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

function round2Safe(value) {
    const n = parseFloat(value)
    return Number.isFinite(n) && n >= 0 ? Math.round(n*100) / 100 : 0
}

function PriceCell({ label, colorClass, big, strikeValue, isEditing, value, editValue, onStartEdit, onChange, onCommit, onCancel, disabled}) {
    return (
        <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
            {isEditing ? (
                <input 
                    type="number"
                    autoFocus
                    value={editValue}
                    onChange={(e) => onChange(e.target.value)}
                    onBlur={onCommit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); onCommit()}
                        if (e.key === 'Escape') { e.preventDefault(); onCancel()}
                    }}
                    onFocus={(e) => e.target.select()}
                    min = "0"
                    step = "0.01"
                    className={`border-2 border-blue-400 rounded px-2 py-0.5 text-right outline-none ${big ? 'text-xl font-bold w-24' : 'text-base w-20'}`}
                />
            ): (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={onStartEdit}
                    className={`${big ? 'text-2xl font-bold' : 'text-base font-semibold'} ${colorClass} hover:bg-blue-50 rounded px-1 -mx-1 disabled:opacity-50`}
                    title="Tap to edit"
                >
                    {strikeValue ? <span className="block text-xs font-normal text-gray-400 line-through">{fmt(strikeValue)}</span> : null}
                    {fmt(value || 0)}
                </button>
            )}
        </div>
    )
}