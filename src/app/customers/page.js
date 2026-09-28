'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { calculateCreditBalance, groupCreditEntriesByAccount } from '@/lib/credits'
import { useShop } from '@/context/ShopContext'
import { fmt } from '@/lib/gst'
import {
  archiveCustomerRecord,
  ensureCustomerRecord,
  fetchCustomerDirectory,
  isUuidLike,
  matchesCustomerSearch,
  normalizeCustomerPhone,
} from '@/lib/customers'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { supabase } from '@/lib/supabase'

const EMPTY_FORM = { name: '', phone: '', gstin: '', address: '' }

function normalizeGstin(value) {
  return String(value || '').trim().toUpperCase().slice(0, 15)
}

function normalizeText(value) {
  return String(value || '').trim()
}

function buildCustomerPayload(form) {
  return {
    customer_name: normalizeText(form.name) || null,
    customer_phone: normalizeCustomerPhone(form.phone) || null,
    customer_gstin: normalizeGstin(form.gstin) || null,
    customer_address: normalizeText(form.address) || null,
  }
}

function getCustomerDisplayName(customer) {
  return customer?.name || customer?.phone || 'Customer'
}

function getAverageInvoiceValue(customer) {
  const invoiceCount = Number(customer?.invoiceCount || 0)
  if (invoiceCount <= 0) return 0
  return Number(customer?.totalInvoiceValue || 0) / invoiceCount
}

async function getBorrowerAccountBalances(shopId, accountIds) {
  const uniqueAccountIds = [...new Set((accountIds || []).filter(Boolean))]
  if (!shopId || uniqueAccountIds.length === 0) return new Map()

  const [{ data: accounts, error: accountsError }, { data: entries, error: entriesError }] = await Promise.all([
    supabase
      .from('credit_accounts')
      .select('id,opening_balance')
      .eq('shop_id', shopId)
      .in('id', uniqueAccountIds),
    supabase
      .from('credit_entries')
      .select('account_id,amount,direction')
      .eq('shop_id', shopId)
      .in('account_id', uniqueAccountIds),
  ])

  if (accountsError) throw accountsError
  if (entriesError) throw entriesError

  const groupedEntries = groupCreditEntriesByAccount(entries || [])
  return new Map((accounts || []).map((account) => ([
    account.id,
    Math.max(0, calculateCreditBalance(account, groupedEntries[account.id] || [])),
  ])))
}

async function updateCustomerBills(shopId, billIds, payload) {
  if (!shopId || !billIds.length) return
  const { error } = await supabase
    .from('bills')
    .update(payload)
    .eq('shop_id', shopId)
    .in('id', billIds)
  if (!error) return
  if (!String(error.message || '').toLowerCase().includes('customer_id')) throw error

  const { customer_id, ...legacyPayload } = payload
  const { error: retryError } = await supabase
    .from('bills')
    .update(legacyPayload)
    .eq('shop_id', shopId)
    .in('id', billIds)
  if (retryError) throw retryError
}

async function updateCustomerCreditAccounts(shopId, accountIds, payload) {
  if (!shopId || !accountIds.length) return
  const { error } = await supabase
    .from('credit_accounts')
    .update(payload)
    .eq('shop_id', shopId)
    .in('id', accountIds)
  if (!error) return
  if (!String(error.message || '').toLowerCase().includes('customer_id')) throw error

  const { customer_id, ...legacyPayload } = payload
  const { error: retryError } = await supabase
    .from('credit_accounts')
    .update(legacyPayload)
    .eq('shop_id', shopId)
    .in('id', accountIds)
  if (retryError) throw retryError
}

export default function CustomersPage() {
  const { shop } = useShop()
  const cacheKey = shop?.id ? `customers-directory:${shop.id}` : ''
  const initialCache = readPageCache(cacheKey, 5 * 60 * 1000)
  const [customers, setCustomers] = useState(() => initialCache?.customers || [])
  const [search, setSearch] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState(() => initialCache?.customers?.[0]?.id || '')
  const [selectedCustomerIds, setSelectedCustomerIds] = useState([])
  const [loading, setLoading] = useState(() => !initialCache)
  const [error, setError] = useState('')
  const [toast, setToast] = useState(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const debouncedSearch = useDebouncedValue(search)
  usePageLoadingState('customers-page', loading)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const loadCustomers = useCallback(async () => {
    if (!shop?.id) {
      setCustomers([])
      setSelectedCustomerId('')
      setLoading(false)
      return []
    }

    const cached = readPageCache(cacheKey, 5 * 60 * 1000)
    if (cached?.customers) {
      setCustomers(cached.customers)
      setLoading(false)
    } else {
      setLoading(true)
    }

    try {
      setError('')
      const nextCustomers = await fetchCustomerDirectory(shop.id)
      setCustomers(nextCustomers)
      setSelectedCustomerId((current) => (
        nextCustomers.some((customer) => customer.id === current)
          ? current
          : nextCustomers[0]?.id || ''
      ))
      writePageCache(cacheKey, { customers: nextCustomers })
      return nextCustomers
    } catch (loadError) {
      const fallback = readPageCache(cacheKey, 5 * 60 * 1000)
      if (fallback?.customers) {
        setCustomers(fallback.customers)
        setSelectedCustomerId((current) => (
          fallback.customers.some((customer) => customer.id === current)
            ? current
            : fallback.customers[0]?.id || ''
        ))
        setError('Showing cached customer data')
        return fallback.customers
      }

      setCustomers([])
      setSelectedCustomerId('')
      setError(loadError?.message || 'Failed to load customers')
      return []
    } finally {
      setLoading(false)
    }
  }, [cacheKey, shop?.id])

  useEffect(() => {
    loadCustomers()
  }, [loadCustomers])

  useEffect(() => {
    if (!shop?.id) return
    const channel = supabase.channel(`customers-live:${shop.id}`)
    ;['customers', 'bills', 'credit_accounts'].forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `shop_id=eq.${shop.id}` }, () => {
        loadCustomers()
      })
    })
    channel.subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadCustomers, shop?.id])

  const filteredCustomers = useMemo(
    () => customers.filter((customer) => matchesCustomerSearch(customer, debouncedSearch)),
    [customers, debouncedSearch]
  )

  useEffect(() => {
    if (!filteredCustomers.length) {
      setSelectedCustomerId('')
      setSelectedCustomerIds([])
      return
    }
    if (!filteredCustomers.some((customer) => customer.id === selectedCustomerId)) {
      setSelectedCustomerId(filteredCustomers[0].id)
    }
    setSelectedCustomerIds((current) => current.filter((id) => filteredCustomers.some((customer) => customer.id === id)))
  }, [filteredCustomers, selectedCustomerId])

  const selectedCustomer = filteredCustomers.find((customer) => customer.id === selectedCustomerId) || filteredCustomers[0] || null
  const allVisibleSelected = filteredCustomers.length > 0 && filteredCustomers.every((customer) => selectedCustomerIds.includes(customer.id))

  useEffect(() => {
    if (!editing || !selectedCustomer) {
      setForm(EMPTY_FORM)
      return
    }

    setForm({
      name: selectedCustomer.name || '',
      phone: selectedCustomer.phone || '',
      gstin: selectedCustomer.gstin || '',
      address: selectedCustomer.address || '',
    })
  }, [editing, selectedCustomer])

  async function handleSaveCustomer() {
    if (!shop?.id || !selectedCustomer) return

    const normalizedName = normalizeText(form.name)
    const normalizedPhone = String(form.phone || '').replace(/\D/g, '').slice(0, 10)
    const normalizedGstin = normalizeGstin(form.gstin)
    const normalizedAddress = normalizeText(form.address)

    if (!normalizedName && !normalizedPhone && !normalizedGstin && !normalizedAddress) {
      showToast('Enter at least one customer detail', 'error')
      return
    }
    if (normalizedPhone && !normalizeCustomerPhone(normalizedPhone)) {
      showToast('Phone must be 10 digits', 'error')
      return
    }

    setSaving(true)
    try {
      const billIds = selectedCustomer.sourceBillIds || []
      const accountIds = selectedCustomer.sourceAccountIds || []
      const ensuredCustomer = await ensureCustomerRecord(shop.id, {
        id: selectedCustomer.id,
        name: normalizedName,
        phone: normalizedPhone,
        gstin: normalizedGstin,
        address: normalizedAddress,
      })
      const persistedCustomerId = ensuredCustomer?.id || (isUuidLike(selectedCustomer.id) ? selectedCustomer.id : '')

      if (billIds.length) {
        await updateCustomerBills(shop.id, billIds, {
          ...buildCustomerPayload({
            name: normalizedName,
            phone: normalizedPhone,
            gstin: normalizedGstin,
            address: normalizedAddress,
          }),
          ...(persistedCustomerId ? { customer_id: persistedCustomerId } : {}),
        })
      }

      if (accountIds.length) {
        const nextPartyName = normalizedName || selectedCustomer.name || normalizeCustomerPhone(normalizedPhone) || 'Customer'
        await updateCustomerCreditAccounts(shop.id, accountIds, {
          party_name: nextPartyName,
          phone: normalizeCustomerPhone(normalizedPhone) || null,
          ...(persistedCustomerId ? { customer_id: persistedCustomerId } : {}),
        })
      }

      const nextCustomers = await loadCustomers()
      const nextMatch = nextCustomers.find((customer) => {
        if (persistedCustomerId && customer.id === persistedCustomerId) return true
        if (normalizeCustomerPhone(normalizedPhone) && customer.phone === normalizeCustomerPhone(normalizedPhone)) return true
        if (normalizedGstin && customer.gstin === normalizedGstin) return true
        return customer.name === normalizedName && customer.address === normalizedAddress
      })
      setSelectedCustomerId(nextMatch?.id || nextCustomers[0]?.id || '')
      setEditing(false)
      showToast(`${getCustomerDisplayName(selectedCustomer)} updated`)
    } catch (saveError) {
      showToast('Update failed: ' + (saveError?.message || 'Unknown error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteCustomer() {
    if (!shop?.id || !selectedCustomer || deleting) return
    await handleDeleteCustomers([selectedCustomer])
  }

  function handleToggleCustomerSelection(customerId, checked) {
    setSelectedCustomerIds((current) => (
      checked
        ? [...new Set([...current, customerId])]
        : current.filter((id) => id !== customerId)
    ))
  }

  function handleToggleSelectAllVisible(checked) {
    setSelectedCustomerIds((current) => {
      if (checked) {
        return [...new Set([...current, ...filteredCustomers.map((customer) => customer.id)])]
      }
      return current.filter((id) => !filteredCustomers.some((customer) => customer.id === id))
    })
  }

  async function handleDeleteCustomers(customersToDelete) {
    if (!shop?.id || deleting) return
    const targetCustomers = (customersToDelete || []).filter(Boolean)
    if (!targetCustomers.length) {
      showToast('Select at least one customer', 'error')
      return
    }

    const outstandingCustomer = targetCustomers.find((customer) => Number(customer.totalOutstanding || 0) > 0)
    if (outstandingCustomer) {
      showToast(`Settle outstanding amount for ${getCustomerDisplayName(outstandingCustomer)} first`, 'error')
      return
    }

    const accountIds = [...new Set(targetCustomers.flatMap((customer) => customer.sourceAccountIds || []).filter(Boolean))]

    const count = targetCustomers.length
    if (!window.confirm(`Remove ${count} customer${count === 1 ? '' : 's'} from customer list? Invoices will stay, saved details will be cleared, and zero-balance credit accounts will be hidden.`)) return

    setDeleting(true)
    try {
      const accountBalances = await getBorrowerAccountBalances(shop.id, accountIds)
      const creditLinkedCustomer = targetCustomers.find((customer) => (
        (customer.sourceAccountIds || []).some((accountId) => Number(accountBalances.get(accountId) || 0) > 0)
      ))
      if (creditLinkedCustomer) {
        showToast(`Settle credit balance for ${getCustomerDisplayName(creditLinkedCustomer)} first`, 'error')
        return
      }

      const billIds = [...new Set(targetCustomers.flatMap((customer) => customer.sourceBillIds || []).filter(Boolean))]
      if (billIds.length) {
        await updateCustomerBills(shop.id, billIds, {
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          customer_gstin: null,
          customer_address: null,
        })
      }

      if (accountIds.length) {
        await updateCustomerCreditAccounts(shop.id, accountIds, { customer_id: null, is_active: false })
      }

      for (const customer of targetCustomers) {
        await archiveCustomerRecord(shop.id, customer.id)
      }

      const nextCustomers = await loadCustomers()
      setSelectedCustomerIds([])
      setSelectedCustomerId(nextCustomers[0]?.id || '')
      setEditing(false)
      showToast(count === 1 ? 'Customer removed' : `${count} customers removed`)
    } catch (deleteError) {
      showToast('Delete failed: ' + (deleteError?.message || 'Unknown error'), 'error')
    } finally {
      setDeleting(false)
    }
  }

  async function handleDeleteSelectedCustomers() {
    await handleDeleteCustomers(
      customers.filter((customer) => selectedCustomerIds.includes(customer.id))
    )
  }

  return (
    <div className="p-4">
      {toast && (
        <div className={`fixed top-4 left-4 right-4 z-50 rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg sm:left-auto sm:max-w-sm ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
        }`}>
          {toast.msg}
        </div>
      )}

      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">Customers</h1>
        <p className="text-sm text-gray-500">
          Auto-built from saved bills and customer credit accounts.
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="lg:w-[24rem] lg:flex-shrink-0">
          <div className="rounded-xl border bg-white p-3">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, phone, GSTIN, invoice no..."
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
              <span>{filteredCustomers.length} customer{filteredCustomers.length === 1 ? '' : 's'}</span>
              <span className="hidden sm:inline">Select to view details</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(event) => handleToggleSelectAllVisible(event.target.checked)}
                />
                Select all
              </label>
              <button
                type="button"
                onClick={handleDeleteSelectedCustomers}
                disabled={deleting || selectedCustomerIds.length === 0}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleting ? 'Deleting...' : `Delete Selected${selectedCustomerIds.length ? ` (${selectedCustomerIds.length})` : ''}`}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
              {error}
            </div>
          )}

          {loading ? (
            <div className="mt-3">
              <LoadingPlaceholder label="Loading customers" rows={5} fullPage />
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="mt-3 rounded-xl border bg-white px-4 py-8 text-center text-sm text-gray-500">
              No customers yet. Save bills with customer details and they will appear here automatically.
            </div>
          ) : (
            <div className="mt-3 overflow-hidden rounded-xl border bg-white">
              <div className="max-h-[55vh] overflow-y-auto lg:max-h-[calc(100vh-13rem)]">
                {filteredCustomers.map((customer) => (
                  <div
                    key={customer.id}
                    className={`border-b last:border-b-0 ${
                      selectedCustomer?.id === customer.id ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedCustomerIds.includes(customer.id)}
                        onChange={(event) => handleToggleCustomerSelection(customer.id, event.target.checked)}
                        className="mt-1"
                        aria-label={`Select ${getCustomerDisplayName(customer)}`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(false)
                          setSelectedCustomerId(customer.id)
                        }}
                        className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left hover:text-blue-700"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 truncate">
                            {customer.name || customer.phone || 'Unnamed customer'}
                          </div>
                          <div className="text-xs text-gray-500 truncate">
                            {customer.phone || customer.lastBillNo || 'No phone saved yet'}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-gray-500">{customer.billCount} bill{customer.billCount === 1 ? '' : 's'}</div>
                          {customer.totalOutstanding > 0 && (
                            <div className="text-xs font-medium text-cyan-700">{fmt(customer.totalOutstanding)} due</div>
                          )}
                        </div>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="rounded-xl border bg-white p-5 min-h-[22rem] lg:sticky lg:top-4">
          {!selectedCustomer ? (
            <div className="text-sm text-gray-500">Select a customer to view saved details.</div>
          ) : (
            <>
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {getCustomerDisplayName(selectedCustomer)}
                  </h2>
                  <div className="mt-1 text-sm text-gray-500">
                    {selectedCustomer.phone || 'Phone not saved yet'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/billing?customer=${encodeURIComponent(selectedCustomer.id)}`}
                    className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Use in New Bill
                  </Link>
                  <button
                    type="button"
                    onClick={() => setEditing((current) => !current)}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {editing ? 'Cancel' : 'Edit'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteCustomer}
                    disabled={deleting}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>

              {editing ? (
                <div className="mt-5 rounded-xl border bg-gray-50 p-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">Name</label>
                      <input
                        value={form.name}
                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                        placeholder="Customer name"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">Phone</label>
                      <input
                        value={form.phone}
                        onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value.replace(/\D/g, '').slice(0, 10) }))}
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                        placeholder="10-digit phone"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">GSTIN</label>
                      <input
                        value={form.gstin}
                        onChange={(event) => setForm((current) => ({ ...current, gstin: event.target.value.toUpperCase().slice(0, 15) }))}
                        className="w-full rounded-lg border px-3 py-2 text-sm font-mono uppercase"
                        placeholder="GSTIN"
                        maxLength={15}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">Address</label>
                      <input
                        value={form.address}
                        onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))}
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                        placeholder="Address"
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={handleSaveCustomer}
                      disabled={saving}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
                    <div className="rounded-lg border bg-blue-50 p-3">
                      <div className="text-xs text-gray-500">Invoices</div>
                      <div className="mt-1 text-lg font-semibold text-blue-700">{selectedCustomer.invoiceCount || 0}</div>
                    </div>
                    <div className="rounded-lg border bg-green-50 p-3">
                      <div className="text-xs text-gray-500">Revenue Collected</div>
                      <div className="mt-1 text-lg font-semibold text-green-700">{fmt(selectedCustomer.totalCollected || 0)}</div>
                    </div>
                    <div className="rounded-lg border bg-cyan-50 p-3">
                      <div className="text-xs text-gray-500">Open Credits</div>
                      <div className="mt-1 text-lg font-semibold text-cyan-700">{selectedCustomer.openCreditInvoiceCount || 0}</div>
                    </div>
                    <div className="rounded-lg border bg-emerald-50 p-3">
                      <div className="text-xs text-gray-500">Closed Credits</div>
                      <div className="mt-1 text-lg font-semibold text-emerald-700">{selectedCustomer.closedCreditInvoiceCount || 0}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Paid Invoices</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.paidInvoiceCount || 0}</div>
                    </div>
                    <div className="rounded-lg border bg-amber-50 p-3">
                      <div className="text-xs text-gray-500">Partial Invoices</div>
                      <div className="mt-1 text-sm font-semibold text-amber-700">{selectedCustomer.partialInvoiceCount || 0}</div>
                    </div>
                    <div className="rounded-lg border bg-rose-50 p-3">
                      <div className="text-xs text-gray-500">Unpaid Invoices</div>
                      <div className="mt-1 text-sm font-semibold text-rose-700">{selectedCustomer.unpaidInvoiceCount || 0}</div>
                    </div>
                    <div className="rounded-lg border bg-violet-50 p-3">
                      <div className="text-xs text-gray-500">Avg Invoice Value</div>
                      <div className="mt-1 text-sm font-semibold text-violet-700">{fmt(getAverageInvoiceValue(selectedCustomer))}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Credit Invoices Total</div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">{selectedCustomer.creditInvoiceCount || 0}</div>
                    </div>
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Other Docs</div>
                      <div className="mt-1 text-sm text-gray-900">
                        Quotations: {selectedCustomer.quotationCount || 0} • Estimates: {selectedCustomer.estimateCount || 0}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">GSTIN</div>
                      <div className="mt-1 font-mono text-sm text-gray-900">{selectedCustomer.gstin || '—'}</div>
                    </div>
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Address</div>
                      <div className="mt-1 text-sm text-gray-900">{selectedCustomer.address || '—'}</div>
                    </div>
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Last bill</div>
                      <div className="mt-1 text-sm text-gray-900">
                        {selectedCustomer.lastBillNo || '—'}
                        {selectedCustomer.lastBillDate ? ` • ${selectedCustomer.lastBillDate}` : ''}
                      </div>
                    </div>
                    <div className="rounded-lg border bg-gray-50 p-3">
                      <div className="text-xs text-gray-500">Totals</div>
                      <div className="mt-1 text-sm text-gray-900">
                        {selectedCustomer.billCount} bill{selectedCustomer.billCount === 1 ? '' : 's'} • {fmt(selectedCustomer.totalBilled)}
                      </div>
                      {selectedCustomer.totalOutstanding > 0 && (
                        <div className="mt-1 text-sm font-medium text-cyan-700">Outstanding: {fmt(selectedCustomer.totalOutstanding)}</div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {!!selectedCustomer.recentBills?.length && (
                <div className="mt-5">
                  <div className="text-sm font-medium text-gray-700 mb-2">Recent bills</div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                    {selectedCustomer.recentBills.map((bill) => (
                      <div key={bill.billNo} className="rounded-lg border bg-gray-50 px-3 py-2 text-xs text-gray-700">
                        <div className="font-medium text-gray-900">{bill.billNo}</div>
                        <div className="mt-1">
                          {bill.date ? `${bill.date} • ` : ''}{bill.type}
                          {bill.paymentMode ? ` • ${bill.paymentMode}` : ''}
                          {bill.paymentStatus ? ` • ${bill.paymentStatus}` : ''}
                        </div>
                        <div className="mt-1">
                          Total: {fmt(bill.total || 0)} • Paid: {fmt(bill.paidAmount || 0)} • Due: {fmt(bill.dueAmount || 0)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!selectedCustomer.phone && (
                <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Save a phone number to make this customer faster and safer to reuse.
                </div>
              )}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
