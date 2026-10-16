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
  }
}

function parseNumber(value) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function focusCell(rowId, field) {
  setTimeout(() => {
    const el = document.getElementById(`qa-${field}-${rowId}`)
    if (el) { el.focus(); el.select?.() }
  }, 30)
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
  const rowsRef = useRef(rows)
  rowsRef.current = rows

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
      setMessage({ type: 'success', text: `Added ${payload.length} product${payload.length > 1 ? 's' : ''} for this supplier.` })
    } catch (saveErr) {
      setMessage({ type: 'error', text: `Save failed: ${saveErr?.message || 'Unknown error'}` })
    } finally {
      setSaving(false)
    }
  }, [categoryId, defaultBrand, defaultGstRate, defaultHsn, defaultUnit, duplicateRowIds, shop?.id, supplierId])

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
      </div>

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
        <label className="text-xs font-medium text-gray-600">
          Supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={`mt-1 ${cellClass}`}>
            <option value="">— None —</option>
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`mt-1 ${cellClass}`}>
            <option value="">— None —</option>
            {cats.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
          </select>
        </label>
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
        <table className="w-full min-w-[1000px] text-sm">
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
                  <td className="px-2 py-1">
                    <select value={row.unit} onChange={(e) => updateRow(row._id, 'unit', e.target.value)} className={cellClass}>
                      {UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 min-w-[100px]">
                    <input value={row.hsn_code} onChange={(e) => updateRow(row._id, 'hsn_code', e.target.value)} className={`${cellClass} font-mono`} />
                  </td>
                  <td className="px-2 py-1">
                    <select value={row.gst_rate} onChange={(e) => updateRow(row._id, 'gst_rate', Number(e.target.value))} className={cellClass}>
                      {GST_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 w-24">
                    <input type="number" value={row.purchase_price} onChange={(e) => updateRow(row._id, 'purchase_price', e.target.value)} className={`${cellClass} text-right`} />
                  </td>
                  <td className="px-2 py-1 w-24">
                    <input type="number" value={row.mrp} onChange={(e) => updateRow(row._id, 'mrp', e.target.value)} className={`${cellClass} text-right`} />
                  </td>
                  <td className="px-2 py-1 w-24">
                    <input type="number" value={row.selling_price} onChange={(e) => updateRow(row._id, 'selling_price', e.target.value)} className={`${cellClass} text-right`} />
                  </td>
                  <td className="px-2 py-1 w-20">
                    <input type="number" value={row.stock_qty} onChange={(e) => updateRow(row._id, 'stock_qty', e.target.value)} className={`${cellClass} text-right`} />
                  </td>
                  <td className="px-2 py-1 w-20">
                    <input type="number" value={row.min_stock} onChange={(e) => updateRow(row._id, 'min_stock', e.target.value)} className={`${cellClass} text-right`} />
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
