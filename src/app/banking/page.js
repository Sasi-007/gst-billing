'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { BANK_ACCOUNT_TYPES, BANK_ENTRY_TYPES, calculateBankAccountSummaries, monthStartStr, todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

const blankAccount = {
  account_name: '',
  bank_name: '',
  account_type: 'bank',
  opening_balance: '',
  account_number_last4: '',
  notes: '',
}

const blankTransaction = {
  transaction_date: todayStr(),
  account_id: '',
  direction: 'out',
  entry_type: 'expense',
  amount: '',
  reference_note: '',
  notes: '',
}

function freshTransaction() {
  return { ...blankTransaction, transaction_date: todayStr() }
}

function StatsCard({ label, value, className = '', hint }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${className}`}>{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

export default function BankingPage() {
  const { shop } = useShop()
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [accountForm, setAccountForm] = useState(blankAccount)
  const [transactionForm, setTransactionForm] = useState(freshTransaction)
  const [editAccountId, setEditAccountId] = useState(null)
  const [editTransactionId, setEditTransactionId] = useState(null)
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingTransaction, setSavingTransaction] = useState(false)
  const [error, setError] = useState('')
  const cacheKey = shop?.id ? `banking:${shop.id}:${dateFrom}:${dateTo}:${search.trim().toLowerCase()}` : ''
  const initialCache = readPageCache(cacheKey)
  const [accounts, setAccounts] = useState(() => initialCache?.accounts || [])
  const [transactions, setTransactions] = useState(() => initialCache?.transactions || [])
  const [balanceTransactions, setBalanceTransactions] = useState(() => initialCache?.balanceTransactions || [])
  const [loading, setLoading] = useState(() => !initialCache)
  usePageLoadingState('banking-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setAccounts([])
      setTransactions([])
      setBalanceTransactions([])
      setError('')
      setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.accounts && cached?.transactions && cached?.balanceTransactions) {
      setAccounts(cached.accounts)
      setTransactions(cached.transactions)
      setBalanceTransactions(cached.balanceTransactions)
      setLoading(false)
    } else {
      setLoading(true)
    }

    const term = search.trim()
    const [{ data: accountRows, error: accountErr }, { data: transactionRows, error: transactionErr }, { data: balanceRows, error: balanceErr }] = await Promise.all([
      supabase
        .from('bank_accounts')
        .select('*')
        .eq('shop_id', shop.id)
        .eq('is_active', true)
        .order('account_name'),
      (() => {
        let query = supabase
          .from('bank_transactions')
          .select('*, bank_accounts(account_name,bank_name)')
          .eq('shop_id', shop.id)
          .eq('is_active', true)
          .gte('transaction_date', dateFrom)
          .lte('transaction_date', dateTo)
          .order('transaction_date', { ascending: false })
          .order('created_at', { ascending: false })
        if (term) query = query.or(`reference_note.ilike.%${term}%,notes.ilike.%${term}%,entry_type.ilike.%${term}%`)
        return query
      })(),
      supabase
        .from('bank_transactions')
        .select('*')
        .eq('shop_id', shop.id)
        .eq('is_active', true),
    ])

    if (accountErr) {
      setError(accountErr.message || 'Failed to load bank accounts')
      setAccounts([])
      setTransactions([])
      setLoading(false)
      return
    }
    if (transactionErr) {
      setError(transactionErr.message || 'Failed to load bank transactions')
      setTransactions([])
      setAccounts(accountRows || [])
      setLoading(false)
      return
    }
    if (balanceErr) {
      setError(balanceErr.message || 'Failed to load bank balances')
      setTransactions(transactionRows || [])
      setAccounts(accountRows || [])
      setLoading(false)
      return
    }

    const nextAccounts = accountRows || []
    const nextTransactions = transactionRows || []
    const nextBalanceTransactions = balanceRows || []
    setError('')
    setAccounts(nextAccounts)
    setTransactions(nextTransactions)
    setBalanceTransactions(nextBalanceTransactions)
    writePageCache(cacheKey, { accounts: nextAccounts, transactions: nextTransactions, balanceTransactions: nextBalanceTransactions })
    setLoading(false)
  }, [cacheKey, dateFrom, dateTo, search, shop?.id])

  useEffect(() => { load() }, [load])

  const accountSummaries = useMemo(
    () => calculateBankAccountSummaries(accounts, balanceTransactions),
    [accounts, balanceTransactions]
  )
  const totalBankBalance = useMemo(
    () => accountSummaries.reduce((sum, account) => sum + Number(account.currentBalance || 0), 0),
    [accountSummaries]
  )
  const totalInflow = useMemo(
    () => transactions.filter((row) => row.direction === 'in').reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [transactions]
  )
  const totalOutflow = useMemo(
    () => transactions.filter((row) => row.direction === 'out').reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [transactions]
  )

  function startEditAccount(account) {
    setEditAccountId(account.id)
    setAccountForm({
      account_name: account.account_name || '',
      bank_name: account.bank_name || '',
      account_type: account.account_type || 'bank',
      opening_balance: account.opening_balance ?? '',
      account_number_last4: account.account_number_last4 || '',
      notes: account.notes || '',
    })
  }

  function startEditTransaction(transaction) {
    setEditTransactionId(transaction.id)
    setTransactionForm({
      transaction_date: transaction.transaction_date || todayStr(),
      account_id: transaction.account_id || '',
      direction: transaction.direction || 'out',
      entry_type: transaction.entry_type || 'expense',
      amount: transaction.amount ?? '',
      reference_note: transaction.reference_note || '',
      notes: transaction.notes || '',
    })
  }

  function cancelAccountEdit() {
    setEditAccountId(null)
    setAccountForm(blankAccount)
  }

  function cancelTransactionEdit() {
    setEditTransactionId(null)
    setTransactionForm(freshTransaction())
  }

  async function saveAccount() {
    if (!accountForm.account_name.trim()) return
    setSavingAccount(true)
    setError('')

    const payload = {
      account_name: accountForm.account_name.trim(),
      bank_name: accountForm.bank_name.trim() || null,
      account_type: accountForm.account_type || 'bank',
      opening_balance: parseFloat(accountForm.opening_balance) || 0,
      account_number_last4: accountForm.account_number_last4.trim() || null,
      notes: accountForm.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editAccountId) {
      const { error: updateErr } = await supabase.from('bank_accounts').update(payload).eq('id', editAccountId).eq('shop_id', shop?.id)
      if (updateErr) {
        setError(updateErr.message || 'Failed to update bank account')
        setSavingAccount(false)
        return
      }
    } else {
      const { error: insertErr } = await supabase.from('bank_accounts').insert({ ...payload, shop_id: shop?.id })
      if (insertErr) {
        setError(insertErr.message || 'Failed to add bank account')
        setSavingAccount(false)
        return
      }
    }

    cancelAccountEdit()
    load()
    setSavingAccount(false)
  }

  async function saveTransaction() {
    if (!transactionForm.account_id || !(parseFloat(transactionForm.amount) > 0)) return
    setSavingTransaction(true)
    setError('')

    const payload = {
      account_id: transactionForm.account_id,
      transaction_date: transactionForm.transaction_date || todayStr(),
      direction: transactionForm.direction || 'out',
      entry_type: transactionForm.entry_type || 'expense',
      amount: parseFloat(transactionForm.amount) || 0,
      reference_note: transactionForm.reference_note.trim() || null,
      notes: transactionForm.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }

    if (editTransactionId) {
      const { error: updateErr } = await supabase.from('bank_transactions').update(payload).eq('id', editTransactionId).eq('shop_id', shop?.id)
      if (updateErr) {
        setError(updateErr.message || 'Failed to update bank transaction')
        setSavingTransaction(false)
        return
      }
    } else {
      const { error: insertErr } = await supabase.from('bank_transactions').insert({ ...payload, shop_id: shop?.id })
      if (insertErr) {
        setError(insertErr.message || 'Failed to add bank transaction')
        setSavingTransaction(false)
        return
      }
    }

    cancelTransactionEdit()
    load()
    setSavingTransaction(false)
  }

  async function deactivateAccount(id) {
    if (!window.confirm('Remove this bank account?')) return
    setError('')
    const { error: removeErr } = await supabase.from('bank_accounts').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id).eq('shop_id', shop?.id)
    if (removeErr) {
      setError(removeErr.message || 'Failed to remove bank account')
      return
    }
    load()
  }

  async function deactivateTransaction(id) {
    if (!window.confirm('Remove this bank transaction?')) return
    setError('')
    const { error: removeErr } = await supabase.from('bank_transactions').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id).eq('shop_id', shop?.id)
    if (removeErr) {
      setError(removeErr.message || 'Failed to remove bank transaction')
      return
    }
    load()
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-bold">Banking</h1>
          <div className="text-sm text-gray-500 mt-0.5">Track bank, cash, wallet, and UPI account balances with manual inflow and outflow entries.</div>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatsCard label="Current Balance" value={fmt(totalBankBalance)} className={totalBankBalance >= 0 ? 'text-blue-700' : 'text-red-700'} hint={`${accountSummaries.length} active accounts`} />
        <StatsCard label="Period Inflow" value={fmt(totalInflow)} className="text-green-700" />
        <StatsCard label="Period Outflow" value={fmt(totalOutflow)} className="text-red-700" />
        <StatsCard label="Transactions" value={transactions.length} className="text-gray-700" />
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr,1.85fr] gap-4">
        <div className="space-y-4">
          <div className="bg-white rounded-xl border p-4">
            <h2 className="font-semibold text-sm mb-3">{editAccountId ? 'Edit Account' : 'New Account'}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Account Name *</label>
                <input autoFocus value={accountForm.account_name} onChange={e => setAccountForm((prev) => ({ ...prev, account_name: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="HDFC Current, Cash Box, PhonePe..." />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Bank / Provider</label>
                <input value={accountForm.bank_name} onChange={e => setAccountForm((prev) => ({ ...prev, bank_name: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="HDFC, SBI, GPay..." />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Account Type</label>
                <select value={accountForm.account_type} onChange={e => setAccountForm((prev) => ({ ...prev, account_type: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm capitalize">
                  {BANK_ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Opening Balance</label>
                <input type="number" step="0.01" value={accountForm.opening_balance} onChange={e => setAccountForm((prev) => ({ ...prev, opening_balance: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="0.00" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Last 4 digits</label>
                <input maxLength={4} value={accountForm.account_number_last4} onChange={e => setAccountForm((prev) => ({ ...prev, account_number_last4: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="1234" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Notes</label>
                <textarea value={accountForm.notes} onChange={e => setAccountForm((prev) => ({ ...prev, notes: e.target.value }))}
                  rows={2} className="w-full border rounded px-2 py-1.5 text-sm resize-none" />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={saveAccount} disabled={savingAccount || !accountForm.account_name.trim()}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {savingAccount ? 'Saving…' : editAccountId ? 'Update Account' : 'Add Account'}
              </button>
              {editAccountId && (
                <button onClick={cancelAccountEdit} className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">Account Balances</div>
            {loading ? (
              <LoadingPlaceholder label="Loading bank accounts" rows={4} />
            ) : accountSummaries.length === 0 ? (
              <div className="p-6 text-sm text-gray-400 text-center">No bank accounts added yet</div>
            ) : (
              <div className="divide-y">
                {accountSummaries.map((account) => (
                  <div key={account.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-gray-900">{account.account_name}</div>
                        <div className="text-xs text-gray-500 capitalize">
                          {account.account_type}{account.bank_name ? ` · ${account.bank_name}` : ''}{account.account_number_last4 ? ` · ****${account.account_number_last4}` : ''}
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          In {fmt(account.inflow)} · Out {fmt(account.outflow)} · {account.transactionCount} txns
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`font-semibold ${account.currentBalance >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{fmt(account.currentBalance)}</div>
                        <div className="mt-2">
                          <button onClick={() => startEditAccount(account)} className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                          <button onClick={() => deactivateAccount(account.id)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-xl border p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <h2 className="font-semibold text-sm">{editTransactionId ? 'Edit Transaction' : 'New Transaction'}</h2>
              <div className="flex items-center gap-2">
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm" />
                <span className="text-gray-400">to</span>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="space-y-3 mt-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input type="date" value={transactionForm.transaction_date} onChange={e => setTransactionForm((prev) => ({ ...prev, transaction_date: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Account *</label>
                  <select value={transactionForm.account_id} onChange={e => setTransactionForm((prev) => ({ ...prev, account_id: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="">— Select account —</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.account_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Direction</label>
                  <select value={transactionForm.direction} onChange={e => setTransactionForm((prev) => ({ ...prev, direction: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-sm">
                    <option value="in">Inflow</option>
                    <option value="out">Outflow</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Type</label>
                  <select value={transactionForm.entry_type} onChange={e => setTransactionForm((prev) => ({ ...prev, entry_type: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-sm capitalize">
                    {BANK_ENTRY_TYPES.map((type) => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Amount *</label>
                  <input type="number" min="0" step="0.01" value={transactionForm.amount} onChange={e => setTransactionForm((prev) => ({ ...prev, amount: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-sm" placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Reference</label>
                <input value={transactionForm.reference_note} onChange={e => setTransactionForm((prev) => ({ ...prev, reference_note: e.target.value }))}
                  className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Cheque no, transfer ref, reason..." />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Notes</label>
                <textarea value={transactionForm.notes} onChange={e => setTransactionForm((prev) => ({ ...prev, notes: e.target.value }))}
                  rows={2} className="w-full border rounded px-2 py-1.5 text-sm resize-none" />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={saveTransaction} disabled={savingTransaction || !transactionForm.account_id || !(parseFloat(transactionForm.amount) > 0)}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {savingTransaction ? 'Saving…' : editTransactionId ? 'Update Transaction' : 'Add Transaction'}
              </button>
              {editTransactionId && (
                <button onClick={cancelTransactionEdit} className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="px-4 py-3 border-b flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="text-sm font-medium text-gray-700">Recent Transactions</div>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search type, reference or notes…"
                className="border rounded-lg px-3 py-2 text-sm w-full md:max-w-xs" />
            </div>
            {loading ? (
              <LoadingPlaceholder label="Loading bank transactions" rows={5} />
            ) : transactions.length === 0 ? (
              <div className="p-8 text-center text-gray-400">No bank transactions found for this period</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                      {['Date', 'Account', 'Type', 'Reference', 'Direction', 'Amount', ''].map((heading) => (
                        <th key={heading} className={`px-3 py-2 ${heading === 'Amount' ? 'text-right' : 'text-left'}`}>{heading}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((transaction) => (
                      <tr key={transaction.id} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2">{new Date(`${transaction.transaction_date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                        <td className="px-3 py-2">{transaction.bank_accounts?.account_name || '—'}</td>
                        <td className="px-3 py-2 capitalize text-gray-500">{String(transaction.entry_type || '').replace('_', ' ')}</td>
                        <td className="px-3 py-2 text-gray-500 max-w-xs truncate">{transaction.reference_note || transaction.notes || '—'}</td>
                        <td className={`px-3 py-2 capitalize ${transaction.direction === 'in' ? 'text-green-700' : 'text-red-700'}`}>{transaction.direction === 'in' ? 'Inflow' : 'Outflow'}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${transaction.direction === 'in' ? 'text-green-700' : 'text-red-700'}`}>{fmt(transaction.amount)}</td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => startEditTransaction(transaction)} className="text-blue-600 hover:underline text-xs mr-3">Edit</button>
                          <button onClick={() => deactivateTransaction(transaction.id)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
