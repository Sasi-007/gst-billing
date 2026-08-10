'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { supabase } from '../../../lib/supabase'
import { GST_RATES } from '../../../lib/gst'
import { useShop } from '../../../context/ShopContext'

const UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'dozen', 'box', 'pack', 'bottle', 'roll', 'strip', 'pair']

const blank = {
  name:'', barcode:'', brand:'', category_id:'', tags:'', hsn_code:'',
  unit:'pcs', purchase_price:'', mrp:'', selling_price:'', gst_rate:5,
  stock_qty:'', min_stock:'', supplier_id:'', is_active:true,
}

export default function ProductFormPage() {
  const router = useRouter()
  const { id }  = useParams()
  const isNew   = id === 'new'

  const [form,      setForm]      = useState(blank)
  const [cats,      setCats]      = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const { shop } = useShop()

  useEffect(() => {
    Promise.all([
      supabase.from('categories').select('*').order('name'),
      supabase.from('suppliers').select('id,name').eq('is_active',true).order('name'),
    ]).then(([c, s]) => {
      setCats(c.data || [])
      setSuppliers(s.data || [])
    })

    if (!isNew) {
      supabase.from('products').select('*').eq('id', id).single().then(({ data }) => {
        if (data) setForm({ ...data, tags: (data.tags || []).join(', ') })
      })
    }
  }, [id, isNew])

  function set(k, v) {
    setForm(f => {
      const next = { ...f, [k]: v }
      // auto-fill selling price from MRP if not manually set
      if (k === 'mrp' && (!f.selling_price || f.selling_price === f.mrp)) {
        next.selling_price = v
      }
      return next
    })
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)

    const payload = {
      ...form,
      tags:           form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      purchase_price: parseFloat(form.purchase_price) || 0,
      mrp:            parseFloat(form.mrp)            || 0,
      selling_price:  parseFloat(form.selling_price)  || parseFloat(form.mrp) || 0,
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

          {field('Barcode', 'barcode', { placeholder:'Scan or type', className:'w-full border rounded-lg px-3 py-2 text-sm font-mono' })}
          {field('Brand', 'brand', { placeholder:'e.g. Tata, Amul' })}

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
            <select value={form.category_id} onChange={e => set('category_id', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">— Select —</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
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
              value={form.selling_price} onChange={e => set('selling_price', e.target.value)}
              placeholder="Defaults to MRP"
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <p className="text-xs text-gray-400 mt-0.5">Leave blank to sell at MRP</p>
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
