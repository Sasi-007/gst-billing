'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { MONEY_PAYMENT_MODES, monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

const blank = {
  investment_date: todayStr(),
  source_name: 'Owner',
  amount: '',
  payment_mode: 'bank',
  bank_account_id: '',
  reference_note: '',
  notes: '',
}

function freshBlank() {
  return { ...blank, investment_date: todayStr() }
}

function StatsCard({ label, value, className = '' }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${className}`}>{value}</div>
    </div>
  )
}

export default function InvestmentsPage() {
  const { shop } = useShop()
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [form, setForm] = useState(freshBlank)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [bankAccounts, setBankAccounts] = useState([])
  const cacheKey = shop?.id ? `investments:${shop.id}:${dateFrom}:${dateTo}:${search.trim().toLowerCase()}` : ''
  const initialCache = readPageCache(cacheKey)
  const [investments, setInvestments] = useState(() => initialCache?.investments || [])
  const [loading, setLoading] = useState(() => !initialCache)
  usePageLoadingState('investments-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setInvestments([])
      setBankAccounts([])
      setError('')
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.investments) {
      setInvestments(cached.investments)
      setLoading(false)
    } else {
      setLoading(true)
    }

    let query = supabase
      .from('investments')
      .select('*, bank_accounts(account_name,bank_name)')
      .eq('shop_id', shop.id)
      .eq('is_active', true)
      .gte('investment_date', dateFrom)
      .lte('investment_date', dateTo)
      .order('investment_date', { ascending: false })
      .order('created_at', { ascending: false })

    const term = search.trim()
    if (term) query = query.or(`source_name.ilike.%${term}%,reference_note.ilike.%${term}%,notes.ilike.%${term}%`)

    const [{ data, error: loadErr }, { data: accountRows, error: accountsErr }] = await Promise.all([
      query,
      supabase.from('bank_accounts').select('id,account_name,bank_name,account_type').eq('shop_id', shop.id).eq('is_active', true).order('account_name'),
    ])

    if (loadErr) {
      setError(loadErr.message || 'Failed to load investments')
      setInvestments([])
      setBankAccounts([])
      setLoading(false)
      return
    }

    const nextInvestments = data || []
    setInvestments(nextInvestments)
    writePageCache(cacheKey, { investments: nextInvestments })
    setBankAccounts(accountRows || [])
    if (accountsErr) {
      setError(accountsErr.message || 'Failed to load bank accounts')
    } else {
      setError('')
    }
    setLoading(false)
  }, [cacheKey, dateFrom, dateTo, search, shop?.id])

  useEffect(() => { load() }, [load])

  function startEdit(investment) {
    setEditId(investment.id)
    setForm({
      investment_date: investment.investment_date || todayStr(),
      source_name: investment.source_name || 'Owner',
      amount: investment.amount ?? '',
      payment_mode: investment.payment_mode || 'bank',
      bank_account_id: investment.bank_account_id || '',
      reference_note: investment.reference_note || '',
      notes: investment.notes || '',
    })
  }

  function cancelEdit() {
    setEditId(null)
    setForm(freshBlank())
  }

  async function save() {
    if (!form.source_name.trim() || !(parseFloat(form.amount) > 0)) return
    setSaving(true)
    setError('')

    const payload = {
      investment_date: form.investment_date || todayStr(),
      source_name: form.source_name.trim(),
      amount: parseFloat(form.amount) || 0,
      payment_mode: form.payment_mode || 'bank',
      bank_account_id: form.bank_account_id || null,
      reference_note: form.reference_note.trim() || null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editId) {
      const { error: updateErr } = await supabase.from('investments').update(payload).eq('id', editId).eq('shop_id', shop?.id)
      if (updateErr) {
        setError(updateErr.message || 'Failed to update investment')
        setSaving(false)
        return
      }
    } else {
      const { error: insertErr } = await supabase.from('investments').insert({ ...payload, shop_id: shop?.id })
      if (insertErr) {
        setError(insertErr.message || 'Failed to add investment')
        setSaving(false)
        return
      }
    }

    cancelEdit()
    load()
    setSaving(false)
  }

  async function deactivate(id) {
    if (!window.confirm('Remove this investment entry?')) return
    setError('')
    const { error: removeErr } = await supabase.from('investments').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id).eq('shop_id', shop?.id)
    if (removeErr) {
      setError(removeErr.message || 'Failed to remove investment')
      return
    }
    load()
  }

  const totalInvestments = useMemo(
    () => investments.reduce((sum, investment) => sum + Number(investment.amount || 0), 0),
    [investments]
  )
  const uniqueSources = useMemo(
    () => new Set(investments.map((investment) => String(investment.source_name || '').trim()).filter(Boolean)).size,
    [investments]
  )

  return (
    <div className="p-4 flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold">Investments</h1>
            <div className="text-sm text-gray-500 mt-0.5">Track owner money added into the business separately from expenses.</div>
          </div>
          <button onClick={() => { cancelEdit(); setForm(freshBlank()) }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
            + Add Investment
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <StatsCard label="Total Added" value={fmt(totalInvestments)} className="text-green-700" />
          <StatsCard label="Entries" value={investments.length} className="text-gray-700" />
          <StatsCard label="Sources" value={uniqueSources} className="text-blue-700" />
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
            placeholder="Search source, reference or notes…"
            className="border rounded-lg px-3 py-2 text-sm w-full md:max-w-md" />
        </div>

        {loading ? (
          <LoadingPlaceholder label="Loading investments" rows={5} fullPage />
        ) : investments.length === 0 ? (
          <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No investments found for this period</div>
        ) : (
          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                  {['Date', 'Source', 'Reference', 'Mode', 'Bank', 'Notes', 'Amount', ''].map((heading) => (
                    <th key={heading} className={`px-3 py-2 ${heading === 'Amount' ? 'text-right' : 'text-left'}`}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {investments.map((investment) => (
                  <tr key={investment.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2">{new Date(`${investment.investment_date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                    <td className="px-3 py-2 font-medium text-gray-900">{investment.source_name}</td>
                    <td className="px-3 py-2 text-gray-500">{investment.reference_note || '—'}</td>
                    <td className="px-3 py-2 capitalize text-gray-500">{investment.payment_mode}</td>
                    <td className="px-3 py-2 text-gray-500">{investment.bank_accounts?.account_name || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-xs truncate">{investment.notes || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-green-700">{fmt(investment.amount)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => startEdit(investment)} className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                      <button onClick={() => deactivate(investment.id)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
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
          <h2 className="font-semibold text-sm mb-3">{editId ? 'Edit Investment' : 'New Investment'}</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Investment Date</label>
              <input type="date" value={form.investment_date} onChange={e => setForm((prev) => ({ ...prev, investment_date: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Source *</label>
              <input autoFocus value={form.source_name} onChange={e => setForm((prev) => ({ ...prev, source_name: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Owner, partner, family..." />
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
                <option value="">Do not post to banking</option>
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.account_name} {account.bank_name ? `(${account.bank_name})` : ''}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-[11px] text-gray-400">Selecting a bank account creates the matching bank ledger entry automatically.</div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Reference / Bank Note</label>
              <input value={form.reference_note} onChange={e => setForm((prev) => ({ ...prev, reference_note: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Cheque no, transfer ref..." />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Notes</label>
              <textarea value={form.notes} onChange={e => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3} className="w-full border rounded px-2 py-1.5 text-sm resize-none" placeholder="Optional notes" />
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <button onClick={save} disabled={saving || !form.source_name.trim() || !(parseFloat(form.amount) > 0)}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : editId ? 'Update Investment' : 'Add Investment'}
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
