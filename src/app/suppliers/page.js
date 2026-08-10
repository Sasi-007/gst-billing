'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'

const blank = { name:'', contact_person:'', phone:'', email:'', gstin:'', address:'', city:'', state:'', pincode:'' }

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [form,      setForm]      = useState(blank)
  const [editId,    setEditId]    = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [search,    setSearch]    = useState('')
  const { shop } = useShop()

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('suppliers').select('*').eq('is_active', true).order('name')
    if (search) q = q.ilike('name', `%${search}%`)
    const { data } = await q
    setSuppliers(data || [])
    setLoading(false)
  }, [search])

  useEffect(() => { load() }, [load])

  function startEdit(s) { setEditId(s.id); setForm({ ...s }) }
  function cancelEdit() { setEditId(null); setForm(blank) }

  async function save() {
    if (!form.name.trim()) return
    setSaving(true)
    const payload = { ...form, updated_at: new Date().toISOString() }

    if (editId) {
      await supabase.from('suppliers').update(payload).eq('id', editId)
    } else {
      await supabase.from('suppliers').insert({ ...payload, shop_id: shop?.id })
    }

    cancelEdit()
    load()
    setSaving(false)
  }

  async function deactivate(id) {
    if (!window.confirm('Remove this supplier?')) return
    await supabase.from('suppliers').update({ is_active: false }).eq('id', id)
    load()
  }

  const f = (label, key, props = {}) => (
    <div>
      <label className="block text-xs text-gray-500 mb-0.5">{label}</label>
      <input value={form[key] ?? ''} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
        className="w-full border rounded px-2 py-1.5 text-sm" {...props} />
    </div>
  )

  return (
    <div className="p-4 flex gap-4">
      {/* Left: list */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold">Suppliers</h1>
          <button onClick={() => { cancelEdit(); setForm(blank) }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
            + Add Supplier
          </button>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search suppliers…"
          className="border rounded-lg px-3 py-2 text-sm w-full mb-3" />

        {loading ? (
          <div className="text-center text-gray-400 py-8">Loading…</div>
        ) : suppliers.length === 0 ? (
          <div className="text-center text-gray-400 py-8">No suppliers yet</div>
        ) : (
          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  {['Name','Contact','Phone','GSTIN','City',''].map(h => (
                    <th key={h} className="px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {suppliers.map(s => (
                  <tr key={s.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">{s.name}</td>
                    <td className="px-3 py-2 text-gray-500">{s.contact_person || '—'}</td>
                    <td className="px-3 py-2">{s.phone || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{s.gstin || '—'}</td>
                    <td className="px-3 py-2 text-gray-500">{s.city || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => startEdit(s)}
                        className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                      <button onClick={() => deactivate(s.id)}
                        className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Right: form */}
      <div className="w-72 flex-shrink-0">
        <div className="bg-white rounded-xl border p-4">
          <h2 className="font-semibold text-sm mb-3">{editId ? 'Edit Supplier' : 'New Supplier'}</h2>
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">Name *</label>
              <input autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Supplier name" />
            </div>
            {f('Contact Person', 'contact_person')}
            {f('Phone', 'phone', { type: 'tel' })}
            {f('Email', 'email', { type: 'email' })}
            {f('GSTIN', 'gstin', { className: 'w-full border rounded px-2 py-1.5 text-sm font-mono uppercase' })}
            {f('Address', 'address')}
            {f('City', 'city')}
            {f('State', 'state')}
            {f('Pincode', 'pincode')}
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={save} disabled={saving || !form.name}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : editId ? 'Update' : 'Add'}
            </button>
            {editId && (
              <button onClick={cancelEdit}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
