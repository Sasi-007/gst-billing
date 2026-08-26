'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { calculateCreditBalance, formatSettlementLabel, groupCreditEntriesByAccount, normalizeSettlementDay, WEEKDAY_OPTIONS } from '@/lib/credits'
import { todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'
import { enqueuePendingAction, listPendingActions, removePendingAction, updatePendingAction } from '@/lib/offlineBilling'

function isOnline() {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

const ACCOUNT_TYPES = [
  { value: 'borrower', label: 'Customer Credit (they owe us)' },
  { value: 'lender', label: 'Supplier / Agency Credit (we owe them)' },
]

const CYCLE_TYPES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]
const AUTO_INVOICE_CREDIT_NOTE = 'Auto-created from invoice credit billing'
const AUTO_INVOICE_CREDIT_TAG_PREFIX = '[AUTO-INVOICE:'

function sanitizePhoneInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 10)
}

function isValidPhoneNumber(value) {
  return /^[6-9]\d{9}$/.test(value)
}

function getCreditErrorMessage(message) {
  if (message && message.includes('credit_accounts_settlement_cycle_check')) {
    return 'Weekly settlement needs the latest credit SQL update. Run supabase/updates_2026_08_20_credit_weekly_cycle.sql once and try again.'
  }
  return message
}

function emptyAccount() {
  return {
    party_name: '',
    phone: '',
    relation_type: 'borrower',
    settlement_cycle: 'daily',
    settlement_day: '1',
    opening_balance: '',
    notes: '',
    is_active: true,
  }
}

function emptyEntry() {
  return {
    direction: 'increase',
    amount: '',
    entry_date: todayStr(),
    reference_note: '',
  }
}

function displayDirectionLabel(relationType, direction) {
  if (relationType === 'lender') {
    return direction === 'increase' ? 'Borrowed More' : 'Repaid'
  }
  return direction === 'increase' ? 'Given on Credit' : 'Collected'
}

function extractAutoInvoiceId(referenceNote) {
  const note = String(referenceNote || '')
  const start = note.indexOf(AUTO_INVOICE_CREDIT_TAG_PREFIX)
  if (start < 0) return ''
  const end = note.indexOf(']', start)
  if (end < 0) return ''
  return note.slice(start + AUTO_INVOICE_CREDIT_TAG_PREFIX.length, end).trim()
}

async function applyBorrowerCollectionToInvoices(shopId, accountId, amount) {
  const settlementAmount = Number(amount || 0)
  if (!shopId || !accountId || settlementAmount <= 0) return

  const { data: mappedEntries, error: entryErr } = await supabase
    .from('credit_entries')
    .select('reference_note')
    .eq('shop_id', shopId)
    .eq('account_id', accountId)
    .eq('direction', 'increase')
    .ilike('reference_note', `%${AUTO_INVOICE_CREDIT_TAG_PREFIX}%`)
  if (entryErr) throw entryErr

  const billIds = [...new Set((mappedEntries || [])
    .map((entry) => extractAutoInvoiceId(entry.reference_note))
    .filter(Boolean))]
  if (!billIds.length) return

  const { data: billRows, error: billErr } = await supabase
    .from('bills')
    .select('id,date,created_at,total,paid_amount,payment_status')
    .eq('shop_id', shopId)
    .in('id', billIds)
  if (billErr) throw billErr

  const openBills = (billRows || [])
    .filter((bill) => Number(bill.total || 0) - Number(bill.paid_amount || 0) > 0)
    .sort((left, right) => {
      const leftTime = new Date(left.date ? `${left.date}T00:00:00` : left.created_at || 0).getTime()
      const rightTime = new Date(right.date ? `${right.date}T00:00:00` : right.created_at || 0).getTime()
      return leftTime - rightTime
    })

  let remaining = settlementAmount
  for (const bill of openBills) {
    if (remaining <= 0) break

    const total = Number(bill.total || 0)
    const paid = Number(bill.paid_amount || 0)
    const due = Math.max(0, total - paid)
    if (due <= 0) continue

    const applied = Math.min(remaining, due)
    const nextPaid = paid + applied
    const nextStatus = nextPaid >= total ? 'paid' : nextPaid > 0 ? 'partial' : 'unpaid'

    const { error: updateErr } = await supabase
      .from('bills')
      .update({
        paid_amount: nextPaid,
        payment_status: nextStatus,
      })
      .eq('id', bill.id)
      .eq('shop_id', shopId)
    if (updateErr) throw updateErr

    remaining -= applied
  }
}

async function getLiveBorrowerDue(shopId, accountId) {
  if (!shopId || !accountId) return 0
  const [{ data: accountRow, error: accountErr }, { data: accountEntries, error: entriesErr }] = await Promise.all([
    supabase
      .from('credit_accounts')
      .select('id,opening_balance,relation_type')
      .eq('shop_id', shopId)
      .eq('id', accountId)
      .single(),
    supabase
      .from('credit_entries')
      .select('amount,direction')
      .eq('shop_id', shopId)
      .eq('account_id', accountId),
  ])
  if (accountErr) throw accountErr
  if (entriesErr) throw entriesErr
  if (!accountRow || accountRow.relation_type !== 'borrower') return 0
  return Math.max(0, calculateCreditBalance(accountRow, accountEntries || []))
}

export default function CreditsPage() {
  const { shop } = useShop()
  const accountsCacheKey = shop?.id ? `credits:accounts:${shop.id}` : ''
  const initialAccountsCache = readPageCache(accountsCacheKey)
  const [accounts, setAccounts] = useState(() => initialAccountsCache?.accounts || [])
  const [entries, setEntries] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(() => !initialAccountsCache)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [error, setError] = useState('')
  const [offlineNotice, setOfflineNotice] = useState('')
  const [toast, setToast] = useState('')
  const [search, setSearch] = useState('')
  const [cycleFilter, setCycleFilter] = useState('all')
  const [showClosed, setShowClosed] = useState(false)
  const [accountForm, setAccountForm] = useState(emptyAccount())
  const [entryForm, setEntryForm] = useState(emptyEntry())
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingEntry, setSavingEntry] = useState(false)
  const syncInProgressRef = useRef(false)
  usePageLoadingState('credits-page', loading || entriesLoading)

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedId) || null,
    [accounts, selectedId]
  )

  const filteredAccounts = useMemo(() => {
    const term = search.trim().toLowerCase()
    return accounts.filter((acc) => {
      const currentBalance = Number(acc.current_balance || 0)
      if (!showClosed && currentBalance === 0) return false
      if (cycleFilter !== 'all' && acc.settlement_cycle !== cycleFilter) return false
      if (!term) return true
      return (
        String(acc.party_name || '').toLowerCase().includes(term) ||
        String(acc.phone || '').toLowerCase().includes(term)
      )
    })
  }, [accounts, cycleFilter, search, showClosed])

  const customerAccounts = useMemo(
    () => filteredAccounts.filter((acc) => acc.relation_type === 'borrower'),
    [filteredAccounts]
  )
  const supplierAccounts = useMemo(
    () => filteredAccounts.filter((acc) => acc.relation_type === 'lender'),
    [filteredAccounts]
  )
  const receivableTotal = useMemo(
    () => accounts
      .filter((acc) => acc.relation_type === 'borrower')
      .reduce((sum, acc) => sum + Number(acc.current_balance || 0), 0),
    [accounts]
  )
  const payableTotal = useMemo(
    () => accounts
      .filter((acc) => acc.relation_type === 'lender')
      .reduce((sum, acc) => sum + Number(acc.current_balance || 0), 0),
    [accounts]
  )

  function showToast(message) {
    setToast(message)
    setTimeout(() => setToast(''), 3000)
  }

  const loadAccounts = useCallback(async () => {
    if (!shop?.id) return
    const cached = readPageCache(accountsCacheKey)
    setError('')
    setOfflineNotice('')
    if (cached?.accounts) {
      setAccounts(cached.accounts)
      setLoading(false)
    } else {
      setLoading(true)
    }

    if (!isOnline()) {
      if (cached?.accounts) {
        setAccounts(cached.accounts)
        setOfflineNotice('Offline mode: showing cached credit accounts')
        setLoading(false)
        return
      }
      setAccounts([])
      setError('Credit accounts need an online sync at least once before they can be viewed offline.')
      setLoading(false)
      return
    }

    try {
      const { data, error: loadErr } = await supabase
        .from('credit_accounts')
        .select('*')
        .eq('shop_id', shop.id)
        .order('party_name')

      if (loadErr) {
        throw new Error(loadErr.message.includes('credit_accounts')
          ? 'Credit tables are missing. Run the new Supabase SQL update for credit ledger first.'
          : loadErr.message)
      }

      const { data: txnRows, error: txnErr } = await supabase
        .from('credit_entries')
        .select('id,account_id,amount,direction')
        .eq('shop_id', shop.id)

      if (txnErr) throw new Error(txnErr.message)

      const grouped = groupCreditEntriesByAccount(txnRows || [])

      const nextAccounts = (data || []).map((acc) => ({
        ...acc,
        current_balance: calculateCreditBalance(acc, grouped[acc.id] || []),
      })).filter((acc) => {
        const isAutoInvoiceAccount = String(acc.notes || '') === AUTO_INVOICE_CREDIT_NOTE
        const hasOpeningBalance = Number(acc.opening_balance || 0) !== 0
        const hasBalance = Number(acc.current_balance || 0) !== 0
        const hasManualEntries = (grouped[acc.id] || []).length > 0
        if (!isAutoInvoiceAccount) return true
        return hasOpeningBalance || hasBalance || hasManualEntries
      })

      setAccounts(nextAccounts)
      writePageCache(accountsCacheKey, { accounts: nextAccounts })
      if (selectedId && !nextAccounts.some((acc) => acc.id === selectedId)) {
        setSelectedId('')
      }
      setLoading(false)
    } catch (loadErr) {
      if (cached?.accounts) {
        setAccounts(cached.accounts)
        setOfflineNotice('Offline mode: showing cached credit accounts')
        setLoading(false)
        return
      }
      setError(loadErr.message)
      setLoading(false)
    }
  }, [accountsCacheKey, selectedId, shop?.id])

  const loadEntries = useCallback(async () => {
    if (!shop?.id || !selectedId) { setEntries([]); return }
    const entriesCacheKey = `credits:entries:${shop.id}:${selectedId}`
    const cached = readPageCache(entriesCacheKey)
    setOfflineNotice('')
    if (cached?.entries) {
      setEntries(cached.entries)
      setEntriesLoading(false)
    } else {
      setEntriesLoading(true)
    }

    if (!isOnline()) {
      if (cached?.entries) {
        setEntries(cached.entries)
        setOfflineNotice('Offline mode: showing cached credit entries')
        setEntriesLoading(false)
        return
      }
      setEntries([])
      setEntriesLoading(false)
      return
    }

    try {
      const { data, error: loadErr } = await supabase
        .from('credit_entries')
        .select('*')
        .eq('shop_id', shop.id)
        .eq('account_id', selectedId)
        .order('entry_date', { ascending: false })
        .order('created_at', { ascending: false })

      if (loadErr) throw new Error(loadErr.message)

      const nextEntries = data || []
      setEntries(nextEntries)
      writePageCache(entriesCacheKey, { entries: nextEntries })
      setEntriesLoading(false)
    } catch (loadErr) {
      if (cached?.entries) {
        setEntries(cached.entries)
        setOfflineNotice('Offline mode: showing cached credit entries')
        setEntriesLoading(false)
        return
      }
      setError(loadErr.message)
      setEntriesLoading(false)
    }
  }, [shop?.id, selectedId])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => { loadEntries() }, [loadEntries])

  useEffect(() => {
    if (!shop?.id || !isOnline()) return

    let cancelled = false
    async function syncQueue() {
      if (syncInProgressRef.current) return
      syncInProgressRef.current = true
      try {
        const queue = await listPendingActions(shop.id, 'credit-entry')
        for (const record of queue) {
          if (cancelled) return
          await updatePendingAction(record.id, { status: 'syncing' })

          const { error: saveErr } = await supabase.from('credit_entries').insert({
            shop_id: shop.id,
            account_id: record.accountId,
            direction: record.direction,
            amount: Number(record.amount || 0),
            entry_date: record.entry_date,
            reference_note: record.reference_note || null,
          })
          if (saveErr) throw saveErr

          if (record.direction === 'decrease') {
            let relationType = record.accountRelationType || ''
            if (!relationType) {
              const { data: accountRow, error: accountErr } = await supabase
                .from('credit_accounts')
                .select('relation_type')
                .eq('id', record.accountId)
                .eq('shop_id', shop.id)
                .single()
              if (accountErr) throw accountErr
              relationType = accountRow?.relation_type || ''
            }
            if (relationType === 'borrower') {
              await applyBorrowerCollectionToInvoices(shop.id, record.accountId, Number(record.amount || 0))
            }
          }

          await removePendingAction(record.id)
        }

        await loadAccounts()
        if (selectedId) await loadEntries()
      } catch (syncErr) {
        console.warn('Credit queue sync failed:', syncErr)
      } finally {
        syncInProgressRef.current = false
      }
    }

    syncQueue()
    window.addEventListener('online', syncQueue)
    return () => {
      cancelled = true
      window.removeEventListener('online', syncQueue)
    }
  }, [loadAccounts, loadEntries, selectedId, shop?.id])

  useEffect(() => {
    if (selectedAccount) {
      setAccountForm({
        party_name: selectedAccount.party_name || '',
        phone: sanitizePhoneInput(selectedAccount.phone || ''),
        relation_type: selectedAccount.relation_type || 'borrower',
        settlement_cycle: selectedAccount.settlement_cycle || 'daily',
        settlement_day: String(selectedAccount.settlement_day || 1),
        opening_balance: String(selectedAccount.opening_balance || ''),
        notes: selectedAccount.notes || '',
        is_active: selectedAccount.is_active,
      })
      setEntryForm((prev) => ({ ...prev, direction: 'increase' }))
    } else {
      setAccountForm(emptyAccount())
    }
  }, [selectedAccount])

  function handleSettlementCycleChange(nextCycle) {
    setAccountForm((current) => ({
      ...current,
      settlement_cycle: nextCycle,
      settlement_day: String(normalizeSettlementDay(nextCycle, current.settlement_day) || 1),
    }))
  }

  async function saveAccount(e) {
    e.preventDefault()
    if (!shop?.id) return
    if (!accountForm.party_name.trim()) {
      setError('Party name is required')
      return
    }
    const cleanedPhone = sanitizePhoneInput(accountForm.phone)
    if (cleanedPhone && !isValidPhoneNumber(cleanedPhone)) {
      setError('Phone number must be a valid 10-digit mobile number')
      return
    }
    if (!isOnline()) {
      setError('Creating or editing credit accounts offline is not available yet. You can still view cached accounts.')
      return
    }
    if (!isOnline()) {
      setError('Credit account edits need internet. You can view cached credit data offline.')
      return
    }

    setSavingAccount(true)
    setError('')
    const payload = {
      shop_id: shop.id,
      party_name: accountForm.party_name.trim(),
      phone: cleanedPhone || null,
      relation_type: accountForm.relation_type,
      settlement_cycle: accountForm.settlement_cycle,
      settlement_day: normalizeSettlementDay(accountForm.settlement_cycle, accountForm.settlement_day),
      opening_balance: Number(accountForm.opening_balance || 0),
      notes: accountForm.notes.trim() || null,
      is_active: !!accountForm.is_active,
      updated_at: new Date().toISOString(),
    }

    let saveErr = null
    if (selectedAccount) {
      const { error: err } = await supabase
        .from('credit_accounts')
        .update(payload)
        .eq('id', selectedAccount.id)
        .eq('shop_id', shop.id)
      saveErr = err
    } else {
      const { error: err } = await supabase.from('credit_accounts').insert(payload)
      saveErr = err
    }

    setSavingAccount(false)
    if (saveErr) {
      setError(getCreditErrorMessage(saveErr.message))
      return
    }

    showToast(selectedAccount ? 'Credit account updated' : 'Credit account added')
    if (!selectedAccount) {
      setAccountForm(emptyAccount())
    }
    await loadAccounts()
  }

  async function addEntry(e) {
    e.preventDefault()
    if (!shop?.id || !selectedAccount) return
    const amount = Number(entryForm.amount || 0)
    if (amount <= 0) {
      setError('Amount must be greater than zero')
      return
    }
    const currentBalance = calculateCreditBalance(selectedAccount, entries)
    const isBorrowerCollection = selectedAccount.relation_type === 'borrower' && entryForm.direction === 'decrease'
    if (isBorrowerCollection && amount > Math.max(0, currentBalance)) {
      setError(`Collected amount exceeds pending due (${fmt(Math.max(0, currentBalance))})`)
      return
    }
    if (!isOnline()) {
      const tempId = `credit-offline-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const offlineEntry = {
        id: tempId,
        shop_id: shop.id,
        account_id: selectedAccount.id,
        direction: entryForm.direction,
        amount,
        entry_date: entryForm.entry_date,
        reference_note: entryForm.reference_note.trim() || null,
        created_at: new Date().toISOString(),
        _pendingSync: true,
      }
      await enqueuePendingAction(shop.id, {
        type: 'credit-entry',
        accountId: selectedAccount.id,
        accountRelationType: selectedAccount.relation_type,
        direction: entryForm.direction,
        amount,
        entry_date: entryForm.entry_date,
        reference_note: entryForm.reference_note.trim() || null,
      })
      setEntries((prev) => [offlineEntry, ...prev])
      setAccounts((prev) => prev.map((acc) => (
        acc.id === selectedAccount.id
          ? { ...acc, current_balance: calculateCreditBalance(acc, [offlineEntry, ...entries]) }
          : acc
      )))
      setEntryForm(emptyEntry())
      showToast('Credit entry saved offline. It will sync when internet returns.')
      setOfflineNotice('Offline mode: credit entry queued for sync')
      return
    }

    setSavingEntry(true)
    setError('')
    if (isBorrowerCollection) {
      try {
        const liveDue = await getLiveBorrowerDue(shop.id, selectedAccount.id)
        if (amount > liveDue) {
          setSavingEntry(false)
          setError(`Collected amount exceeds pending due (${fmt(liveDue)})`)
          return
        }
      } catch (dueErr) {
        setSavingEntry(false)
        setError(dueErr.message || 'Unable to validate pending due')
        return
      }
    }
    const { error: saveErr } = await supabase.from('credit_entries').insert({
      shop_id: shop.id,
      account_id: selectedAccount.id,
      direction: entryForm.direction,
      amount,
      entry_date: entryForm.entry_date,
      reference_note: entryForm.reference_note.trim() || null,
    })

    setSavingEntry(false)
    if (saveErr) {
      setError(saveErr.message)
      return
    }

    if (entryForm.direction === 'decrease' && selectedAccount.relation_type === 'borrower') {
      try {
        await applyBorrowerCollectionToInvoices(shop.id, selectedAccount.id, amount)
      } catch (syncErr) {
        setError(syncErr.message || 'Saved credit entry, but invoice sync failed')
      }
    }

    setEntryForm(emptyEntry())
    showToast('Credit entry added')
    await loadEntries()
    await loadAccounts()
  }

  async function toggleActive(account) {
    if (!shop?.id) return
    if (!isOnline()) {
      setError('Offline changes are not available for credit accounts yet.')
      return
    }
    const { error: saveErr } = await supabase
      .from('credit_accounts')
      .update({ is_active: !account.is_active, updated_at: new Date().toISOString() })
      .eq('id', account.id)
      .eq('shop_id', shop.id)
    if (saveErr) {
      setError(saveErr.message)
      return
    }
    showToast(account.is_active ? 'Account archived' : 'Account activated')
    await loadAccounts()
  }

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Credit Book</h1>
          <p className="text-sm text-gray-500">Track customer credit separately from supplier / agency dues with daily, weekly or monthly settlement.</p>
        </div>
      </div>

      {offlineNotice && <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">{offlineNotice}</div>}
      {toast && <div className="mb-3 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">✓ {toast}</div>}
      {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
        <StatCard label="Accounts" value={accounts.length} />
        <StatCard label="To Collect" value={fmt(receivableTotal)} />
        <StatCard label="To Pay" value={fmt(payableTotal)} />
        <StatCard label="Daily Cycle" value={accounts.filter(a => a.settlement_cycle === 'daily').length} />
        <StatCard label="Weekly Cycle" value={accounts.filter(a => a.settlement_cycle === 'weekly').length} />
        <StatCard label="Monthly Cycle" value={accounts.filter(a => a.settlement_cycle === 'monthly').length} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px,1fr] gap-4">
        <div className="space-y-4">
          <form onSubmit={saveAccount} className="bg-white border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-800">{selectedAccount ? 'Edit Account' : 'New Account'}</h2>
              {selectedAccount && (
                <button
                  type="button"
                  onClick={() => { setSelectedId(''); setAccountForm(emptyAccount()) }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  + New
                </button>
              )}
            </div>

            <Field label="Party Name *">
              <input value={accountForm.party_name} onChange={(e) => setAccountForm((s) => ({ ...s, party_name: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                pattern="[0-9]{10}"
                value={accountForm.phone}
                onChange={(e) => setAccountForm((s) => ({ ...s, phone: sanitizePhoneInput(e.target.value) }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <select value={accountForm.relation_type} onChange={(e) => setAccountForm((s) => ({ ...s, relation_type: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  {ACCOUNT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </Field>
              <Field label="Settlement">
                <select value={accountForm.settlement_cycle} onChange={(e) => handleSettlementCycleChange(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  {CYCLE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </Field>
            </div>
            <div className={`grid ${accountForm.settlement_cycle === 'daily' ? 'grid-cols-1' : 'grid-cols-2'} gap-3`}>
              {accountForm.settlement_cycle === 'monthly' && (
                <Field label="Settlement Day">
                  <input type="number" min="1" max="31" value={accountForm.settlement_day}
                    onChange={(e) => setAccountForm((s) => ({ ...s, settlement_day: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </Field>
              )}
              {accountForm.settlement_cycle === 'weekly' && (
                <Field label="Settlement Weekday">
                  <select value={accountForm.settlement_day} onChange={(e) => setAccountForm((s) => ({ ...s, settlement_day: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm">
                    {WEEKDAY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Opening Balance">
                <input type="number" min="0" step="0.01" value={accountForm.opening_balance}
                  onChange={(e) => setAccountForm((s) => ({ ...s, opening_balance: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </Field>
            </div>
            <Field label="Notes">
              <textarea value={accountForm.notes} onChange={(e) => setAccountForm((s) => ({ ...s, notes: e.target.value }))}
                rows={2} className="w-full border rounded-lg px-3 py-2 text-sm resize-none" />
            </Field>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={accountForm.is_active} onChange={(e) => setAccountForm((s) => ({ ...s, is_active: e.target.checked }))} />
              Active
            </label>

            <button type="submit" disabled={savingAccount}
              className="w-full bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {savingAccount ? 'Saving…' : selectedAccount ? 'Update Account' : 'Create Account'}
            </button>
          </form>

          <div className="bg-white border rounded-xl p-4">
            <h2 className="font-semibold text-gray-800 mb-3">Accounts</h2>
            <div className="space-y-2 mb-3">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search party or phone"
                className="w-full border rounded-lg px-3 py-2 text-sm" />
              <div className="grid grid-cols-1 gap-2">
                <select value={cycleFilter} onChange={(e) => setCycleFilter(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm">
                  <option value="all">All Cycles</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={showClosed}
                    onChange={(e) => setShowClosed(e.target.checked)}
                  />
                  Show closed accounts (₹0)
                </label>
              </div>
            </div>

            {loading ? (
              <LoadingPlaceholder label="Loading accounts" rows={3} />
            ) : filteredAccounts.length === 0 ? (
              <div className="text-sm text-gray-400 py-8 text-center">No credit accounts found</div>
            ) : (
              <div className="space-y-2 max-h-[480px] overflow-y-auto">
                <AccountGroup
                  title="Customers who owe us"
                  subtitle="Shop gave goods / money on credit"
                  emptyText="No customer credit accounts"
                  accounts={customerAccounts}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
                <AccountGroup
                  title="Suppliers / agencies we owe"
                  subtitle="Shop took goods / money on credit"
                  emptyText="No supplier / agency due accounts"
                  accounts={supplierAccounts}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {!selectedAccount ? (
            <div className="bg-white border rounded-xl p-8 text-center text-gray-400">
              Create a new account or select a customer / supplier account to record daily, weekly or monthly credit entries.
            </div>
          ) : (
            <>
              <div className="bg-white border rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">{selectedAccount.party_name}</h2>
                    <div className="text-sm text-gray-500">
                      {selectedAccount.relation_type === 'borrower' ? 'Customer credit · they owe us' : 'Supplier / agency credit · we owe them'} · {formatSettlementLabel(selectedAccount.settlement_cycle, selectedAccount.settlement_day)}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => toggleActive(selectedAccount)}
                      className="px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
                      {selectedAccount.is_active ? 'Archive' : 'Activate'}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                  <StatCard label="Opening" value={fmt(selectedAccount.opening_balance || 0)} compact />
                  <StatCard label="Current Balance" value={fmt(calculateCreditBalance(selectedAccount, entries))} compact />
                  <StatCard label="Entries" value={entries.length} compact />
                </div>
              </div>

              <form onSubmit={addEntry} className="bg-white border rounded-xl p-4 space-y-3">
                <h3 className="font-semibold text-gray-800">Add Entry</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Field label="Action">
                    <select value={entryForm.direction} onChange={(e) => setEntryForm((s) => ({ ...s, direction: e.target.value }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm">
                      <option value="increase">{displayDirectionLabel(selectedAccount.relation_type, 'increase')}</option>
                      <option value="decrease">{displayDirectionLabel(selectedAccount.relation_type, 'decrease')}</option>
                    </select>
                  </Field>
                  <Field label="Amount">
                    <input type="number" min="0" step="0.01" value={entryForm.amount}
                      onChange={(e) => setEntryForm((s) => ({ ...s, amount: e.target.value }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </Field>
                  <Field label="Date">
                    <input type="date" value={entryForm.entry_date}
                      onChange={(e) => setEntryForm((s) => ({ ...s, entry_date: e.target.value }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </Field>
                  <Field label="Reference">
                    <input value={entryForm.reference_note}
                      onChange={(e) => setEntryForm((s) => ({ ...s, reference_note: e.target.value }))}
                      placeholder="Bill no / note"
                      className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </Field>
                </div>
                <button type="submit" disabled={savingEntry}
                  className="bg-green-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {savingEntry ? 'Saving…' : 'Add Entry'}
                </button>
              </form>

              <div className="bg-white border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b font-semibold text-gray-800">Ledger History</div>
                {entriesLoading ? (
                  <LoadingPlaceholder label="Loading ledger entries" rows={4} />
                ) : entries.length === 0 ? (
                  <div className="text-sm text-gray-400 py-8 text-center">No entries yet</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                        {['Date', 'Action', 'Reference', 'Amount'].map((h) => (
                          <th key={h} className="px-4 py-2 text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr key={entry.id} className="border-b last:border-b-0">
                          <td className="px-4 py-2">{new Date(entry.entry_date + 'T00:00:00').toLocaleDateString('en-IN')}</td>
                          <td className="px-4 py-2">{displayDirectionLabel(selectedAccount.relation_type, entry.direction)}</td>
                          <td className="px-4 py-2 text-gray-500">{entry.reference_note || '—'}</td>
                          <td className={`px-4 py-2 font-medium ${entry.direction === 'increase' ? 'text-red-600' : 'text-green-600'}`}>
                            {entry.direction === 'increase' ? '+' : '-'} {fmt(entry.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function AccountGroup({ title, subtitle, emptyText, accounts, selectedId, onSelect }) {
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 border-b">
        <div className="text-sm font-medium text-gray-800">{title}</div>
        <div className="text-xs text-gray-400">{subtitle}</div>
      </div>
      {accounts.length === 0 ? (
        <div className="px-3 py-4 text-xs text-gray-400 text-center">{emptyText}</div>
      ) : (
        <div className="divide-y">
          {accounts.map((acc) => (
            <button
              key={acc.id}
              type="button"
              onClick={() => onSelect(acc.id)}
              className={`w-full p-3 text-left ${selectedId === acc.id ? 'bg-blue-50 border-l-4 border-blue-500' : 'hover:bg-gray-50'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-900">{acc.party_name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{formatSettlementLabel(acc.settlement_cycle, acc.settlement_day)}</div>
                  {acc.phone && <div className="text-xs text-gray-400 mt-0.5">{acc.phone}</div>}
                </div>
                <div className="text-right">
                  <div className={`font-semibold ${acc.relation_type === 'borrower' ? 'text-cyan-700' : 'text-purple-700'}`}>{fmt(acc.current_balance)}</div>
                  <div className={`text-[11px] ${acc.is_active ? 'text-green-600' : 'text-gray-400'}`}>
                    {acc.is_active ? 'Active' : 'Archived'}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, compact = false }) {
  return (
    <div className={`bg-white border rounded-xl ${compact ? 'p-3' : 'p-4'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`${compact ? 'text-lg' : 'text-2xl'} font-bold mt-1 text-gray-900`}>{value}</div>
    </div>
  )
}
