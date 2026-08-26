'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { calculateExpenseCategoryBreakdown, EXPENSE_CATEGORY_SUGGESTIONS, MONEY_PAYMENT_MODES, monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

const blank = {
  expense_date: todayStr(),
  title: '',
  category: '',
  amount: '',
  payment_mode: 'cash',
  bank_account_id: '',
  notes: '',
}

function freshBlank() {
  return { ...blank, expense_date: todayStr() }
}

function StatsCard({ label, value, className = '' }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${className}`}>{value}</div>
    </div>
  )
}

export default function ExpensesPage() {
  const { shop } = useShop()
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [form, setForm] = useState(freshBlank)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [bankAccounts, setBankAccounts] = useState([])
  const cacheKey = shop?.id ? `expenses:${shop.id}:${dateFrom}:${dateTo}:${search.trim().toLowerCase()}` : ''
  const initialCache = readPageCache(cacheKey)
  const [expenses, setExpenses] = useState(() => initialCache?.expenses || [])
  const [loading, setLoading] = useState(() => !initialCache)
  usePageLoadingState('expenses-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setExpenses([])
      setBankAccounts([])
      setError('')
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.expenses) {
      setExpenses(cached.expenses)
      setLoading(false)
    } else {
      setLoading(true)
    }

    let query = supabase
      .from('expenses')
      .select('*, bank_accounts(account_name,bank_name)')
      .eq('shop_id', shop.id)
      .eq('is_active', true)
      .gte('expense_date', dateFrom)
      .lte('expense_date', dateTo)
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })

    const term = search.trim()
    if (term) query = query.or(`title.ilike.%${term}%,category.ilike.%${term}%,notes.ilike.%${term}%`)

    const [{ data, error: loadErr }, { data: accountRows, error: accountsErr }] = await Promise.all([
      query,
      supabase.from('bank_accounts').select('id,account_name,bank_name,account_type').eq('shop_id', shop.id).eq('is_active', true).order('account_name'),
    ])

    if (loadErr) {
      setError(loadErr.message || 'Failed to load expenses')
      setExpenses([])
      setBankAccounts([])
      setLoading(false)
      return
    }

    const nextExpenses = data || []
    setExpenses(nextExpenses)
    writePageCache(cacheKey, { expenses: nextExpenses })
    setBankAccounts(accountRows || [])
    if (accountsErr) {
      setError(accountsErr.message || 'Failed to load bank accounts')
    } else {
      setError('')
    }
    setLoading(false)
  }, [cacheKey, dateFrom, dateTo, search, shop?.id])

  useEffect(() => { load() }, [load])

  function startEdit(expense) {
    setEditId(expense.id)
    setForm({
      expense_date: expense.expense_date || todayStr(),
      title: expense.title || '',
      category: expense.category || '',
      amount: expense.amount ?? '',
      payment_mode: expense.payment_mode || 'cash',
      bank_account_id: expense.bank_account_id || '',
      notes: expense.notes || '',
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
      expense_date: form.expense_date || todayStr(),
      title: form.title.trim(),
      category: form.category.trim() || null,
      amount: parseFloat(form.amount) || 0,
      payment_mode: form.payment_mode || 'cash',
      bank_account_id: form.bank_account_id || null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editId) {
      const { error: updateErr } = await supabase.from('expenses').update(payload).eq('id', editId).eq('shop_id', shop?.id)
      if (updateErr) {
        setError(updateErr.message || 'Failed to update expense')
        setSaving(false)
        return
      }
    } else {
      const { error: insertErr } = await supabase.from('expenses').insert({ ...payload, shop_id: shop?.id })
      if (insertErr) {
        setError(insertErr.message || 'Failed to add expense')
        setSaving(false)
        return
      }
    }

    cancelEdit()
    load()
    setSaving(false)
  }

  async function deactivate(id) {
    if (!window.confirm('Remove this expense entry?')) return
    setError('')
    const { error: removeErr } = await supabase.from('expenses').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id).eq('shop_id', shop?.id)
    if (removeErr) {
      setError(removeErr.message || 'Failed to remove expense')
      return
    }
    load()
  }

  const totalExpense = useMemo(
    () => expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    [expenses]
  )
  const categories = useMemo(
    () => new Set(expenses.map((expense) => String(expense.category || '').trim()).filter(Boolean)).size,
    [expenses]
  )
  const categoryBreakdown = useMemo(
    () => calculateExpenseCategoryBreakdown(expenses),
    [expenses]
  )

  return (
    <div className="p-4 flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold">Expenses</h1>
            <div className="text-sm text-gray-500 mt-0.5">Track shop expenses separately from stock purchases and owner investments.</div>
          </div>
          <button onClick={() => { cancelEdit(); setForm(freshBlank()) }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
            + Add Expense
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <StatsCard label="Total Expense" value={fmt(totalExpense)} className="text-red-700" />
          <StatsCard label="Entries" value={expenses.length} className="text-gray-700" />
          <StatsCard label="Categories" value={categories} className="text-blue-700" />
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
            placeholder="Search expense title, category or notes…"
            className="border rounded-lg px-3 py-2 text-sm w-full md:max-w-md" />
        </div>

        {loading ? (
          <LoadingPlaceholder label="Loading expenses" rows={5} fullPage />
        ) : expenses.length === 0 ? (
          <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No expenses found for this period</div>
        ) : (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                    {['Date', 'Title', 'Category', 'Mode', 'Bank', 'Notes', 'Amount', ''].map((heading) => (
                      <th key={heading} className={`px-3 py-2 ${heading === 'Amount' ? 'text-right' : 'text-left'}`}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((expense) => (
                    <tr key={expense.id} className="border-b hover:bg-gray-50">
                      <td className="px-3 py-2">{new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                      <td className="px-3 py-2 font-medium text-gray-900">{expense.title}</td>
                      <td className="px-3 py-2 text-gray-500">{expense.category || '—'}</td>
                      <td className="px-3 py-2 capitalize text-gray-500">{expense.payment_mode}</td>
                      <td className="px-3 py-2 text-gray-500">{expense.bank_accounts?.account_name || '—'}</td>
                      <td className="px-3 py-2 text-gray-500 max-w-xs truncate">{expense.notes || '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold text-red-700">{fmt(expense.amount)}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => startEdit(expense)} className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                        <button onClick={() => deactivate(expense.id)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-4 py-3 border-b">
                <div className="text-sm font-medium text-gray-700">Category-wise Expense Report</div>
                <div className="text-xs text-gray-400 mt-0.5">Quick chart/table showing where the money is going in this selected period.</div>
              </div>
              {categoryBreakdown.length === 0 ? (
                <div className="p-6 text-sm text-gray-400 text-center">No category data available</div>
              ) : (
                <div className="divide-y">
                  {categoryBreakdown.map((row) => (
                    <div key={row.category} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <div className="font-medium text-gray-800">{row.category}</div>
                        <div className="text-right">
                          <div className="font-semibold text-red-700">{fmt(row.amount)}</div>
                          <div className="text-xs text-gray-400">{row.percent.toFixed(1)}%</div>
                        </div>
                      </div>
                      <div className="mt-2 h-2 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.min(100, row.percent)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="w-80 flex-shrink-0">
        <div className="bg-white rounded-xl border p-4">
          <h2 className="font-semibold text-sm mb-3">{editId ? 'Edit Expense' : 'New Expense'}</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Expense Date</label>
              <input type="date" value={form.expense_date} onChange={e => setForm((prev) => ({ ...prev, expense_date: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Title *</label>
              <input autoFocus value={form.title} onChange={e => setForm((prev) => ({ ...prev, title: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Electricity bill, rent, salary..." />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Category</label>
              <input list="expense-category-options" value={form.category} onChange={e => setForm((prev) => ({ ...prev, category: e.target.value }))}
                className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Rent, salary, transport..." />
              <datalist id="expense-category-options">
                {EXPENSE_CATEGORY_SUGGESTIONS.map((category) => <option key={category} value={category} />)}
              </datalist>
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
                {MONEY_PAYMENT_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
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
              <label className="block text-xs text-gray-500 mb-1">Notes</label>
              <textarea value={form.notes} onChange={e => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3} className="w-full border rounded px-2 py-1.5 text-sm resize-none" placeholder="Optional notes" />
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <button onClick={save} disabled={saving || !form.title.trim() || !(parseFloat(form.amount) > 0)}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : editId ? 'Update Expense' : 'Add Expense'}
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
