'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt, GST_RATES } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'
import { findProductNameSuggestions, saveProductNameSuggestion } from '@/lib/productNameSuggestions'

const UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'dozen', 'box', 'pack', 'bottle', 'roll', 'strip', 'pair']

const blank = {
  name:'', local_name:'', barcode:'', brand:'', category_id:'', tags:'', search_aliases:'', hsn_code:'',
  unit:'pcs', purchase_price:'', mrp:'', selling_price:'', gst_rate:5,
  stock_qty:'', min_stock:'', supplier_id:'', is_active:true, bill_name_mode:'english',
}

function parseAmount(value) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getSellingPriceFromMargin(purchasePrice, marginPct) {
  if (marginPct === '' || marginPct === null || marginPct === undefined) return ''
  const purchase = parseAmount(purchasePrice)
  const margin = parseAmount(marginPct)
  if (purchase <= 0) return ''
  return (purchase * (1 + margin / 100)).toFixed(2)
}

function getMarginPctFromPrices(purchasePrice, sellingPrice) {
  const purchase = parseAmount(purchasePrice)
  const selling = parseAmount(sellingPrice)
  if (purchase <= 0 || selling <= 0) return ''
  return (((selling - purchase) / purchase) * 100).toFixed(2)
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN')
}

function mergeCsvValues(currentValue, nextValues) {
  const seen = new Set()
  return [
    ...String(currentValue || '').split(','),
    ...nextValues,
  ]
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase()
      if (!value || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(', ')
}

export default function ProductFormPage() {
  const router = useRouter()
  const { id }  = useParams()
  const searchParams = useSearchParams()
  const isNew   = id === 'new'

  const [form,      setForm]      = useState(blank)
  const [cats,      setCats]      = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [recentPurchases, setRecentPurchases] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [useMarginHelper, setUseMarginHelper] = useState(false)
  const [marginPct, setMarginPct] = useState('')
  const [localNameSuggestions, setLocalNameSuggestions] = useState([])
  const [suggestionLoading, setSuggestionLoading] = useState(false)
  const { shop } = useShop()

  function loadCats() {
    if (!shop?.id) return
    supabase
      .from('categories')
      .select('id,name,shop_id')
      .eq('shop_id', shop.id)
      .order('name')
      .then(({ data }) => setCats(data || []))
  }

  useEffect(() => {
    let cancelled = false

    loadCats()
    supabase.from('suppliers').select('id,name').eq('is_active',true).order('name').then(({ data }) => setSuppliers(data || []))

    async function loadRecentPurchases(productId) {
      if (!shop?.id || !productId) {
        if (!cancelled) {
          setRecentPurchases([])
          setHistoryError('')
        }
        return
      }

      setHistoryLoading(true)
      setHistoryError('')

      const { data: itemRows, error: itemErr } = await supabase
        .from('purchase_bill_items')
        .select('id,purchase_bill_id,quantity,rate,mrp,total,created_at')
        .eq('shop_id', shop.id)
        .eq('product_id', productId)
        .order('created_at', { ascending: false })
        .limit(10)

      if (cancelled) return
      if (itemErr) {
        setRecentPurchases([])
        setHistoryError(itemErr.message || 'Failed to load purchase history')
        setHistoryLoading(false)
        return
      }

      const purchaseBillIds = [...new Set((itemRows || []).map((row) => row.purchase_bill_id).filter(Boolean))]
      if (purchaseBillIds.length === 0) {
        setRecentPurchases([])
        setHistoryLoading(false)
        return
      }

      const { data: billRows, error: billErr } = await supabase
        .from('purchase_bills')
        .select('id,bill_no,date,suppliers(name)')
        .in('id', purchaseBillIds)

      if (cancelled) return
      if (billErr) {
        setRecentPurchases([])
        setHistoryError(billErr.message || 'Failed to load purchase bills')
        setHistoryLoading(false)
        return
      }

      const billMap = new Map((billRows || []).map((bill) => [bill.id, bill]))
      const mergedRows = (itemRows || [])
        .map((row) => {
          const bill = billMap.get(row.purchase_bill_id)
          return {
            ...row,
            bill_no: bill?.bill_no || '—',
            date: bill?.date || null,
            supplier_name: bill?.suppliers?.name || '—',
          }
        })
        .sort((a, b) => {
          const dateA = new Date(a.date ? `${a.date}T00:00:00` : a.created_at || 0).getTime()
          const dateB = new Date(b.date ? `${b.date}T00:00:00` : b.created_at || 0).getTime()
          return dateB - dateA
        })

      setRecentPurchases(mergedRows)
      setHistoryLoading(false)
    }

    if (!isNew) {
      supabase.from('products').select('*').eq('id', id).single().then(({ data, error: productErr }) => {
        if (cancelled) return
        if (productErr) {
          setError(productErr.message || 'Failed to load product')
          return
        }
        if (data) {
          setForm({
            ...data,
            tags: (data.tags || []).join(', '),
            search_aliases: (data.search_aliases || []).join(', '),
            bill_name_mode: data.bill_name_mode || 'english',
          })
          setMarginPct(getMarginPctFromPrices(data.purchase_price, data.selling_price || data.mrp))
        }
      })
      loadRecentPurchases(id)
    } else {
      setRecentPurchases([])
      setHistoryError('')
      setHistoryLoading(false)
      setUseMarginHelper(false)
      setMarginPct('')
      const prefilledName = searchParams.get('name')
      setForm({ ...blank, name: prefilledName || '' })
    }

    return () => { cancelled = true }
  }, [id, isNew, searchParams, shop?.id])

  useEffect(() => {
    const input = `${form.name} ${form.search_aliases}`.trim()
    if (!input) {
      setLocalNameSuggestions([])
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setSuggestionLoading(true)
      try {
        const suggestions = await findProductNameSuggestions(
          supabase,
          input,
          shop?.id,
          shop?.use_global_name_suggestions !== false
        )
        if (!cancelled) setLocalNameSuggestions(suggestions)
      } catch {
        if (!cancelled) setLocalNameSuggestions([])
      } finally {
        if (!cancelled) setSuggestionLoading(false)
      }
    }, 200)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [form.name, form.search_aliases, shop?.id, shop?.use_global_name_suggestions])

  async function saveCurrentNameAsShopSuggestion() {
    if (!shop?.id || !form.name || !form.local_name) return

    const aliases = form.search_aliases
      ? form.search_aliases.split(',').map((value) => value.trim()).filter(Boolean)
      : [form.name]

    try {
      await saveProductNameSuggestion(supabase, {
        shopId: shop.id,
        englishName: form.name,
        localName: form.local_name,
        aliases,
      })
    } catch (saveSuggestionError) {
      setError(saveSuggestionError.message)
      return
    }

    const suggestions = await findProductNameSuggestions(supabase, `${form.name} ${form.search_aliases}`, shop.id)
    setLocalNameSuggestions(suggestions)
  }

  function set(k, v) {
    setForm(f => {
      const next = { ...f, [k]: v }
      if (useMarginHelper && k === 'purchase_price') {
        const calculatedSellingPrice = getSellingPriceFromMargin(v, marginPct)
        if (calculatedSellingPrice) next.selling_price = calculatedSellingPrice
      } else if (k === 'mrp' && (!f.selling_price || f.selling_price === f.mrp)) {
        // auto-fill selling price from MRP if not manually set
        next.selling_price = v
      }
      return next
    })
  }

  function toggleMarginHelper(enabled) {
    if (!enabled) {
      setUseMarginHelper(false)
      return
    }

    const nextMarginPct = marginPct || getMarginPctFromPrices(form.purchase_price, form.selling_price || form.mrp)
    setUseMarginHelper(true)
    setMarginPct(nextMarginPct)

    if (nextMarginPct) {
      setForm(f => ({
        ...f,
        selling_price: getSellingPriceFromMargin(f.purchase_price, nextMarginPct) || f.selling_price,
      }))
    }
  }

  function handleMarginPctChange(value) {
    setMarginPct(value)
    if (!useMarginHelper) return

    setForm(f => {
      const calculatedSellingPrice = getSellingPriceFromMargin(f.purchase_price, value)
      return calculatedSellingPrice
        ? { ...f, selling_price: calculatedSellingPrice }
        : f
    })
  }

  function applyLatestPurchasePricing() {
    const latestPurchase = recentPurchases[0]
    if (!latestPurchase) return

    setForm(f => {
      const next = {
        ...f,
        purchase_price: String(latestPurchase.rate ?? ''),
        mrp: String(latestPurchase.mrp ?? ''),
      }

      if (useMarginHelper) {
        const calculatedSellingPrice = getSellingPriceFromMargin(latestPurchase.rate, marginPct)
        if (calculatedSellingPrice) next.selling_price = calculatedSellingPrice
      } else if (!f.selling_price || String(f.selling_price) === String(f.mrp)) {
        next.selling_price = String(latestPurchase.mrp ?? '')
      }

      return next
    })
  }

  function applyLocalNameSuggestion(suggestion) {
    setForm((current) => ({
      ...current,
      local_name: suggestion.local_name,
      search_aliases: mergeCsvValues(current.search_aliases, suggestion.aliases),
      bill_name_mode: current.bill_name_mode === 'english' ? 'local' : current.bill_name_mode,
    }))
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)

    const purchasePrice = parseFloat(form.purchase_price) || 0
    const mrp = parseFloat(form.mrp) || 0
    const manualSellingPrice = parseFloat(form.selling_price) || 0
    const helperSellingPrice = useMarginHelper ? parseFloat(getSellingPriceFromMargin(purchasePrice, marginPct)) || 0 : 0

    const payload = {
      ...form,
      tags:           form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      search_aliases: form.search_aliases ? form.search_aliases.split(',').map(t => t.trim()).filter(Boolean) : [],
      purchase_price: purchasePrice,
      mrp,
      selling_price:  helperSellingPrice || manualSellingPrice || mrp || 0,
      gst_rate:       parseFloat(form.gst_rate)       || 0,
      stock_qty:      parseFloat(form.stock_qty)      || 0,
      min_stock:      parseFloat(form.min_stock)      || 0,
      category_id:    form.category_id  || null,
      supplier_id:    form.supplier_id  || null,
      updated_at:     new Date().toISOString(),
    }

    const { error: err } = isNew
      ? await supabase.from('products').insert({ ...payload, shop_id: shop?.id })
      : await supabase.from('products').update(payload).eq('id', id)

    if (err) { setError(err.message); setSaving(false); return }
    if (shop?.id && form.name && form.local_name) {
      try {
        await saveProductNameSuggestion(supabase, {
          shopId: shop.id,
          englishName: form.name,
          localName: form.local_name,
          aliases: payload.search_aliases,
        })
      } catch (suggestionErr) {
        setError(`Product saved, but Tamil/local suggestion was not learned: ${suggestionErr.message}`)
        setSaving(false)
        return
      }
    }
    router.push('/inventory')
  }

  const field = (label, key, props = {}) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        value={form[key] ?? ''}
        onChange={e => set(key, e.target.value)}
        className="w-full border rounded-lg px-3 py-2 text-sm"
        {...props}
      />
    </div>
  )

  const latestPurchase = recentPurchases[0] || null

  return (
    <div className="p-4 max-w-2xl">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-700 text-sm">← Back</button>
        <h1 className="text-xl font-bold">{isNew ? 'Add Product' : 'Edit Product'}</h1>
      </div>

      {error && <div className="mb-3 p-3 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>}

      <form onSubmit={submit} className="bg-white rounded-xl border p-6">
        <div className="grid grid-cols-2 gap-4">

          {/* Name (full width) */}
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Product Name *</label>
            <input autoFocus required value={form.name} onChange={e => set('name', e.target.value)}
              placeholder="e.g. Tata Salt 1kg"
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Tamil / Local Name</label>
            <input value={form.local_name || ''} onChange={e => set('local_name', e.target.value)}
              placeholder="Tamil name shown on search/bill if enabled"
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            {(suggestionLoading || localNameSuggestions.length > 0) && (
              <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 p-2">
                <div className="mb-1 text-xs font-medium text-blue-800">
                  {suggestionLoading ? 'Looking for Tamil/local names...' : 'Suggested Tamil/local names'}
                </div>
                {localNameSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {localNameSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.id || suggestion.local_name}
                        type="button"
                        onClick={() => applyLocalNameSuggestion(suggestion)}
                        className="rounded-full bg-white px-3 py-1 text-sm font-medium text-blue-700 shadow-sm hover:bg-blue-100"
                      >
                        {suggestion.local_name}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-xs text-blue-700">
                  Optional: click one to fill Tamil name and aliases, or leave empty for English-only billing.
                </p>
              </div>
            )}
            {form.name && form.local_name && (
              <button
                type="button"
                onClick={saveCurrentNameAsShopSuggestion}
                className="mt-2 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Save this Tamil name as this shop&apos;s suggestion
              </button>
            )}
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Tanglish Search Aliases</label>
            <input value={form.search_aliases || ''} onChange={e => set('search_aliases', e.target.value)}
              placeholder="e.g. thuvaram paruppu, thuravam paruppu, toor paruppu"
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-400">
              Staff can type these English/Tanglish words; invoice can still print Tamil/local name.
            </p>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Bill Display Name</label>
            <select value={form.bill_name_mode || 'english'} onChange={e => set('bill_name_mode', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="english">English product name</option>
              <option value="local">Tamil/local name when available</option>
              <option value="both">English / Tamil-local</option>
            </select>
          </div>

          {field('Barcode', 'barcode', { placeholder:'Scan or type', className:'w-full border rounded-lg px-3 py-2 text-sm font-mono' })}
          {field('Brand', 'brand', { placeholder:'e.g. Tata, Amul' })}

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
            <div className="flex gap-1">
              <select value={form.category_id} onChange={e => set('category_id', e.target.value)}
                className="flex-1 border rounded-lg px-3 py-2 text-sm">
                <option value="">— Select —</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Link
                href="/categories"
                className="px-3 py-2 rounded-lg border bg-gray-50 text-xs text-gray-700 whitespace-nowrap hover:bg-gray-100"
                title="Manage categories"
              >
                Manage
              </Link>
            </div>
          </div>

          {/* Unit */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
            <select value={form.unit} onChange={e => set('unit', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              {UNITS.map(u => <option key={u}>{u}</option>)}
            </select>
          </div>

          {/* Tags */}
          <div className="col-span-2">
            {field('Tags (comma-separated)', 'tags', { placeholder:'e.g. salt, cooking, daily' })}
          </div>

          {/* HSN + GST */}
          {field('HSN Code', 'hsn_code', { className:'w-full border rounded-lg px-3 py-2 text-sm font-mono' })}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">GST Rate</label>
            <select value={form.gst_rate} onChange={e => set('gst_rate', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              {GST_RATES.map(r => (
                <option key={r} value={r}>
                  {r}%{r === 0 ? ' — Exempt' : r === 5 ? ' — Packaged food' : r === 12 ? ' — Dairy, ghee' : r === 18 ? ' — Snacks' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Prices */}
          {field('Purchase Price (incl. GST) ₹', 'purchase_price', { type:'number', min:'0', step:'0.01', placeholder:'0.00' })}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">MRP (incl. GST) ₹ *</label>
            <input required type="number" min="0" step="0.01"
              value={form.mrp} onChange={e => set('mrp', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Selling Price (incl. GST) ₹</label>
            <input type="number" min="0" step="0.01"
              disabled={useMarginHelper}
              value={form.selling_price} onChange={e => set('selling_price', e.target.value)}
              placeholder="Defaults to MRP"
              className={`w-full border rounded-lg px-3 py-2 text-sm ${useMarginHelper ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`} />
            <p className="text-xs text-gray-400 mt-0.5">
              {useMarginHelper ? 'Selling price is auto-calculated from purchase price and margin %.' : 'Leave blank to sell at MRP'}
            </p>
          </div>

          <div className="col-span-2 rounded-xl border border-amber-200 bg-amber-50/70 p-4">
            <label className="flex items-center gap-2 text-sm font-medium text-amber-900">
              <input
                type="checkbox"
                checked={useMarginHelper}
                onChange={e => toggleMarginHelper(e.target.checked)}
                className="w-4 h-4"
              />
              Use margin helper (optional)
            </label>
            <p className="mt-1 text-xs text-amber-800">
              Turn this on only when you want selling price to be auto-calculated from purchase price.
            </p>
            {useMarginHelper && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-amber-900 mb-1">Margin %</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={marginPct}
                    onChange={e => handleMarginPctChange(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    placeholder="0.00"
                  />
                </div>
                <div className="sm:col-span-2 rounded-lg bg-white/80 border border-amber-100 px-3 py-2">
                  <div className="text-xs text-gray-500">Auto selling price</div>
                  <div className="text-lg font-semibold text-amber-900">
                    {form.selling_price ? fmt(parseAmount(form.selling_price)) : '—'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Based on purchase price {fmt(parseAmount(form.purchase_price || 0))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Stock */}
          {field('Current Stock', 'stock_qty', { type:'number', min:'0', step:'0.001' })}
          {field('Min Stock (Reorder level)', 'min_stock', { type:'number', min:'0', step:'0.001' })}

          {/* Supplier */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Supplier</label>
            <select value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">— None —</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* Active toggle */}
          <div className="flex items-center gap-2 mt-2">
            <input type="checkbox" id="active" checked={form.is_active}
              onChange={e => set('is_active', e.target.checked)} className="w-4 h-4" />
            <label htmlFor="active" className="text-sm">Active (visible in search)</label>
          </div>

          {!isNew && (
            <div className="col-span-2 rounded-xl border bg-gray-50 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Recent purchase history</h2>
                  <p className="text-xs text-gray-500 mt-1">
                    Track the latest supplier rate and MRP for this product without losing old bill history.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={applyLatestPurchasePricing}
                  disabled={!latestPurchase}
                  className="px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Use latest rate & MRP
                </button>
              </div>

              {historyLoading ? (
                <div className="mt-3 text-sm text-gray-500">Loading recent purchases…</div>
              ) : historyError ? (
                <div className="mt-3 text-sm text-red-600">{historyError}</div>
              ) : recentPurchases.length === 0 ? (
                <div className="mt-3 text-sm text-gray-500">No purchase history found for this product yet.</div>
              ) : (
                <>
                  <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <div className="rounded-lg border bg-white px-3 py-2">
                      <div className="text-xs text-gray-500">Latest supplier</div>
                      <div className="text-sm font-medium text-gray-900">{latestPurchase.supplier_name}</div>
                    </div>
                    <div className="rounded-lg border bg-white px-3 py-2">
                      <div className="text-xs text-gray-500">Latest purchase rate</div>
                      <div className="text-sm font-medium text-gray-900">{fmt(latestPurchase.rate)}</div>
                    </div>
                    <div className="rounded-lg border bg-white px-3 py-2">
                      <div className="text-xs text-gray-500">Latest MRP</div>
                      <div className="text-sm font-medium text-gray-900">{fmt(latestPurchase.mrp)}</div>
                    </div>
                    <div className="rounded-lg border bg-white px-3 py-2">
                      <div className="text-xs text-gray-500">Latest bill date</div>
                      <div className="text-sm font-medium text-gray-900">{formatDate(latestPurchase.date)}</div>
                    </div>
                  </div>

                  <div className="mt-4 overflow-x-auto rounded-lg border bg-white">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-xs text-gray-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Date</th>
                          <th className="px-3 py-2 text-left">Bill No</th>
                          <th className="px-3 py-2 text-left">Supplier</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Rate</th>
                          <th className="px-3 py-2 text-right">MRP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentPurchases.slice(0, 5).map((purchase) => (
                          <tr key={purchase.id} className="border-t">
                            <td className="px-3 py-2">{formatDate(purchase.date)}</td>
                            <td className="px-3 py-2 font-medium text-gray-900">{purchase.bill_no}</td>
                            <td className="px-3 py-2">{purchase.supplier_name}</td>
                            <td className="px-3 py-2 text-right">{purchase.quantity}</td>
                            <td className="px-3 py-2 text-right">{fmt(purchase.rate)}</td>
                            <td className="px-3 py-2 text-right">{fmt(purchase.mrp)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-6 pt-4 border-t">
          <button type="submit" disabled={saving}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50 text-sm">
            {saving ? 'Saving…' : isNew ? 'Add Product' : 'Update Product'}
          </button>
          <button type="button" onClick={() => router.back()}
            className="px-5 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
