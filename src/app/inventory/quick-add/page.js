'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { GST_RATES } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'
import { clearPageCacheByPrefix } from '@/lib/pageCache'

const UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'dozen', 'box', 'pack', 'bottle', 'roll', 'strip', 'pair']

let _uid = 0
function uid() { return ++_uid }

// Fields that come from the shared header. A row keeps following the header
// until the user edits that cell directly (tracked in `_touched`).
const SHARED_FIELDS = ['brand', 'unit', 'hsn_code', 'gst_rate']

function emptyRow(defaults = {}) {
  return {
    _id: uid(),
    name: '',
    local_name: '',
    brand: defaults.brand || '',
    unit: defaults.unit || 'pcs',
    hsn_code: defaults.hsn_code || '',
    gst_rate: defaults.gst_rate ?? 5,
    purchase_price: '',
    mrp: '',
    selling_price: '',
    stock_qty: '',
    min_stock: defaults.min_stock || '',
    barcode: '',
    _touched: {},
  }
}

function parseNumber(value) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const DRAFT_VERSION = 1

function draftKey(shopId) {
  return `gst-billing:quick-add-draft:${shopId}`
}

/** A row is worth preserving once any user-entered value exists in it. */
function rowHasContent(row) {
  return ['name', 'local_name', 'purchase_price', 'mrp', 'selling_price', 'stock_qty', 'barcode']
    .some((field) => String(row?.[field] ?? '').trim())
}

function readDraft(shopId) {
  try {
    const raw = window.localStorage.getItem(draftKey(shopId))
    if (!raw) return null
    const draft = JSON.parse(raw)
    if (draft?.version !== DRAFT_VERSION || !Array.isArray(draft.rows)) return null
    if (!draft.rows.some(rowHasContent)) return null
    return draft
  } catch {
    return null
  }
}

function focusCell(rowId, field) {
  setTimeout(() => {
    const el = document.getElementById(`qa-${field}-${rowId}`)
    if (el) { el.focus(); el.select?.() }
  }, 30)
}

function NewRefInput({ kind, placeholder, value, onChange, onKeyDown, onSave, onPick, options, saving, error, cellClass }) {
  const typed = value.trim().toLowerCase()
  const exactMatch = typed ? options.find((item) => item.name.trim().toLowerCase() === typed) : null
  const nearMatches = typed && !exactMatch
    ? options.filter((item) => item.name.toLowerCase().includes(typed)).slice(0, 4)
    : []

  return (
    <div className="mt-1">
      <div className="flex gap-1">
        <input
          id="qa-new-ref"
          list={`qa-ref-options-${kind}`}
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          className={cellClass}
        />
        <datalist id={`qa-ref-options-${kind}`}>
          {options.map((item) => <option key={item.id} value={item.name} />)}
        </datalist>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !value.trim()}
          className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? '…' : exactMatch ? 'Use' : 'Add'}
        </button>
      </div>

      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}

      {!error && exactMatch && (
        <p className="mt-1 text-[11px] font-medium text-amber-600">
          Already exists — Enter will select it, not create a duplicate.
        </p>
      )}

      {!error && !exactMatch && nearMatches.length > 0 && (
        <div className="mt-1">
          <p className="text-[11px] text-gray-500">Similar already exists — tap to use:</p>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {nearMatches.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPick(item)}
                className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {!error && !exactMatch && nearMatches.length === 0 && (
        <p className="mt-1 text-[11px] text-gray-400">
          {typed ? 'New — Enter to create' : 'Enter to save · Esc to cancel'}
        </p>
      )}
    </div>
  )
}

export default function QuickAddInventoryPage() {
  const router = useRouter()
  const { shop } = useShop()

  const [suppliers, setSuppliers] = useState([])
  const [cats, setCats] = useState([])
  const [brands, setBrands] = useState([])
  const [existingNames, setExistingNames] = useState([])

  const [supplierId, setSupplierId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [defaultBrand, setDefaultBrand] = useState('')
  const [defaultUnit, setDefaultUnit] = useState('pcs')
  const [defaultGstRate, setDefaultGstRate] = useState(5)
  const [defaultHsn, setDefaultHsn] = useState('')
  const [defaultMarginPct, setDefaultMarginPct] = useState('')

  const [rows, setRows] = useState([emptyRow()])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  // Inline "create supplier / category" so a missing master record does not
  // force the user to leave this page and lose the rows already typed.
  const [creatingKind, setCreatingKind] = useState(null)
  const [newRefName, setNewRefName] = useState('')
  const [refSaving, setRefSaving] = useState(false)
  const [refError, setRefError] = useState('')
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // Draft recovery: 100 typed rows must survive a refresh, crash or stray back
  // button. Nothing here touches the database — it is purely local.
  const [draftNotice, setDraftNotice] = useState(null)
  const draftReadyRef = useRef(false)

  useEffect(() => {
    if (!shop?.id || draftReadyRef.current) return
    const draft = readDraft(shop.id)
    if (draft) {
      const restored = draft.rows.map((row) => ({ ...emptyRow(), ...row, _id: uid() }))
      setRows(restored)
      if (draft.header) {
        const header = draft.header
        if (header.supplierId) setSupplierId(header.supplierId)
        if (header.categoryId) setCategoryId(header.categoryId)
        if (header.defaultBrand) setDefaultBrand(header.defaultBrand)
        if (header.defaultUnit) setDefaultUnit(header.defaultUnit)
        if (header.defaultGstRate != null) setDefaultGstRate(header.defaultGstRate)
        if (header.defaultHsn) setDefaultHsn(header.defaultHsn)
        if (header.defaultMarginPct) setDefaultMarginPct(header.defaultMarginPct)
      }
      setDraftNotice({
        count: restored.filter(rowHasContent).length,
        savedAt: draft.savedAt ? new Date(draft.savedAt) : null,
      })
    }
    draftReadyRef.current = true
  }, [shop?.id])

  const clearDraft = useCallback(() => {
    if (!shop?.id) return
    try { window.localStorage.removeItem(draftKey(shop.id)) } catch { /* storage unavailable */ }
  }, [shop?.id])

  // Debounced so fast typing does not hit localStorage on every keystroke.
  useEffect(() => {
    if (!shop?.id || !draftReadyRef.current) return
    const timer = setTimeout(() => {
      try {
        const keepers = rows.filter(rowHasContent)
        if (!keepers.length) {
          window.localStorage.removeItem(draftKey(shop.id))
          return
        }
        window.localStorage.setItem(draftKey(shop.id), JSON.stringify({
          version: DRAFT_VERSION,
          savedAt: new Date().toISOString(),
          header: { supplierId, categoryId, defaultBrand, defaultUnit, defaultGstRate, defaultHsn, defaultMarginPct },
          rows: keepers,
        }))
      } catch { /* quota exceeded or storage disabled — entry must still work */ }
    }, 500)
    return () => clearTimeout(timer)
  }, [rows, supplierId, categoryId, defaultBrand, defaultUnit, defaultGstRate, defaultHsn, defaultMarginPct, shop?.id])

  // Last line of defence for a tab close, since the draft write is debounced.
  useEffect(() => {
    function onBeforeUnload(event) {
      if (!rowsRef.current.some(rowHasContent)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    if (!shop?.id) return
    let cancelled = false

    async function loadReferenceData() {
      const [suppliersRes, catsRes, productsRes] = await Promise.all([
        supabase.from('suppliers').select('id,name').eq('shop_id', shop.id).eq('is_active', true).order('name'),
        supabase.from('categories').select('id,name').eq('shop_id', shop.id).order('name'),
        supabase.from('products').select('name,brand').eq('shop_id', shop.id).order('name'),
      ])
      if (cancelled) return
      setSuppliers(suppliersRes.data || [])
      setCats(catsRes.data || [])
      const products = productsRes.data || []
      setExistingNames(products.map((product) => String(product.name || '').trim()).filter(Boolean))
      setBrands([...new Set(products
        .map((product) => String(product.brand || '').trim())
        .filter(Boolean))].sort((a, b) => a.localeCompare(b)))
    }

    loadReferenceData()
    return () => { cancelled = true }
  }, [shop?.id])

  const existingNameSet = useMemo(
    () => new Set(existingNames.map((name) => name.toLowerCase())),
    [existingNames]
  )

  const duplicateRowIds = useMemo(() => {
    const seen = new Map()
    const duplicates = new Set()
    rows.forEach((row) => {
      const key = String(row.name || '').trim().toLowerCase()
      if (!key) return
      if (existingNameSet.has(key) || seen.has(key)) duplicates.add(row._id)
      if (seen.has(key)) duplicates.add(seen.get(key))
      seen.set(key, row._id)
    })
    return duplicates
  }, [existingNameSet, rows])

  const filledRows = rows.filter((row) => String(row.name || '').trim())

  // Header defaults are advertised as applying to every row, so push changes onto
  // rows already on screen (including the very first one) unless that cell was edited.
  useEffect(() => {
    setRows((prev) => prev.map((row) => ({
      ...row,
      brand:    row._touched?.brand    ? row.brand    : defaultBrand,
      unit:     row._touched?.unit     ? row.unit     : defaultUnit,
      hsn_code: row._touched?.hsn_code ? row.hsn_code : defaultHsn,
      gst_rate: row._touched?.gst_rate ? row.gst_rate : defaultGstRate,
    })))
  }, [defaultBrand, defaultUnit, defaultHsn, defaultGstRate])

  function startCreateRef(kind) {
    setCreatingKind(kind)
    setNewRefName('')
    setRefError('')
    setTimeout(() => document.getElementById('qa-new-ref')?.focus(), 30)
  }

  function cancelCreateRef() {
    setCreatingKind(null)
    setNewRefName('')
    setRefError('')
  }

  function pickExistingRef(item) {
    if (creatingKind === 'supplier') setSupplierId(item.id)
    else setCategoryId(item.id)
    setMessage({
      type: 'success',
      text: `Using existing ${creatingKind} "${item.name}".`,
    })
    cancelCreateRef()
  }

  async function saveNewRef() {
    const name = newRefName.trim()
    const kind = creatingKind
    if (!name || !shop?.id || !kind) return

    const isSupplier = kind === 'supplier'
    const list = isSupplier ? suppliers : cats
    const existing = list.find((item) => item.name?.trim().toLowerCase() === name.toLowerCase())
    if (existing) {
      if (isSupplier) setSupplierId(existing.id)
      else setCategoryId(existing.id)
      setMessage({ type: 'success', text: `"${existing.name}" already exists — selected it instead of adding a duplicate.` })
      cancelCreateRef()
      return
    }

    setRefSaving(true)
    setRefError('')
    const { data, error } = await supabase
      .from(isSupplier ? 'suppliers' : 'categories')
      .insert(isSupplier ? { name, shop_id: shop.id, is_active: true } : { name, shop_id: shop.id })
      .select('id,name')
      .single()
    setRefSaving(false)

    if (error || !data) {
      setRefError(error?.message || `Could not add ${kind}`)
      return
    }

    const sortByName = (a, b) => a.name.localeCompare(b.name)
    if (isSupplier) {
      setSuppliers((prev) => [...prev, data].sort(sortByName))
      setSupplierId(data.id)
    } else {
      setCats((prev) => [...prev, data].sort(sortByName))
      setCategoryId(data.id)
    }
    cancelCreateRef()
    setMessage({ type: 'success', text: `${isSupplier ? 'Supplier' : 'Category'} "${data.name}" added and selected.` })
  }

  function handleNewRefKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveNewRef()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelCreateRef()
    }
  }

  const addRow = useCallback(() => {
    const row = emptyRow({
      brand: defaultBrand,
      unit: defaultUnit,
      gst_rate: defaultGstRate,
      hsn_code: defaultHsn,
    })
    setRows((prev) => [...prev, row])
    focusCell(row._id, 'name')
  }, [defaultBrand, defaultGstRate, defaultHsn, defaultUnit])

  function updateRow(rowId, field, value) {
    setRows((prev) => prev.map((row) => {
      if (row._id !== rowId) return row
      const next = { ...row, [field]: field === 'name' || field === 'brand' ? String(value).toUpperCase() : value }
      if (SHARED_FIELDS.includes(field)) {
        next._touched = { ...row._touched, [field]: true }
      }
      if (field === 'purchase_price' && defaultMarginPct !== '') {
        const purchase = parseNumber(value)
        if (purchase > 0) next.selling_price = (purchase * (1 + parseNumber(defaultMarginPct) / 100)).toFixed(2)
      }
      if (field === 'mrp' && (!row.selling_price || row.selling_price === row.mrp)) {
        next.selling_price = value
      }
      return next
    }))
  }

  function deleteRow(rowId) {
    setRows((prev) => (prev.length === 1 ? [emptyRow()] : prev.filter((row) => row._id !== rowId)))
  }

  const handleSave = useCallback(async (options = {}) => {
    if (!shop?.id) return
    const currentRows = rowsRef.current.filter((row) => String(row.name || '').trim())
    if (!currentRows.length) {
      setMessage({ type: 'error', text: 'Add at least one product name.' })
      return
    }

    const blockedRows = currentRows.filter((row) => duplicateRowIds.has(row._id))
    if (blockedRows.length && !options.force) {
      setMessage({
        type: 'error',
        text: `${blockedRows.length} row${blockedRows.length > 1 ? 's' : ''} match an existing or repeated product name. Fix them, or use "Save Anyway".`,
      })
      return
    }

    setSaving(true)
    setMessage(null)
    try {
      const payload = currentRows.map((row) => {
        const purchasePrice = parseNumber(row.purchase_price)
        const mrp = parseNumber(row.mrp)
        const sellingPrice = parseNumber(row.selling_price)
        return {
          shop_id: shop.id,
          name: String(row.name).trim(),
          local_name: String(row.local_name || '').trim() || null,
          brand: String(row.brand || defaultBrand || '').trim() || null,
          barcode: String(row.barcode || '').trim() || null,
          category_id: categoryId || null,
          supplier_id: supplierId || null,
          unit: row.unit || defaultUnit || 'pcs',
          hsn_code: String(row.hsn_code || defaultHsn || '').trim() || null,
          gst_rate: parseNumber(row.gst_rate ?? defaultGstRate),
          purchase_price: purchasePrice,
          mrp,
          selling_price: sellingPrice || mrp || 0,
          stock_qty: parseNumber(row.stock_qty),
          min_stock: parseNumber(row.min_stock),
          is_active: true,
          updated_at: new Date().toISOString(),
        }
      })

      const { error } = await supabase.from('products').insert(payload)
      if (error) throw error

      clearPageCacheByPrefix([`inventory:${shop.id}:`])
      setExistingNames((prev) => [...prev, ...payload.map((product) => product.name)])
      setBrands((prev) => [...new Set([...prev, ...payload.map((product) => product.brand).filter(Boolean)])]
        .sort((a, b) => a.localeCompare(b)))
      setRows([emptyRow({ brand: defaultBrand, unit: defaultUnit, gst_rate: defaultGstRate, hsn_code: defaultHsn })])
      clearDraft()
      setDraftNotice(null)
      setMessage({ type: 'success', text: `Added ${payload.length} product${payload.length > 1 ? 's' : ''} for this supplier.` })
    } catch (saveErr) {
      setMessage({ type: 'error', text: `Save failed: ${saveErr?.message || 'Unknown error'}` })
    } finally {
      setSaving(false)
    }
  }, [categoryId, clearDraft, defaultBrand, defaultGstRate, defaultHsn, defaultUnit, duplicateRowIds, shop?.id, supplierId])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'F4') {
        event.preventDefault()
        addRow()
      } else if (event.key === 'F9' || (event.ctrlKey && event.key.toLowerCase() === 's')) {
        event.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addRow, handleSave])

  function handleRowKeyDown(event, rowId, isLastRow) {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (isLastRow) addRow()
      else {
        const index = rows.findIndex((row) => row._id === rowId)
        const nextRow = rows[index + 1]
        if (nextRow) focusCell(nextRow._id, 'name')
      }
    }
  }

  const cellClass = 'w-full border rounded px-2 py-1 text-sm'

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Quick Add Products</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Pick the supplier and shared details once, then type only what changes per product.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/inventory" className="px-4 py-2 rounded-lg border bg-white text-sm font-medium text-gray-700 hover:bg-gray-50">
            Back to Inventory
          </Link>
          <button
            type="button"
            onClick={() => handleSave()}
            disabled={saving || filledRows.length === 0}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : `F9: Save ${filledRows.length || ''} Product${filledRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      <div className="bg-blue-700 text-white text-xs px-4 py-1 flex flex-wrap gap-4 rounded-lg mb-3">
        <span><kbd>F4</kbd> or <kbd>Enter</kbd> Add row</span>
        <span><kbd>F9</kbd> / <kbd>Ctrl+S</kbd> Save all</span>
        <span>Shared supplier, brand, category and GST apply to every row</span>
        {filledRows.length > 0 && <span className="ml-auto opacity-90">✓ Draft kept on this device</span>}
      </div>

      {draftNotice && (
        <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              ♻ Restored {draftNotice.count} unsaved row{draftNotice.count > 1 ? 's' : ''} from your last session
              {draftNotice.savedAt ? ` (${draftNotice.savedAt.toLocaleString()})` : ''}. Nothing was saved to inventory yet.
            </span>
            <button
              type="button"
              onClick={() => {
                clearDraft()
                setDraftNotice(null)
                setRows([emptyRow({ brand: defaultBrand, unit: defaultUnit, gst_rate: defaultGstRate, hsn_code: defaultHsn })])
              }}
              className="shrink-0 rounded border border-amber-400 px-2 py-0.5 text-xs font-semibold hover:bg-amber-100"
            >
              Discard draft
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${
          message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span>{message.text}</span>
            {message.type === 'error' && message.text.includes('Save Anyway') && (
              <button
                type="button"
                onClick={() => handleSave({ force: true })}
                className="rounded border bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
              >
                Save Anyway
              </button>
            )}
          </div>
        </div>
      )}

      {/* Shared header — entered once for the whole batch */}
      <div className="bg-white rounded-xl border p-3 mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="text-xs font-medium text-gray-600">
          <span className="flex items-center justify-between gap-2">
            Supplier
            <button
              type="button"
              onClick={() => (creatingKind === 'supplier' ? cancelCreateRef() : startCreateRef('supplier'))}
              className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
            >
              {creatingKind === 'supplier' ? 'Cancel' : '+ New'}
            </button>
          </span>
          {creatingKind === 'supplier' ? (
            <NewRefInput
              kind="supplier"
              placeholder="Type to search or add"
              value={newRefName}
              onChange={setNewRefName}
              onKeyDown={handleNewRefKeyDown}
              onSave={saveNewRef}
              onPick={pickExistingRef}
              options={suppliers}
              saving={refSaving}
              error={refError}
              cellClass={cellClass}
            />
          ) : (
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={`mt-1 ${cellClass}`}>
              <option value="">— None —</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
          )}
        </div>
        <div className="text-xs font-medium text-gray-600">
          <span className="flex items-center justify-between gap-2">
            Category
            <button
              type="button"
              onClick={() => (creatingKind === 'category' ? cancelCreateRef() : startCreateRef('category'))}
              className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
            >
              {creatingKind === 'category' ? 'Cancel' : '+ New'}
            </button>
          </span>
          {creatingKind === 'category' ? (
            <NewRefInput
              kind="category"
              placeholder="Type to search or add"
              value={newRefName}
              onChange={setNewRefName}
              onKeyDown={handleNewRefKeyDown}
              onSave={saveNewRef}
              onPick={pickExistingRef}
              options={cats}
              saving={refSaving}
              error={refError}
              cellClass={cellClass}
            />
          ) : (
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`mt-1 ${cellClass}`}>
              <option value="">— None —</option>
              {cats.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
            </select>
          )}
        </div>
        <label className="text-xs font-medium text-gray-600">
          Brand
          <input
            list="quick-add-brands"
            value={defaultBrand}
            onChange={(e) => setDefaultBrand(e.target.value.toUpperCase())}
            placeholder="Pick or type new"
            className={`mt-1 ${cellClass}`}
          />
          <datalist id="quick-add-brands">
            {brands.map((brand) => <option key={brand} value={brand} />)}
          </datalist>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Unit
          <select value={defaultUnit} onChange={(e) => setDefaultUnit(e.target.value)} className={`mt-1 ${cellClass}`}>
            {UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          GST %
          <select value={defaultGstRate} onChange={(e) => setDefaultGstRate(Number(e.target.value))} className={`mt-1 ${cellClass}`}>
            {GST_RATES.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Margin % (auto selling price)
          <input
            type="number"
            value={defaultMarginPct}
            onChange={(e) => setDefaultMarginPct(e.target.value)}
            placeholder="optional"
            className={`mt-1 ${cellClass}`}
          />
        </label>
        <label className="text-xs font-medium text-gray-600 lg:col-span-2">
          Default HSN
          <input
            value={defaultHsn}
            onChange={(e) => setDefaultHsn(e.target.value)}
            placeholder="applies to new rows"
            className={`mt-1 ${cellClass} font-mono`}
          />
        </label>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full min-w-[1320px] text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-600 text-xs border-b">
              {['#', 'Product Name *', 'Tamil / Local', 'Brand', 'Unit', 'HSN', 'GST %', 'Purchase ₹', 'MRP ₹', 'Selling ₹', 'Stock', 'Min', 'Barcode', ''].map((header) => (
                <th key={header} className="px-2 py-2 text-left whitespace-nowrap">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const isDuplicate = duplicateRowIds.has(row._id)
              return (
                <tr key={row._id} className={`border-b ${isDuplicate ? 'bg-red-50' : ''}`}>
                  <td className="px-2 py-1 text-xs text-gray-400">{index + 1}</td>
                  <td className="px-2 py-1 min-w-[200px]">
                    <input
                      id={`qa-name-${row._id}`}
                      value={row.name}
                      onChange={(e) => updateRow(row._id, 'name', e.target.value)}
                      onKeyDown={(e) => handleRowKeyDown(e, row._id, index === rows.length - 1)}
                      list="quick-add-existing-names"
                      placeholder="e.g. AACHI CHILLI 200G"
                      className={cellClass}
                    />
                    {isDuplicate && (
                      <div className="mt-0.5 text-[11px] text-red-600">Already in inventory or repeated above</div>
                    )}
                  </td>
                  <td className="px-2 py-1 min-w-[140px]">
                    <input value={row.local_name} onChange={(e) => updateRow(row._id, 'local_name', e.target.value)} className={cellClass} />
                  </td>
                  <td className="px-2 py-1 min-w-[120px]">
                    <input
                      list="quick-add-brands"
                      value={row.brand}
                      onChange={(e) => updateRow(row._id, 'brand', e.target.value)}
                      placeholder={defaultBrand || 'Brand'}
                      className={cellClass}
                    />
                  </td>
                  <td className="px-2 py-1 min-w-[88px]">
                    <select value={row.unit} onChange={(e) => updateRow(row._id, 'unit', e.target.value)} className={cellClass}>
                      {UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 min-w-[100px]">
                    <input value={row.hsn_code} onChange={(e) => updateRow(row._id, 'hsn_code', e.target.value)} className={`${cellClass} font-mono`} />
                  </td>
                  <td className="px-2 py-1 min-w-[84px]">
                    <select value={row.gst_rate} onChange={(e) => updateRow(row._id, 'gst_rate', Number(e.target.value))} className={cellClass}>
                      {GST_RATES.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 min-w-[96px]">
                    <input type="number" value={row.purchase_price} onChange={(e) => updateRow(row._id, 'purchase_price', e.target.value)} className={`${cellClass} text-right no-spinner`} />
                  </td>
                  <td className="px-2 py-1 min-w-[96px]">
                    <input type="number" value={row.mrp} onChange={(e) => updateRow(row._id, 'mrp', e.target.value)} className={`${cellClass} text-right no-spinner`} />
                  </td>
                  <td className="px-2 py-1 min-w-[96px]">
                    <input type="number" value={row.selling_price} onChange={(e) => updateRow(row._id, 'selling_price', e.target.value)} className={`${cellClass} text-right no-spinner`} />
                  </td>
                  <td className="px-2 py-1 min-w-[76px]">
                    <input type="number" value={row.stock_qty} onChange={(e) => updateRow(row._id, 'stock_qty', e.target.value)} className={`${cellClass} text-right no-spinner`} />
                  </td>
                  <td className="px-2 py-1 min-w-[76px]">
                    <input type="number" value={row.min_stock} onChange={(e) => updateRow(row._id, 'min_stock', e.target.value)} className={`${cellClass} text-right no-spinner`} />
                  </td>
                  <td className="px-2 py-1 min-w-[120px]">
                    <input value={row.barcode} onChange={(e) => updateRow(row._id, 'barcode', e.target.value)} className={`${cellClass} font-mono`} />
                  </td>
                  <td className="px-2 py-1">
                    <button type="button" onClick={() => deleteRow(row._id)} className="text-xs text-red-600 hover:underline">
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <datalist id="quick-add-existing-names">
          {existingNames.slice(0, 500).map((name) => <option key={name} value={name} />)}
        </datalist>
        <div className="px-3 py-2 flex items-center justify-between">
          <button type="button" onClick={addRow} className="text-sm text-blue-600 hover:underline">
            + Add Row <kbd className="hidden md:inline text-xs">F4</kbd>
          </button>
          <button
            type="button"
            onClick={() => router.push('/inventory/new')}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            Need full product form?
          </button>
        </div>
      </div>
    </div>
  )
}
