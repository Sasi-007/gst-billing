'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { MONEY_PAYMENT_MODES, monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

const blank = {
  drawing_date: todayStr(),
  title: 'Owner withdrawal',
  amount: '',
  payment_mode: 'cash',
  bank_account_id: '',
  notes: '',
}

function freshBlank() {
  return { ...blank, drawing_date: todayStr() }
}

function StatsCard({ label, value, className = '' }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${className}`}>{value}</div>
    </div>
  )
}

export default function DrawingsPage() {
  const { shop } = useShop()
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [form, setForm] = useState(freshBlank)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [bankAccounts, setBankAccounts] = useState([])
  const cacheKey = shop?.id ? `drawings:${shop.id}:${dateFrom}:${dateTo}:${search.trim().toLowerCase()}` : ''
  const initialCache = readPageCache(cacheKey)
  const [drawings, setDrawings] = useState(() => initialCache?.drawings || [])
  const [loading, setLoading] = useState(() => !initialCache)
  usePageLoadingState('drawings-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setDrawings([])
      setBankAccounts([])
      setError('')
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.drawings) {
      setDrawings(cached.drawings)
      setLoading(false)
    } else {
      setLoading(true)
    }

    const term = search.trim()
    let drawingsQuery = supabase
      .from('owner_drawings')
      .select('*, bank_accounts(account_name,bank_name)')
      .eq('shop_id', shop.id)
      .eq('is_active', true)
      .gte('drawing_date', dateFrom)
      .lte('drawing_date', dateTo)
      .order('drawing_date', { ascending: false })
      .order('created_at', { ascending: false })

    if (term) drawingsQuery = drawingsQuery.or(`title.ilike.%${term}%,notes.ilike.%${term}%`)

    const [{ data: drawingRows, error: drawingsErr }, { data: accountsRows, error: accountsErr }] = await Promise.all([
      drawingsQuery,
      supabase.from('bank_accounts').select('id,account_name,bank_name,account_type').eq('shop_id', shop.id).eq('is_active', true).order('account_name'),
    ])

    if (drawingsErr) {
      setError(drawingsErr.message || 'Failed to load owner drawings')
      setDrawings([])
      setLoading(false)
      return
    }
    if (accountsErr) {
      setError(accountsErr.message || 'Failed to load bank accounts')
      setBankAccounts([])
      setLoading(false)
      return
    }

    const nextDrawings = drawingRows || []
    setError('')
    setDrawings(nextDrawings)
    setBankAccounts(accountsRows || [])
    writePageCache(cacheKey, { drawings: nextDrawings })
    setLoading(false)
  }, [cacheKey, dateFrom, dateTo, search, shop?.id])

  useEffect(() => { load() }, [load])

  function startEdit(drawing) {
    setEditId(drawing.id)
    setForm({
      drawing_date: drawing.drawing_date || todayStr(),
      title: drawing.title || 'Owner withdrawal',
      amount: drawing.amount ?? '',
      payment_mode: drawing.payment_mode || 'cash',
      bank_account_id: drawing.bank_account_id || '',
      notes: drawing.notes || '',
    })
  }

  function cancelEdit() {
    setEditId(null)
    setForm(freshBlank())
  }

  async function save() {
    if (!form.title.trim() || !(parseFloat(form.amount) > 0)) return
    setSaving(true)
    setError('')

    const payload = {
      drawing_date: form.drawing_date || todayStr(),
      title: form.title.trim(),
      amount: parseFloat(form.amount) || 0,
      payment_mode: form.payment_mode || 'cash',
      bank_account_id: form.bank_account_id || null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editId) {
      const { error: updateErr } = await supabase.from('owner_drawings').update(payload).eq('id', editId).eq('shop_id', shop?.id)
      if (updateErr) {
        setError(updateErr.message || 'Failed to update owner drawing')
        setSaving(false)
        return
      }
    } else {
      const { error: insertErr } = await supabase.from('owner_drawings').insert({ ...payload, shop_id: shop?.id })
      if (insertErr) {
        setError(insertErr.message || 'Failed to add owner drawing')
        setSaving(false)
        return
      }
    }

    cancelEdit()
    load()
    setSaving(false)
  }

  async function deactivate(id) {
    if (!window.confirm('Remove this owner withdrawal entry?')) return
    setError('')
    const { error: removeErr } = await supabase.from('owner_drawings').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id).eq('shop_id', shop?.id)
    if (removeErr) {
      setError(removeErr.message || 'Failed to remove owner drawing')
      return
    }
    load()
  }

  const totalDrawings = useMemo(
    () => drawings.reduce((sum, drawing) => sum + Number(drawing.amount || 0), 0),
    [drawings]
  )
  const bankLinkedCount = useMemo(
    () => drawings.filter((drawing) => drawing.bank_account_id).length,
    [drawings]
  )

  return (
    <div className="p-4 flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold">Owner Drawings</h1>
            <div className="text-sm text-gray-500 mt-0.5">Track money taken out by the owner separately from expenses and business profit.</div>
          </div>
          <div className="flex gap-2">
            <Link href="/banking" className="px-4 py-2 bg-white border text-gray-700 rounded-lg text-sm hover:bg-gray-50">
              Open Banking
            </Link>
            <button onClick={() => { cancelEdit(); setForm(freshBlank()) }}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
              + Add Drawing
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <StatsCard label="Total Withdrawn" value={fmt(totalDrawings)} className="text-amber-700" />
          <StatsCard label="Entries" value={drawings.length} className="text-gray-700" />
          <StatsCard label="Bank-linked" value={bankLinkedCount} className="text-blue-700" />
        </div>

        {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="flex flex-col gap-3 md:flex-row md:items-center mb-3">
          <div className="flex items-center gap-2">
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" />
            <span className="text-gray-400">to</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" />
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search title or notes…"
            className="border rounded-lg px-3 py-2 text-sm w-full md:max-w-md" />
        </div>

        {loading ? (
          <LoadingPlaceholder label="Loading owner drawings" rows={5} fullPage />
        ) : drawings.length === 0 ? (
          <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No owner withdrawals found for this period</div>
        ) : (
          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  {['Date', 'Title', 'Mode', 'Bank Account', 'Notes', 'Amount', ''].map((heading) => (
                    <th key={heading} className={`px-3 py-2 ${heading === 'Amount' ? 'text-right' : 'text-left'}`}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {drawings.map((drawing) => (
                  <tr key={drawing.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2">{new Date(`${drawing.drawing_date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                    <td className="px-3 py-2 font-medium text-gray-900">{drawing.title}</td>
                    <td className="px-3 py-2 capitalize text-gray-500">{drawing.payment_mode}</td>
                    <td className="px-3 py-2 text-gray-500">{drawing.bank_accounts?.account_name || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-xs truncate">{drawing.notes || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-amber-700">{fmt(drawing.amount)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => startEdit(drawing)} className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                      <button onClick={() => deactivate(drawing.id)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="w-80 flex-shrink-0">
        <div className="bg-white rounded-xl border p-4">
          <h2 className="font-semibold text-sm mb-3">{editId ? 'Edit Drawing' : 'New Drawing'}</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Date</label>
              <input type="date" value={form.drawing_date} onChange={e => setForm((prev) => ({ ...prev, drawing_date: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Title *</label>
              <input autoFocus value={form.title} onChange={e => setForm((prev) => ({ ...prev, title: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Owner withdrawal, family use..." />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Amount *</label>
              <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm((prev) => ({ ...prev, amount: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Payment Mode</label>
              <select value={form.payment_mode} onChange={e => setForm((prev) => ({ ...prev, payment_mode: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm capitalize">
                {MONEY_PAYMENT_MODES.filter((mode) => mode !== 'credit').map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Bank Account (optional)</label>
              <select value={form.bank_account_id} onChange={e => setForm((prev) => ({ ...prev, bank_account_id: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm">
                <option value="">— None —</option>
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.account_name}{account.bank_name ? ` - ${account.bank_name}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Notes</label>
              <textarea value={form.notes} onChange={e => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3} className="w-full border rounded px-2 py-1.5 text-sm resize-none" placeholder="Optional notes" />
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <button onClick={save} disabled={saving || !form.title.trim() || !(parseFloat(form.amount) > 0)}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : editId ? 'Update Drawing' : 'Add Drawing'}
            </button>
            {editId && (
              <button onClick={cancelEdit} className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
