'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
import { fmt } from '../../lib/gst'
import { monthStartStr, todayStr } from '../../lib/finance'
import { useShop } from '../../context/ShopContext'
import { readPageCache, writePageCache } from '../../lib/pageCache'
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import { usePageLoadingState } from '../../context/PageLoadingContext'
import { useDebouncedValue } from '../../lib/useDebouncedValue'

const blank = { name:'', contact_person:'', phone:'', email:'', gstin:'', address:'', city:'', state:'', pincode:'' }

export default function SuppliersPage() {
  const { shop } = useShop()
  const [search,    setSearch]    = useState('')
  const [dateFrom,  setDateFrom]  = useState(monthStartStr())
  const [dateTo,    setDateTo]    = useState(todayStr())
  const debouncedSearch = useDebouncedValue(search)
  const cacheKey = shop?.id ? `suppliers:${shop.id}:${debouncedSearch}:${dateFrom}:${dateTo}` : ''
  const initialCache = readPageCache(cacheKey)
  const [suppliers, setSuppliers] = useState(() => initialCache?.suppliers || [])
  const [billStats, setBillStats] = useState(() => initialCache?.billStats || [])
  const [loading,   setLoading]   = useState(() => !initialCache)
  const [form,      setForm]      = useState(blank)
  const [editId,    setEditId]    = useState(null)
  const [saving,    setSaving]    = useState(false)
  usePageLoadingState('suppliers-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setSuppliers([])
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.suppliers) {
      setSuppliers(cached.suppliers)
      setBillStats(cached.billStats || [])
      setLoading(false)
    } else {
      setLoading(true)
    }

    let q = supabase.from('suppliers').select('*').eq('shop_id', shop.id).eq('is_active', true).order('name')
    if (debouncedSearch) q = q.ilike('name', `%${debouncedSearch}%`)
    const [{ data }, statsRes] = await Promise.all([
      q,
      supabase
        .from('purchase_bills')
        .select('supplier_id,total,paid_amount,date')
        .eq('shop_id', shop.id)
        .gte('date', dateFrom)
        .lte('date', dateTo),
    ])
    const nextSuppliers = data || []
    const nextStats = statsRes.data || []
    setSuppliers(nextSuppliers)
    setBillStats(nextStats)
    writePageCache(cacheKey, { suppliers: nextSuppliers, billStats: nextStats })
    setLoading(false)
  }, [cacheKey, dateFrom, dateTo, debouncedSearch, shop?.id])

  useEffect(() => { load() }, [load])

  const statsBySupplier = useMemo(() => {
    const map = new Map()
    for (const bill of billStats) {
      if (!bill.supplier_id) continue
      const current = map.get(bill.supplier_id) || { bills: 0, purchased: 0, paid: 0, lastDate: '' }
      current.bills += 1
      current.purchased += Number(bill.total || 0)
      current.paid += Number(bill.paid_amount || 0)
      if (bill.date && bill.date > current.lastDate) current.lastDate = bill.date
      map.set(bill.supplier_id, current)
    }
    return map
  }, [billStats])

  function startEdit(s) { setEditId(s.id); setForm({ ...s }) }
  function cancelEdit() { setEditId(null); setForm(blank) }

  async function save() {
    if (!form.name.trim()) return
    setSaving(true)
    const payload = { ...form, updated_at: new Date().toISOString() }

    if (editId) {
      await supabase.from('suppliers').update(payload).eq('id', editId).eq('shop_id', shop?.id)
    } else {
      await supabase.from('suppliers').insert({ ...payload, shop_id: shop?.id })
    }

    cancelEdit()
    load()
    setSaving(false)
  }

  async function deactivate(id) {
    if (!window.confirm('Remove this supplier?')) return
    await supabase.from('suppliers').update({ is_active: false }).eq('id', id).eq('shop_id', shop?.id)
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
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Search suppliers…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-48" />
          <span className="text-xs text-gray-500">Purchases from</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm" />
          <span className="text-xs text-gray-500">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm" />
        </div>
        {search !== debouncedSearch && (
          <div className="mb-3 text-xs text-blue-600">Searching…</div>
        )}

        {loading ? (
          <LoadingPlaceholder label="Loading suppliers" rows={4} fullPage />
        ) : suppliers.length === 0 ? (
          <div className="text-center text-gray-400 py-8">No suppliers yet</div>
        ) : (
          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  {['Name','Phone','GSTIN','Bills','Purchased','Outstanding','Last Purchase',''].map(h => (
                    <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {suppliers.map(s => {
                  const stats = statsBySupplier.get(s.id) || { bills: 0, purchased: 0, paid: 0, lastDate: '' }
                  const outstanding = stats.purchased - stats.paid
                  return (
                    <tr key={s.id} className="border-b hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium">
                        <Link href={`/suppliers/${s.id}`} className="text-blue-600 hover:underline">{s.name}</Link>
                        {s.contact_person && <div className="text-xs text-gray-400">{s.contact_person}</div>}
                      </td>
                      <td className="px-3 py-2">{s.phone || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.gstin || '—'}</td>
                      <td className="px-3 py-2 text-center">{stats.bills}</td>
                      <td className="px-3 py-2 text-right font-medium text-blue-700">{fmt(stats.purchased)}</td>
                      <td className={`px-3 py-2 text-right ${outstanding > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                        {fmt(outstanding)}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {stats.lastDate ? new Date(`${stats.lastDate}T00:00:00`).toLocaleDateString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Link href={`/suppliers/${s.id}`}
                          className="text-indigo-600 hover:underline text-xs mr-3">Summary</Link>
                        <button onClick={() => startEdit(s)}
                          className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                        <button onClick={() => deactivate(s.id)}
                          className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                      </td>
                    </tr>
                  )
                })}
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
            <div>
              <label className="block text-xs text-gray-500 mb-0.5">GSTIN</label>
              <input value={form.gstin ?? ''} maxLength={15}
                onChange={e => setForm(p => ({ ...p, gstin: e.target.value.toUpperCase().slice(0, 15) }))}
                className="w-full border rounded px-2 py-1.5 text-sm font-mono uppercase" />
            </div>
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
