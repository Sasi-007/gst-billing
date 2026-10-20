'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
import { fmt } from '../../lib/gst'
import { monthStartStr, todayStr } from '../../lib/finance'
import { useShop } from '../../context/ShopContext'
import { useConfirm } from '../../context/ConfirmDialogContext'
import { clearPageCacheByPrefix, readPageCache, writePageCache } from '../../lib/pageCache'
import { fetchAllRowsByIds } from '../../lib/supabaseBatch'
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import { usePageLoadingState } from '../../context/PageLoadingContext'
import { useDebouncedValue } from '../../lib/useDebouncedValue'

const blank = { name:'', contact_person:'', phone:'', email:'', gstin:'', address:'', city:'', state:'', pincode:'' }

export default function SuppliersPage() {
  const { shop } = useShop()
  const { confirm } = useConfirm()
  const [search,    setSearch]    = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [dateFrom,  setDateFrom]  = useState(monthStartStr())
  const [dateTo,    setDateTo]    = useState(todayStr())
  const debouncedSearch = useDebouncedValue(search)
  const cacheKey = shop?.id ? `suppliers:${shop.id}:${debouncedSearch}:${statusFilter}:${dateFrom}:${dateTo}` : ''
  const initialCache = readPageCache(cacheKey)
  const [suppliers, setSuppliers] = useState(() => initialCache?.suppliers || [])
  const [billStats, setBillStats] = useState(() => initialCache?.billStats || [])
  const [loading,   setLoading]   = useState(() => !initialCache)
  const [form,      setForm]      = useState(blank)
  const [editId,    setEditId]    = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [selected,  setSelected]  = useState(() => new Map())
  const [deleting,  setDeleting]  = useState(false)
  const [notice,    setNotice]    = useState('')
  const formRef = useRef(null)
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

    let q = supabase.from('suppliers').select('*').eq('shop_id', shop.id).order('name')
    if (statusFilter === 'active') q = q.eq('is_active', true)
    else if (statusFilter === 'inactive') q = q.eq('is_active', false)
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
  }, [cacheKey, dateFrom, dateTo, debouncedSearch, shop?.id, statusFilter])

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

  // On phones the form sits below the list, so bring it into view when opened.
  function scrollToForm() {
    if (window.matchMedia('(min-width: 1024px)').matches) return
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

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

  async function setActive(id, active) {
    if (!active) {
      const ok = await confirm({
        title: 'Disable this supplier?',
        message: 'It is hidden from new purchase entries, but its past bills and reports are kept exactly as they are.',
        details: 'You can bring it back any time using the "Inactive" filter above the list.',
        tone: 'warning',
        confirmLabel: 'Disable supplier',
      })
      if (!ok) return
    }
    await supabase.from('suppliers').update({ is_active: active }).eq('id', id).eq('shop_id', shop?.id)
    clearPageCacheByPrefix([`suppliers:${shop?.id}:`])
    load()
  }

  function toggleSelect(supplier) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(supplier.id)) next.delete(supplier.id)
      else next.set(supplier.id, supplier)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Map(prev)
      const allSelected = suppliers.length > 0 && suppliers.every((s) => next.has(s.id))
      for (const supplier of suppliers) {
        if (allSelected) next.delete(supplier.id)
        else next.set(supplier.id, supplier)
      }
      return next
    })
  }

  // Both tables that point at a supplier use ON DELETE SET NULL, so deleting one
  // never removes a bill or a product — it silently severs the link. The counts
  // let the confirmation say exactly what would lose its supplier.
  async function fetchSupplierUsage(supplierIds) {
    const empty = { bills: new Map(), products: new Map(), totalBills: 0, totalProducts: 0 }
    if (!shop?.id || !supplierIds.length) return empty

    const [billRows, productRows] = await Promise.all([
      fetchAllRowsByIds(
        () => supabase.from('purchase_bills').select('supplier_id').eq('shop_id', shop.id),
        'supplier_id',
        supplierIds,
      ),
      fetchAllRowsByIds(
        () => supabase.from('products').select('supplier_id').eq('shop_id', shop.id),
        'supplier_id',
        supplierIds,
      ),
    ])

    const tally = (rows) => {
      const counts = new Map()
      for (const row of rows) {
        counts.set(row.supplier_id, (counts.get(row.supplier_id) || 0) + 1)
      }
      return counts
    }

    const bills = tally(billRows)
    const products = tally(productRows)
    return {
      bills,
      products,
      totalBills: billRows.length,
      totalProducts: productRows.length,
    }
  }

  function buildDeleteDetails(usage, isSingle = false) {
    const { totalBills, totalProducts, bills, products } = usage

    // Sales invoices reference products, never suppliers, so they cannot be
    // affected by this delete — worth saying outright before a permanent action.
    if (!totalBills && !totalProducts) {
      return isSingle
        ? '✓ Checked: no purchase bills and no products are linked to this supplier, so no records lose data. Sales bills never reference a supplier.'
        : '✓ Checked: no purchase bills and no products are linked to these suppliers, so no records lose data. Sales bills never reference a supplier.'
    }

    const who = isSingle ? 'this supplier' : `${new Set([...bills.keys(), ...products.keys()]).size} of these suppliers`
    const linked = []
    if (totalBills) linked.push(`${totalBills} purchase bill${totalBills === 1 ? '' : 's'}`)
    if (totalProducts) linked.push(`${totalProducts} product${totalProducts === 1 ? '' : 's'}`)

    let text = `⚠ ${linked.join(' and ')} ${linked.length > 1 || totalBills > 1 || totalProducts > 1 ? 'are' : 'is'} linked to ${who}.\n`
    if (totalBills) text += `Those bills are NOT deleted, but they lose their supplier link and will show "—" as the supplier.\n`
    if (totalProducts) text += `Those products are NOT deleted, but they lose their supplier link.\n`
    text += 'Sales bills never reference a supplier, so they are unaffected.\n'
    text += '\nUse "Disable" instead if you only want to hide the supplier from new entries.'
    return text
  }

  async function deleteSupplierIds(supplierIds) {
    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('shop_id', shop.id)
      .in('id', supplierIds)
    if (error) throw error

    clearPageCacheByPrefix([`suppliers:${shop.id}:`, `inventory:${shop.id}:`, `purchases:${shop.id}:`])
    setSuppliers((prev) => prev.filter((s) => !supplierIds.includes(s.id)))
    setSelected((prev) => {
      const next = new Map(prev)
      supplierIds.forEach((id) => next.delete(id))
      return next
    })
    if (supplierIds.includes(editId)) cancelEdit()
  }

  async function handleDeleteSupplier(supplier) {
    if (!shop?.id || !supplier?.id) return
    setDeleting(true)
    try {
      const usage = await fetchSupplierUsage([supplier.id])
      const isClean = !usage.totalBills && !usage.totalProducts
      const ok = await confirm({
        title: `Permanently delete "${supplier.name}"?`,
        message: 'The supplier record is removed from this shop for good. This cannot be undone.',
        details: buildDeleteDetails(usage, true),
        detailsTone: isClean ? 'ok' : '',
        confirmLabel: 'Delete supplier',
      })
      if (!ok) return

      await deleteSupplierIds([supplier.id])
      setNotice('')
    } catch (error) {
      setNotice(`Delete failed: ${error.message}`)
    } finally {
      setDeleting(false)
    }
  }

  async function handleDeleteSelected() {
    if (!shop?.id || selected.size === 0) return
    const ids = Array.from(selected.keys())
    const names = Array.from(selected.values()).map((s) => s.name)

    setDeleting(true)
    try {
      const usage = await fetchSupplierUsage(ids)
      const isClean = !usage.totalBills && !usage.totalProducts
      const ok = await confirm({
        title: `Permanently delete ${ids.length} supplier${ids.length > 1 ? 's' : ''}?`,
        message: `${names.slice(0, 10).join(', ')}${names.length > 10 ? `, +${names.length - 10} more` : ''}\n${ids.length > 1 ? 'These supplier records are' : 'This supplier record is'} removed from this shop for good. This cannot be undone.`,
        details: buildDeleteDetails(usage),
        detailsTone: isClean ? 'ok' : '',
        confirmLabel: `Delete ${ids.length} supplier${ids.length > 1 ? 's' : ''}`,
      })
      if (!ok) return

      await deleteSupplierIds(ids)
      setNotice('')
    } catch (error) {
      setNotice(`Delete failed: ${error.message}`)
    } finally {
      setDeleting(false)
    }
  }

  const selectedCount = selected.size
  const allSelected = suppliers.length > 0 && suppliers.every((s) => selected.has(s.id))

  const f = (label, key, props = {}) => (
    <div>
      <label className="block text-xs text-gray-500 mb-0.5">{label}</label>
      <input value={form[key] ?? ''} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
        className="w-full border rounded px-2 py-1.5 text-sm" {...props} />
    </div>
  )

  return (
    <div className="p-3 sm:p-4 flex flex-col lg:flex-row gap-4">
      {/* Left: list */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h1 className="text-xl font-bold">Suppliers</h1>
          <button onClick={() => { cancelEdit(); setForm(blank); scrollToForm() }}
            className="px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-lg text-sm whitespace-nowrap hover:bg-blue-700">
            + Add <span className="hidden sm:inline">Supplier</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Search suppliers…"
            className="border rounded-lg px-3 py-2 text-sm w-full sm:flex-1 sm:w-auto sm:min-w-48" />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
          <span className="text-xs text-gray-500">Purchases from</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm min-w-0 flex-1 sm:flex-none" />
          <span className="text-xs text-gray-500">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="border rounded-lg px-2 py-2 text-sm min-w-0 flex-1 sm:flex-none" />
        </div>
        {search !== debouncedSearch && (
          <div className="mb-3 text-xs text-blue-600">Searching…</div>
        )}

        {notice && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {notice}
          </div>
        )}

        {!loading && suppliers.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-3 text-xs text-gray-600">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="h-4 w-4"
              />
              Select all ({suppliers.length})
            </label>
            {selectedCount > 0 && (
              <>
                <span className="font-medium text-gray-800">{selectedCount} selected</span>
                <button
                  type="button"
                  onClick={handleDeleteSelected}
                  disabled={deleting}
                  className="text-red-600 hover:underline font-medium disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : `Delete Selected (${selectedCount})`}
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
        )}

        {loading ? (
          <LoadingPlaceholder label="Loading suppliers" rows={4} fullPage />
        ) : suppliers.length === 0 ? (
          <div className="text-center text-gray-400 py-8">No suppliers yet</div>
        ) : (
          <>
            {/* Mobile: card per supplier — a 8-column table cannot fit a phone */}
            <div className="md:hidden space-y-2">
              {suppliers.map(s => {
                const stats = statsBySupplier.get(s.id) || { bills: 0, purchased: 0, paid: 0, lastDate: '' }
                const outstanding = stats.purchased - stats.paid
                return (
                  <div key={s.id} className={`bg-white rounded-xl border p-3 ${selected.has(s.id) ? 'ring-2 ring-blue-300' : ''}`}>
                    <div className="flex items-start justify-between gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelect(s)}
                        className="mt-1 h-4 w-4 shrink-0"
                        aria-label={`Select ${s.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <Link href={`/suppliers/${s.id}`} className="font-medium text-blue-600 break-words">{s.name}</Link>
                        {s.is_active === false && (
                          <span className="ml-1.5 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">Inactive</span>
                        )}
                        {s.contact_person && <div className="text-xs text-gray-400">{s.contact_person}</div>}
                        {s.phone && <div className="text-xs text-gray-500">📞 {s.phone}</div>}
                        {s.gstin && <div className="text-xs text-gray-500 font-mono break-all">{s.gstin}</div>}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-blue-700">{fmt(stats.purchased)}</div>
                        <div className="text-[11px] text-gray-400">{stats.bills} bill{stats.bills === 1 ? '' : 's'}</div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className={outstanding > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}>
                        Outstanding {fmt(outstanding)}
                      </span>
                      <span className="text-gray-500">
                        Last {stats.lastDate ? new Date(`${stats.lastDate}T00:00:00`).toLocaleDateString('en-IN') : '—'}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-xs">
                      <Link href={`/suppliers/${s.id}`} className="text-indigo-600">Summary</Link>
                      <button onClick={() => { startEdit(s); scrollToForm() }} className="text-blue-600">Edit</button>
                      <button
                        onClick={() => setActive(s.id, s.is_active === false)}
                        className={s.is_active === false ? 'text-green-600' : 'text-gray-500'}
                      >
                        {s.is_active === false ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        onClick={() => handleDeleteSupplier(s)}
                        disabled={deleting}
                        className="text-red-600 ml-auto disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Desktop: full table */}
            <div className="hidden md:block bg-white rounded-xl border overflow-x-auto">
              <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4"
                      aria-label="Select all suppliers"
                    />
                  </th>
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
                    <tr key={s.id} className={`border-b hover:bg-gray-50 ${selected.has(s.id) ? 'bg-blue-50' : ''}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(s.id)}
                          onChange={() => toggleSelect(s)}
                          className="h-4 w-4"
                          aria-label={`Select ${s.name}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">
                        <Link href={`/suppliers/${s.id}`} className="text-blue-600 hover:underline">{s.name}</Link>
                        {s.is_active === false && (
                          <span className="ml-1.5 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">Inactive</span>
                        )}
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
                        <button onClick={() => setActive(s.id, s.is_active === false)}
                          className={`text-xs mr-3 hover:underline ${s.is_active === false ? 'text-green-600' : 'text-gray-400 hover:text-gray-600'}`}>
                          {s.is_active === false ? 'Enable' : 'Disable'}
                        </button>
                        <button onClick={() => handleDeleteSupplier(s)}
                          disabled={deleting}
                          className="text-red-600 hover:underline text-xs disabled:opacity-50">Delete</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>

      {/* Right on desktop, below the list on mobile */}
      <div ref={formRef} className="w-full lg:w-72 lg:flex-shrink-0">
        <div className="bg-white rounded-xl border p-4">
          <h2 className="font-semibold text-sm mb-3">{editId ? 'Edit Supplier' : 'New Supplier'}</h2>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
            <div className="col-span-2 lg:col-span-1">
              <label className="block text-xs text-gray-500 mb-0.5">Name *</label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Supplier name" />
            </div>
            {f('Contact Person', 'contact_person')}
            {f('Phone', 'phone', { type: 'tel' })}
            {f('Email', 'email', { type: 'email' })}
            <div className="col-span-2 lg:col-span-1">
              <label className="block text-xs text-gray-500 mb-0.5">GSTIN</label>
              <input value={form.gstin ?? ''} maxLength={15}
                onChange={e => setForm(p => ({ ...p, gstin: e.target.value.toUpperCase().slice(0, 15) }))}
                className="w-full border rounded px-2 py-1.5 text-sm font-mono uppercase" />
            </div>
            <div className="col-span-2 lg:col-span-1">{f('Address', 'address')}</div>
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
