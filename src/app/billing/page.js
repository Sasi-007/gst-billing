'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { calcItem, calcBillTotals, fmt, GST_RATES } from '@/lib/gst'
import { printWithContent } from '@/lib/print'
import { todayStr } from '@/lib/finance'
import {
  ensureCustomerRecord,
  fetchCustomerDirectory,
  isMissingCustomerSchemaError,
  isUuidLike,
  matchesCustomerSearch,
  normalizeCustomerPhone,
} from '@/lib/customers'
import ProductSearch from '@/components/ProductSearch'
import PrintTemplate from '@/components/PrintTemplate'
import { useShop } from '@/context/ShopContext'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  applyLocalStockDelta,
  clearBillingDraft,
  enqueuePendingBill,
  listPendingBills,
  loadBillingDraft,
  makeTempBillNo,
  removePendingBill,
  saveBillingDraft,
  updatePendingBill,
} from '@/lib/offlineBilling'
import { getBillProductName } from '@/lib/productNames'

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Credit', 'Cheque']
const AUTO_INVOICE_CREDIT_TAG_PREFIX = '[AUTO-INVOICE:'
const AUTO_INVOICE_CREDIT_NOTE = 'Auto-created from invoice credit billing'

let _uid = 0
function uid() { return ++_uid }

function emptyItem() {
  return {
    _id:            uid(),
    product_id:     null,
    product_name:   '',
    hsn_code:       '',
    unit:           'pcs',
    quantity:       '',
    mrp:            0,
    purchase_price: '',
    rate:           '',
    gst_rate:       0,
    discount_pct:   '',
    // computed
    base_amount:    0,
    gst_amount:     0,
    discount_amount:0,
    total:          0,
  }
}

function emptyCustomer() {
  return { id: '', name: '', phone: '', gstin: '', address: '' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function focusId(id) {
  setTimeout(() => {
    const el = document.getElementById(id)
    if (el) { el.focus(); el.select?.() }
  }, 30)
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function downloadCsv(filename, headers, rows) {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function formatDate(date) {
  return date ? new Date(date + 'T00:00:00').toLocaleDateString('en-IN') : ''
}

function getProfitPreview(item) {
  const purchasePrice = parseFloat(item.purchase_price)
  const quantity = parseFloat(item.quantity)
  const total = parseFloat(item.total)

  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(total) || total <= 0) {
    return null
  }

  const effectiveSellingPrice = total / quantity
  const profitPerUnit = effectiveSellingPrice - purchasePrice
  const totalProfit = profitPerUnit * quantity
  const marginPct = (profitPerUnit / effectiveSellingPrice) * 100

  return {
    totalProfit,
    marginPct,
    purchasePrice,
    totalCost: purchasePrice * quantity,
    isLoss: totalProfit < 0,
  }
}

function getBillProfitSummary(items) {
  return items.reduce((acc, item) => {
    const preview = getProfitPreview(item)
    if (!preview) return acc
    acc.totalProfit += preview.totalProfit
    acc.totalCost += preview.purchasePrice * (parseFloat(item.quantity) || 0)
    return acc
  }, { totalProfit: 0, totalCost: 0 })
}

function normalizePaidAmount(paidAmtValue, totalsTotal, payModeValue) {
  const parsedPaid = parseFloat(paidAmtValue)
  const hasPaidInput = paidAmtValue !== '' && Number.isFinite(parsedPaid)
  const normalizedPayMode = normalizePaymentModeForDb(payModeValue)
  const defaultPaid = normalizedPayMode === 'credit' ? 0 : totalsTotal
  const resolvedPaid = hasPaidInput ? parsedPaid : defaultPaid
  return Math.max(0, Number(resolvedPaid || 0))
}

function normalizePaymentModeForDb(value, fallback = 'cash') {
  const mode = String(value || '').trim().toLowerCase()
  if (!mode) return fallback
  if (mode === 'gpay') return 'upi'
  return mode
}

function getBillPrefix(shop, billType) {
  if (!shop) return 'OFF'
  return billType === 'quotation'
    ? (shop.quotation_prefix || 'QUO')
    : billType === 'estimate'
      ? (shop.estimate_prefix || 'EST')
      : (shop.bill_prefix || 'INV')
}

function isNetworkError(error) {
  const message = String(error?.message || '')
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('fetch') ||
    message.includes('offline')
  )
}

function normalizePhone(value) {
  return normalizeCustomerPhone(value)
}

function getAutoInvoiceCreditTag(billId) {
  return `${AUTO_INVOICE_CREDIT_TAG_PREFIX}${billId}]`
}

function extractAutoInvoiceIdFromReferenceNote(referenceNote) {
  const note = String(referenceNote || '')
  const start = note.indexOf(AUTO_INVOICE_CREDIT_TAG_PREFIX)
  if (start < 0) return ''
  const end = note.indexOf(']', start)
  if (end < 0) return ''
  return note.slice(start + AUTO_INVOICE_CREDIT_TAG_PREFIX.length, end).trim()
}

async function getLatestShopForPrint(shop) {
  if (!shop?.id || !navigator.onLine) return shop

  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .eq('id', shop.id)
    .single()
  if (error) throw error

  return { ...shop, ...data }
}

function isValidCreditPhone(value) {
  return /^[6-9]\d{9}$/.test(normalizePhone(value))
}

function matchesHistoryBillSearch(bill, searchTerm) {
  const term = String(searchTerm || '').trim().toLowerCase()
  if (!term) return true

  return [
    bill.bill_no,
    bill.customer_name,
    bill.customer_phone,
    bill.customer_gstin,
  ].some((value) => String(value || '').toLowerCase().includes(term))
}

async function removeAutoInvoiceCreditEntries(shopId, billId) {
  if (!shopId || !billId) return
  const tag = getAutoInvoiceCreditTag(billId)
  const { data: existingEntries, error: lookupErr } = await supabase
    .from('credit_entries')
    .select('id,account_id')
    .eq('shop_id', shopId)
    .ilike('reference_note', `%${tag}%`)
  if (lookupErr) throw lookupErr
  const touchedAccountIds = [...new Set((existingEntries || []).map((row) => row.account_id).filter(Boolean))]
  const entryIds = (existingEntries || []).map((row) => row.id).filter(Boolean)
  if (!entryIds.length) return

  const { error: deleteErr } = await supabase
    .from('credit_entries')
    .delete()
    .eq('shop_id', shopId)
    .in('id', entryIds)
  if (deleteErr) throw deleteErr

  if (touchedAccountIds.length === 0) return
  const { data: accountRows, error: accountErr } = await supabase
    .from('credit_accounts')
    .select('id,opening_balance,notes,relation_type')
    .eq('shop_id', shopId)
    .in('id', touchedAccountIds)
  if (accountErr) throw accountErr

  const removableAccountIds = []
  for (const account of (accountRows || [])) {
    if (account.relation_type !== 'borrower') continue
    if (String(account.notes || '') !== AUTO_INVOICE_CREDIT_NOTE) continue
    if (Number(account.opening_balance || 0) !== 0) continue

    const { data: remainingEntries, error: remainingErr } = await supabase
      .from('credit_entries')
      .select('id')
      .eq('shop_id', shopId)
      .eq('account_id', account.id)
      .limit(1)
    if (remainingErr) throw remainingErr
    if ((remainingEntries || []).length === 0) removableAccountIds.push(account.id)
  }

  if (!removableAccountIds.length) return
  const { error: removeAccountsErr } = await supabase
    .from('credit_accounts')
    .delete()
    .eq('shop_id', shopId)
    .in('id', removableAccountIds)
  if (removeAccountsErr) throw removeAccountsErr
}

async function findLinkedBorrowerAccountForBill(shopId, billId) {
  if (!shopId || !billId) return ''
  const tag = getAutoInvoiceCreditTag(billId)
  const { data, error } = await supabase
    .from('credit_entries')
    .select('account_id')
    .eq('shop_id', shopId)
    .eq('direction', 'increase')
    .ilike('reference_note', `%${tag}%`)
    .limit(1)
  if (error) throw error
  return data?.[0]?.account_id || ''
}

async function isSharedAutoInvoiceAccount(shopId, accountId, billId) {
  if (!shopId || !accountId) return false
  const { data, error } = await supabase
    .from('credit_entries')
    .select('reference_note')
    .eq('shop_id', shopId)
    .eq('account_id', accountId)
    .eq('direction', 'increase')
    .ilike('reference_note', `%${AUTO_INVOICE_CREDIT_TAG_PREFIX}%`)
  if (error) throw error

  const taggedBillIds = [...new Set((data || [])
    .map((entry) => extractAutoInvoiceIdFromReferenceNote(entry.reference_note))
    .filter(Boolean))]
  if (!billId) return taggedBillIds.length > 1
  return taggedBillIds.some((taggedBillId) => taggedBillId !== billId)
}

function isMissingOptionalBillSchemaError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    isMissingCustomerSchemaError(error) ||
    (message.includes('place_of_supply') && message.includes('could not find')) ||
    (message.includes('place_of_supply') && message.includes('does not exist')) ||
    (message.includes('reverse_charge') && message.includes('could not find')) ||
    (message.includes('reverse_charge') && message.includes('does not exist'))
  )
}

function withoutOptionalBillSchemaFields(payload) {
  const { customer_id, place_of_supply, reverse_charge, ...legacyPayload } = payload
  return legacyPayload
}

async function updateBillWithCustomerCompatibility(shopId, billId, payload) {
  const { error } = await supabase
    .from('bills')
    .update(payload)
    .eq('id', billId)
    .eq('shop_id', shopId)
  if (!error) return
  if (!isMissingOptionalBillSchemaError(error)) throw error

  const legacyPayload = withoutOptionalBillSchemaFields(payload)
  const { error: retryError } = await supabase
    .from('bills')
    .update(legacyPayload)
    .eq('id', billId)
    .eq('shop_id', shopId)
  if (retryError) throw retryError
}

async function insertBillWithCustomerCompatibility(payload) {
  const { data, error } = await supabase
    .from('bills')
    .insert(payload)
    .select()
    .single()
  if (!error) return data
  if (!isMissingOptionalBillSchemaError(error)) throw error

  const legacyPayload = withoutOptionalBillSchemaFields(payload)
  const { data: legacyData, error: legacyError } = await supabase
    .from('bills')
    .insert(legacyPayload)
    .select()
    .single()
  if (legacyError) throw legacyError
  return legacyData
}

async function reactivateBorrowerCreditAccount(shopId, accountId, options = {}) {
  if (!shopId || !accountId) return accountId
  const { customerId, customerName, customerPhone } = options
  const payload = { is_active: true }
  const normalizedName = String(customerName || '').trim()
  const normalizedPhone = normalizePhone(customerPhone)

  if (normalizedName) payload.party_name = normalizedName
  if (normalizedPhone) payload.phone = normalizedPhone
  if (isUuidLike(customerId)) payload.customer_id = customerId

  const { error } = await supabase
    .from('credit_accounts')
    .update(payload)
    .eq('shop_id', shopId)
    .eq('id', accountId)
  if (!error) return accountId
  if (!isMissingCustomerSchemaError(error)) throw error

  const { customer_id, ...legacyPayload } = payload
  const { error: retryError } = await supabase
    .from('credit_accounts')
    .update(legacyPayload)
    .eq('shop_id', shopId)
    .eq('id', accountId)
  if (retryError) throw retryError
  return accountId
}

async function createBorrowerCreditAccountWithCompatibility(payload) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .insert(payload)
    .select('id')
    .single()
  if (!error) return data
  if (!isMissingCustomerSchemaError(error)) throw error

  const { customer_id, ...legacyPayload } = payload
  const { data: legacyData, error: legacyError } = await supabase
    .from('credit_accounts')
    .insert(legacyPayload)
    .select('id')
    .single()
  if (legacyError) throw legacyError
  return legacyData
}

async function ensureBorrowerCreditAccount(shopId, customerName, customerPhone, billNo, options = {}) {
  const { billId, customerId } = options
  const normalizedName = String(customerName || '').trim()
  const normalizedPhone = normalizePhone(customerPhone)
  if (billId) {
    const linkedAccountId = await findLinkedBorrowerAccountForBill(shopId, billId)
    if (linkedAccountId) {
      const shouldAvoidSharedAccount = !normalizedPhone && await isSharedAutoInvoiceAccount(shopId, linkedAccountId, billId)
      if (!shouldAvoidSharedAccount) {
        return reactivateBorrowerCreditAccount(shopId, linkedAccountId, {
          customerId,
          customerName: normalizedName,
          customerPhone: normalizedPhone,
        })
      }
    }
  }

  if (isUuidLike(customerId)) {
    const { data: byCustomerId, error: byCustomerErr } = await supabase
      .from('credit_accounts')
      .select('id')
      .eq('shop_id', shopId)
      .eq('relation_type', 'borrower')
      .eq('customer_id', customerId)
      .limit(1)
    if (!String(byCustomerErr?.message || '').toLowerCase().includes('customer_id')) {
      if (byCustomerErr) throw byCustomerErr
      if (byCustomerId?.length) {
        return reactivateBorrowerCreditAccount(shopId, byCustomerId[0].id, {
          customerId,
          customerName: normalizedName,
          customerPhone: normalizedPhone,
        })
      }
    }
  }

  if (normalizedPhone) {
    const { data: byPhone, error: byPhoneErr } = await supabase
      .from('credit_accounts')
      .select('*')
      .eq('shop_id', shopId)
      .eq('relation_type', 'borrower')
      .eq('phone', normalizedPhone)
      .limit(1)
    if (byPhoneErr) throw byPhoneErr
    if (byPhone?.length) {
      return reactivateBorrowerCreditAccount(shopId, byPhone[0].id, {
        customerId,
        customerName: normalizedName,
        customerPhone: normalizedPhone,
      })
    }
  }

  const autoPartyName = normalizedName || (normalizedPhone ? `Customer ${normalizedPhone}` : `Walk-in (${billNo || 'Invoice'})`)
  const createdAccount = await createBorrowerCreditAccountWithCompatibility({
    shop_id: shopId,
    party_name: autoPartyName,
    phone: normalizedPhone || null,
    ...(isUuidLike(customerId) ? { customer_id: customerId } : {}),
    relation_type: 'borrower',
    settlement_cycle: 'daily',
    settlement_day: null,
    opening_balance: 0,
    notes: AUTO_INVOICE_CREDIT_NOTE,
    is_active: true,
  })
  return createdAccount.id
}

async function syncInvoiceCreditEntry({
  shopId,
  billId,
  billNo,
  billDate,
  customerId,
  customerName,
  customerPhone,
  payMode,
  paidAmount,
  totalAmount,
}) {
  if (!shopId || !billId) return

  await removeAutoInvoiceCreditEntries(shopId, billId)

  const total = Number(totalAmount || 0)
  const paid = Number(paidAmount || 0)
  const dueAmount = Math.max(0, total - paid)
  const normalizedPayMode = String(payMode || '').toLowerCase()
  const shouldTrack = dueAmount > 0 || normalizedPayMode === 'credit'
  if (!shouldTrack || dueAmount <= 0) return

  const accountId = await ensureBorrowerCreditAccount(shopId, customerName, customerPhone, billNo, { billId, customerId })
  const tag = getAutoInvoiceCreditTag(billId)
  const referenceNote = `Invoice ${billNo || ''} due ${fmt(dueAmount)} ${tag}`.trim()

  const { error: entryErr } = await supabase
    .from('credit_entries')
    .insert({
      shop_id: shopId,
      account_id: accountId,
      direction: 'increase',
      amount: dueAmount,
      entry_date: billDate,
      reference_note: referenceNote,
    })
  if (entryErr) throw entryErr
}

export default function BillingPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [items,       setItems]       = useState([emptyItem()])
  const [customer,    setCustomer]    = useState(emptyCustomer())
  const [billDate,    setBillDate]    = useState(todayStr())
  const [billNo,      setBillNo]      = useState('')
  const [billType,    setBillType]    = useState('invoice')
  const [payMode,     setPayMode]     = useState('Cash')
  const [paidAmt,     setPaidAmt]     = useState('')
  const [notes,       setNotes]       = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [reverseCharge, setReverseCharge] = useState(false)
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [customerPickerSearch, setCustomerPickerSearch] = useState('')
  const [customerDirectory, setCustomerDirectory] = useState([])
  const [customerDirectoryLoading, setCustomerDirectoryLoading] = useState(false)

  const [searchOpen,  setSearchOpen]  = useState(false)
  const [activeRow,   setActiveRow]   = useState(0)
  const [printData,   setPrintData]   = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [toast,       setToast]       = useState(null)
  const [mounted,     setMounted]     = useState(false)
  const [view,        setView]        = useState(
    searchParams.get('view') === 'history' ? 'history' : 'form'
  ) // 'form' | 'history'
  const [editBillId,   setEditBillId] = useState(null)
  const [historyBills, setHistoryBills] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [historyPaymentDrafts, setHistoryPaymentDrafts] = useState({})
  const [historySelectedBillIds, setHistorySelectedBillIds] = useState([])
  const [historyDeleting, setHistoryDeleting] = useState(false)
  const [historyUpdatingBillId, setHistoryUpdatingBillId] = useState(null)
  const [historyPrintingBillId, setHistoryPrintingBillId] = useState(null)
  const [conversionSource, setConversionSource] = useState(null)
  const [isOffline, setIsOffline] = useState(false)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const draftLoadedRef = useRef(false)
  const syncInProgressRef = useRef(false)
  const customerParamAppliedRef = useRef('')
  const debouncedCustomerPickerSearch = useDebouncedValue(customerPickerSearch, 200)
  const debouncedHistorySearch = useDebouncedValue(historySearch, 250)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const updateOnlineState = () => setIsOffline(typeof navigator !== 'undefined' ? !navigator.onLine : false)
    updateOnlineState()
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  const { shop } = useShop()
  const customerDirectoryCacheKey = shop?.id ? `customers-directory:${shop.id}` : ''

  // Default place of supply to the shop's own registered state (most common case)
  useEffect(() => {
    if (shop?.state && !placeOfSupply) setPlaceOfSupply(shop.state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop?.state])

  const setViewMode = useCallback((nextView) => {
    setView(nextView)
    const params = new URLSearchParams(searchParams.toString())
    if (nextView === 'history') {
      params.set('view', 'history')
    } else {
      params.delete('view')
    }
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const loadCustomerDirectory = useCallback(async ({ preferCache = true, silent = false } = {}) => {
    if (!shop?.id) {
      setCustomerDirectory([])
      setCustomerDirectoryLoading(false)
      return []
    }

    if (preferCache) {
      const cached = readPageCache(customerDirectoryCacheKey, 5 * 60 * 1000)
      if (cached?.customers) {
        setCustomerDirectory(cached.customers)
        setCustomerDirectoryLoading(false)
      } else {
        setCustomerDirectoryLoading(true)
      }
    } else {
      setCustomerDirectoryLoading(true)
    }

    try {
      const nextCustomers = await fetchCustomerDirectory(shop.id)
      setCustomerDirectory(nextCustomers)
      writePageCache(customerDirectoryCacheKey, { customers: nextCustomers })
      return nextCustomers
    } catch (error) {
      const fallback = readPageCache(customerDirectoryCacheKey, 5 * 60 * 1000)
      if (fallback?.customers) {
        setCustomerDirectory(fallback.customers)
        return fallback.customers
      }
      if (!silent) {
        showToast('Customer load failed: ' + (error?.message || 'Unknown error'), 'error')
      }
      return []
    } finally {
      setCustomerDirectoryLoading(false)
    }
  }, [customerDirectoryCacheKey, shop?.id])

  useEffect(() => {
    const requestedView = searchParams.get('view') === 'history' ? 'history' : 'form'
    setView((prevView) => (prevView === requestedView ? prevView : requestedView))
  }, [searchParams])

  useEffect(() => {
    loadCustomerDirectory({ preferCache: true, silent: true })
  }, [loadCustomerDirectory])

  useEffect(() => {
    if (!shop?.id || isOffline) return
    const channel = supabase.channel(`billing-live:${shop.id}`)
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'customers', filter: `shop_id=eq.${shop.id}` }, () => {
      loadCustomerDirectory({ preferCache: false, silent: true })
      setHistoryRefreshKey((current) => current + 1)
    })
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'bills', filter: `shop_id=eq.${shop.id}` }, () => {
      loadCustomerDirectory({ preferCache: false, silent: true })
      setHistoryRefreshKey((current) => current + 1)
    })
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'credit_accounts', filter: `shop_id=eq.${shop.id}` }, () => {
      loadCustomerDirectory({ preferCache: false, silent: true })
      if (view === 'history') setHistoryRefreshKey((current) => current + 1)
    })
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'credit_entries', filter: `shop_id=eq.${shop.id}` }, () => {
      if (view === 'history') setHistoryRefreshKey((current) => current + 1)
    })
    channel.subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [isOffline, loadCustomerDirectory, shop?.id, view])

  useEffect(() => {
    if (!shop?.id) return
    if (searchParams.get('editId') || searchParams.get('convertFrom')) {
      draftLoadedRef.current = true
      return
    }

    let cancelled = false
    async function restoreDraft() {
      try {
        const draft = await loadBillingDraft(shop.id)
        if (cancelled || !draft) return
        setItems(draft.items?.length ? draft.items : [emptyItem()])
        setCustomer({ ...emptyCustomer(), ...(draft.customer || {}) })
        setBillDate(draft.billDate || todayStr())
        setBillNo(draft.billNo || '')
        setBillType(draft.billType || 'invoice')
        setPayMode(draft.payMode || 'Cash')
        setPaidAmt(draft.paidAmt || '')
        setNotes(draft.notes || '')
        setPlaceOfSupply(draft.placeOfSupply || shop.state || '')
        setReverseCharge(!!draft.reverseCharge)
        setConversionSource(draft.conversionSource || null)
        showToast('Restored unsaved bill draft')
      } catch (error) {
        console.warn('Draft restore failed:', error)
      } finally {
        draftLoadedRef.current = true
      }
    }

    restoreDraft()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop?.id])

  useEffect(() => {
    if (!shop?.id || !draftLoadedRef.current) return
    saveBillingDraft(shop.id, {
      items,
      customer,
      billDate,
      billNo,
      billType,
      payMode,
      paidAmt,
      notes,
      placeOfSupply,
      reverseCharge,
      conversionSource,
    })
  }, [shop?.id, items, customer, billDate, billNo, billType, payMode, paidAmt, notes, placeOfSupply, reverseCharge, conversionSource])

  useEffect(() => {
    if (!shop?.id || !mounted) return

    let cancelled = false
    async function syncQueue() {
      if (!navigator.onLine || syncInProgressRef.current) return
      syncInProgressRef.current = true
      try {
        const queue = await listPendingBills(shop.id)
        for (const record of queue) {
          if (cancelled) return
          await updatePendingBill(record.id, { status: 'syncing' })

          const billRow = { ...record.billRow }
          const lineItems = record.lineItems || []
          if (!billRow.customer_id) {
            const ensuredCustomer = await ensureCustomerRecord(shop.id, {
              id: '',
              name: billRow.customer_name,
              phone: billRow.customer_phone,
              gstin: billRow.customer_gstin,
              address: billRow.customer_address,
            })
            if (ensuredCustomer?.id) {
              billRow.customer_id = ensuredCustomer.id
              billRow.customer_name = ensuredCustomer.name || billRow.customer_name
              billRow.customer_phone = ensuredCustomer.phone || billRow.customer_phone
              billRow.customer_gstin = ensuredCustomer.gstin || billRow.customer_gstin
              billRow.customer_address = ensuredCustomer.address || billRow.customer_address
            }
          }
          if (!billRow.bill_no || String(billRow.bill_no).startsWith('OFF-')) {
            const prefix = getBillPrefix(shop, billRow.bill_type)
            try {
              const { data: no, error: noErr } = await supabase.rpc('get_next_bill_no', {
                p_shop_id: shop.id,
                p_prefix: prefix,
              })
              if (noErr) throw noErr
              billRow.bill_no = no || makeTempBillNo(prefix)
            } catch {
              billRow.bill_no = billRow.bill_no || makeTempBillNo(prefix)
            }
          }

          const saved = await insertBillWithCustomerCompatibility(billRow)

          const syncedLineItems = lineItems.map((item, index) => ({
            shop_id: shop.id,
            bill_id: saved.id,
            product_id: item.product_id,
            sl_no: index + 1,
            product_name: item.product_name,
            hsn_code: item.hsn_code || null,
            unit: item.unit,
            quantity: parseFloat(item.quantity) || 1,
            mrp: item.mrp,
            cost_price: parseFloat(item.purchase_price) || 0,
            rate: parseFloat(item.rate) || 0,
            base_rate: (parseFloat(item.rate) || 0) / (1 + (item.gst_rate || 0) / 100),
            gst_rate: item.gst_rate || 0,
            gst_amount: item.gst_amount || 0,
            discount_pct: parseFloat(item.discount_pct) || 0,
            discount_amount: item.discount_amount || 0,
            total: item.total || 0,
          }))

          const { error: itemsErr } = await supabase.from('bill_items').insert(syncedLineItems)
          if (itemsErr) throw itemsErr

          if (billRow.bill_type === 'invoice') {
            await syncInvoiceCreditEntry({
              shopId: shop.id,
              billId: saved.id,
              billNo: billRow.bill_no,
              billDate: billRow.date,
              customerId: billRow.customer_id,
              customerName: billRow.customer_name,
              customerPhone: billRow.customer_phone,
              payMode: billRow.payment_mode,
              paidAmount: billRow.paid_amount,
              totalAmount: billRow.total,
            })
          } else {
            await removeAutoInvoiceCreditEntries(shop.id, saved.id)
          }

          if (record.conversionSourceId) {
            const { error: sourceItemsErr } = await supabase
              .from('bill_items')
              .delete()
              .eq('bill_id', record.conversionSourceId)
              .eq('shop_id', shop.id)
            if (sourceItemsErr) throw sourceItemsErr

            const { error: sourceBillErr } = await supabase
              .from('bills')
              .delete()
              .eq('id', record.conversionSourceId)
              .eq('shop_id', shop.id)
            if (sourceBillErr) throw sourceBillErr
          }

          await removePendingBill(record.id)
          await clearBillingDraft(shop.id)
        }
      } catch (error) {
        console.warn('Queue sync failed:', error)
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
  }, [mounted, shop?.id])

  // ── Load history when switching to history view ────────────────────────────
  useEffect(() => {
    if (view !== 'history' || !shop?.id) return
    setHistoryLoading(true)

    let cancelled = false
    async function loadHistoryBills() {
      let q = supabase
        .from('bills')
        .select('*')
        .eq('shop_id', shop.id)
        .eq('bill_type', billType)
        .order('created_at', { ascending: false })
        .limit(debouncedHistorySearch.trim() ? 200 : 50)

      const { data, error } = await q
      if (cancelled) return
      if (error) {
        showToast('History load failed: ' + error.message, 'error')
        setHistoryBills([])
        setHistorySelectedBillIds([])
        setHistoryLoading(false)
        return
      }

      const bills = data || []
      const customerIds = [...new Set(bills.map((bill) => bill.customer_id).filter(isUuidLike))]
      const preferredCustomerNameByBillId = new Map()
      const preferredCustomerPhoneByBillId = new Map()

      if (customerIds.length) {
        const { data: customerRows, error: customerErr } = await supabase
          .from('customers')
          .select('id,name,phone')
          .eq('shop_id', shop.id)
          .in('id', customerIds)
        if (cancelled) return
        if (!customerErr) {
          const customerById = new Map((customerRows || []).map((entry) => [entry.id, entry]))
          for (const bill of bills) {
            const matchedCustomer = customerById.get(bill.customer_id)
            if (!matchedCustomer) continue
            const nextName = String(matchedCustomer.name || '').trim()
            const nextPhone = normalizePhone(matchedCustomer.phone)
            if (nextName) preferredCustomerNameByBillId.set(bill.id, nextName)
            if (nextPhone) preferredCustomerPhoneByBillId.set(bill.id, nextPhone)
          }
        }
      }

      const missingCustomerBillIds = bills
        .filter((bill) => !preferredCustomerNameByBillId.get(bill.id) && !String(bill.customer_name || '').trim())
        .map((bill) => bill.id)

      if (!missingCustomerBillIds.length) {
        const enrichedBills = bills
          .map((bill) => ({
            ...bill,
            customer_name: preferredCustomerNameByBillId.get(bill.id) || bill.customer_name,
            customer_phone: preferredCustomerPhoneByBillId.get(bill.id) || bill.customer_phone,
          }))
          .filter((bill) => matchesHistoryBillSearch(bill, debouncedHistorySearch))
        setHistoryBills(enrichedBills)
        setHistorySelectedBillIds([])
        setHistoryLoading(false)
        return
      }

      const partyByBillId = new Map()
      for (const [billId, customerName] of preferredCustomerNameByBillId.entries()) {
        partyByBillId.set(billId, customerName)
      }

      const { data: creditRows, error: creditErr } = await supabase
        .from('credit_entries')
        .select('account_id,reference_note')
        .eq('shop_id', shop.id)
        .eq('direction', 'increase')
        .ilike('reference_note', `%${AUTO_INVOICE_CREDIT_TAG_PREFIX}%`)
      if (cancelled) return
      if (creditErr) {
        setHistoryBills(bills
          .map((bill) => ({
            ...bill,
            customer_name: preferredCustomerNameByBillId.get(bill.id) || partyByBillId.get(bill.id) || bill.customer_name,
            customer_phone: preferredCustomerPhoneByBillId.get(bill.id) || bill.customer_phone,
          }))
          .filter((bill) => matchesHistoryBillSearch(bill, debouncedHistorySearch)))
        setHistorySelectedBillIds([])
        setHistoryLoading(false)
        return
      }

      const missingSet = new Set(missingCustomerBillIds.filter((billId) => !partyByBillId.has(billId)))
      const accountIds = [...new Set((creditRows || [])
        .filter((row) => missingSet.has(extractAutoInvoiceIdFromReferenceNote(row.reference_note)))
        .map((row) => row.account_id)
        .filter(Boolean))]
      if (!accountIds.length) {
        setHistoryBills(bills
          .map((bill) => ({
            ...bill,
            customer_name: preferredCustomerNameByBillId.get(bill.id) || partyByBillId.get(bill.id) || bill.customer_name,
            customer_phone: preferredCustomerPhoneByBillId.get(bill.id) || bill.customer_phone,
          }))
          .filter((bill) => matchesHistoryBillSearch(bill, debouncedHistorySearch)))
        setHistorySelectedBillIds([])
        setHistoryLoading(false)
        return
      }

      const { data: accountRows, error: accountErr } = await supabase
        .from('credit_accounts')
        .select('id,party_name')
        .eq('shop_id', shop.id)
        .in('id', accountIds)
      if (cancelled) return
      if (accountErr) {
        setHistoryBills(bills
          .map((bill) => ({
            ...bill,
            customer_name: preferredCustomerNameByBillId.get(bill.id) || partyByBillId.get(bill.id) || bill.customer_name,
            customer_phone: preferredCustomerPhoneByBillId.get(bill.id) || bill.customer_phone,
          }))
          .filter((bill) => matchesHistoryBillSearch(bill, debouncedHistorySearch)))
        setHistorySelectedBillIds([])
        setHistoryLoading(false)
        return
      }

      const accountNameById = new Map((accountRows || []).map((account) => [account.id, account.party_name]))
      for (const row of (creditRows || [])) {
        const billId = extractAutoInvoiceIdFromReferenceNote(row.reference_note)
        if (!missingSet.has(billId)) continue
        const partyName = accountNameById.get(row.account_id)
        if (partyName && !partyByBillId.has(billId)) {
          partyByBillId.set(billId, partyName)
        }
      }

      const enrichedBills = bills
        .map((bill) => ({
          ...bill,
          customer_name: preferredCustomerNameByBillId.get(bill.id) || partyByBillId.get(bill.id) || bill.customer_name,
          customer_phone: preferredCustomerPhoneByBillId.get(bill.id) || bill.customer_phone,
        }))
        .filter((bill) => matchesHistoryBillSearch(bill, debouncedHistorySearch))
      setHistoryBills(enrichedBills)
      setHistorySelectedBillIds([])
      setHistoryLoading(false)
    }

    loadHistoryBills()
    return () => { cancelled = true }
  }, [view, billType, debouncedHistorySearch, historyRefreshKey, shop?.id])

  // ── Load existing bill into form when ?editId= is provided ───────────────────
  useEffect(() => {
    const id = searchParams.get('editId')
    if (!id || !shop?.id) return

    let cancelled = false
    async function loadForEdit() {
      const [{ data: b, error: bErr }, { data: lines, error: lErr }] = await Promise.all([
        supabase
          .from('bills')
          .select('*')
          .eq('id', id)
          .eq('shop_id', shop.id)
          .single(),
        supabase
          .from('bill_items')
          .select('id,product_id,product_name,hsn_code,unit,quantity,mrp,cost_price,rate,gst_rate,discount_pct,base_rate,gst_amount,discount_amount,total,sl_no')
          .eq('bill_id', id)
          .eq('shop_id', shop.id)
          .order('sl_no'),
      ])

      if (cancelled) return
      if (bErr) { showToast('Load failed: ' + bErr.message, 'error'); return }
      if (lErr) { showToast('Load failed: ' + lErr.message, 'error'); return }

      const productIds = [...new Set((lines || []).map((it) => it.product_id).filter(Boolean))]
      let productPricingMap = new Map()
      if (productIds.length > 0) {
        const { data: productRows, error: productErr } = await supabase
          .from('products')
          .select('id,purchase_price,stock_qty,min_stock')
          .eq('shop_id', shop.id)
          .in('id', productIds)

        if (cancelled) return
        if (productErr) { showToast('Load failed: ' + productErr.message, 'error'); return }
        productPricingMap = new Map((productRows || []).map((product) => [product.id, product]))
      }

      setEditBillId(id)
      setConversionSource(null)
      setViewMode('form')
      setBillType(b.bill_type || 'invoice')
      setConversionSource(null)
      setBillNo(b.bill_no || '')
      setBillDate(b.date || todayStr())
      setCustomer({
        id: b.customer_id || '',
        name: b.customer_name || '',
        phone: b.customer_phone || '',
        gstin: b.customer_gstin || '',
        address: b.customer_address || '',
      })
      setPayMode(b.payment_mode ? b.payment_mode.charAt(0).toUpperCase() + b.payment_mode.slice(1) : 'Cash')
      setPaidAmt(String(b.paid_amount ?? ''))
      setNotes(b.notes || '')
      setPlaceOfSupply(b.place_of_supply || shop?.state || '')
      setReverseCharge(!!b.reverse_charge)

      const loaded = (lines || []).map((it) => {
        const product = it.product_id ? productPricingMap.get(it.product_id) : null
        return {
          _id: uid(),
          product_id: it.product_id || null,
          product_name: it.product_name || '',
          hsn_code: it.hsn_code || '',
          unit: it.unit || 'pcs',
          quantity: it.quantity ?? 1,
          mrp: it.mrp ?? 0,
          purchase_price: it.cost_price ?? product?.purchase_price ?? '',
          rate: it.rate ?? 0,
          gst_rate: it.gst_rate ?? 0,
          discount_pct: it.discount_pct ?? 0,
          base_amount: (Number(it.total || 0) - Number(it.gst_amount || 0)),
          gst_amount: it.gst_amount ?? 0,
          discount_amount: it.discount_amount ?? 0,
          total: it.total ?? 0,
          stock_qty: product?.stock_qty,
          min_stock: product?.min_stock || 0,
        }
      })
      setItems(loaded.length ? loaded : [emptyItem()])
      setActiveRow(0)
    }

    loadForEdit()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, shop?.id])

  useEffect(() => {
    const id = searchParams.get('convertFrom')
    if (!id || !shop?.id) return

    let cancelled = false
    async function loadForConvert() {
      const [{ data: b, error: bErr }, { data: lines, error: lErr }] = await Promise.all([
        supabase
          .from('bills')
          .select('*')
          .eq('id', id)
          .eq('shop_id', shop.id)
          .single(),
        supabase
          .from('bill_items')
          .select('id,product_id,product_name,hsn_code,unit,quantity,mrp,cost_price,rate,gst_rate,discount_pct,base_rate,gst_amount,discount_amount,total,sl_no')
          .eq('bill_id', id)
          .eq('shop_id', shop.id)
          .order('sl_no'),
      ])

      if (cancelled) return
      if (bErr) { showToast('Load failed: ' + bErr.message, 'error'); return }
      if (lErr) { showToast('Load failed: ' + lErr.message, 'error'); return }
      if (b.bill_type === 'invoice') {
        showToast('Selected bill is already an invoice', 'error')
        return
      }

      setConversionSource({ id: b.id, billNo: b.bill_no })
      setEditBillId(null)
      setViewMode('form')
      setBillType('invoice')
      setBillNo('')
      setBillDate(todayStr())
      setCustomer({
        id: b.customer_id || '',
        name: b.customer_name || '',
        phone: b.customer_phone || '',
        gstin: b.customer_gstin || '',
        address: b.customer_address || '',
      })
      setPayMode('Cash')
      setPaidAmt('')
      setNotes(b.notes ? `${b.notes} | Converted from ${b.bill_no}` : `Converted from ${b.bill_no}`)

      const loaded = (lines || []).map((it) => ({
        _id: uid(),
        product_id: it.product_id || null,
        product_name: it.product_name || '',
        hsn_code: it.hsn_code || '',
        unit: it.unit || 'pcs',
        quantity: it.quantity ?? 1,
        mrp: it.mrp ?? 0,
        purchase_price: it.cost_price ?? '',
        rate: it.rate ?? 0,
        gst_rate: it.gst_rate ?? 0,
        discount_pct: it.discount_pct ?? 0,
        base_amount: (Number(it.total || 0) - Number(it.gst_amount || 0)),
        gst_amount: it.gst_amount ?? 0,
        discount_amount: it.discount_amount ?? 0,
        total: it.total ?? 0,
      }))
      setItems(loaded.length ? loaded : [emptyItem()])
      setActiveRow(0)
    }

    loadForConvert()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, shop?.id])

  // ── Pick up quotation redirect flag from sessionStorage ─────────────────
  useEffect(() => {
    const type = sessionStorage.getItem('defaultBillType')
    if (type) { setBillType(type); sessionStorage.removeItem('defaultBillType') }
  }, [])

  // ── Pick up a flagged Stock Check item to prefill (uninvoiced qty) ───────
  useEffect(() => {
    const raw = sessionStorage.getItem('prefillStockCheckItem')
    if (!raw) return
    sessionStorage.removeItem('prefillStockCheckItem')
    let prefill
    try { prefill = JSON.parse(raw) } catch { return }
    if (!prefill) return

    setBillType('invoice')
    const rate = prefill.selling_price || 0
    setItems(() => {
      const item = {
        ...emptyItem(),
        product_id:   prefill.product_id || null,
        product_name: prefill.product_name || '',
        hsn_code:     prefill.hsn_code || '',
        unit:         prefill.unit || 'pcs',
        mrp:          rate,
        rate,
        gst_rate:     prefill.gst_rate || 0,
        quantity:     prefill.quantity || 1,
      }
      return [recalc(item)]
    })
    showToast(`Prefilled ${prefill.product_name || 'item'} — verify rate/qty before saving`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Toast helper ──────────────────────────────────────────────────────────
  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  function applySelectedCustomer(selectedCustomer) {
    if (!selectedCustomer) return
    setCustomer({
      id: selectedCustomer.id || '',
      name: selectedCustomer.name || '',
      phone: selectedCustomer.phone || '',
      gstin: selectedCustomer.gstin || '',
      address: selectedCustomer.address || '',
    })
    setCustomerPickerOpen(false)
    setCustomerPickerSearch('')
    showToast(`Loaded ${selectedCustomer.name || selectedCustomer.phone || 'customer details'}`)
  }

  useEffect(() => {
    const requestedCustomerId = searchParams.get('customer')
    if (!requestedCustomerId || customerDirectoryLoading) return
    if (customerParamAppliedRef.current === requestedCustomerId) return

    const selectedCustomer = customerDirectory.find((entry) => entry.id === requestedCustomerId)
    customerParamAppliedRef.current = requestedCustomerId

    const params = new URLSearchParams(searchParams.toString())
    params.delete('customer')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })

    if (!selectedCustomer) {
      showToast('Selected customer could not be loaded', 'error')
      return
    }

    setViewMode('form')
    setCustomer({
      id: selectedCustomer.id || '',
      name: selectedCustomer.name || '',
      phone: selectedCustomer.phone || '',
      gstin: selectedCustomer.gstin || '',
      address: selectedCustomer.address || '',
    })
    showToast(`Loaded ${selectedCustomer.name || selectedCustomer.phone || 'customer details'}`)
  }, [customerDirectory, customerDirectoryLoading, pathname, router, searchParams, setViewMode])

  // ── Item calculation — runs for any item that has rate set ─────────────────
  function recalc(item) {
    if (!parseFloat(item.rate) && !parseFloat(item.quantity)) return item
    const c = calcItem(
      parseFloat(item.rate)         || 0,
      parseFloat(item.quantity)     || 0,
      parseFloat(item.gst_rate)     || 0,
      parseFloat(item.discount_pct) || 0,
    )
    return { ...item, ...c }
  }

  function updateItem(index, field, value) {
    setItems(prev => {
      const next = [...prev]
      next[index] = recalc({ ...next[index], [field]: value })
      return next
    })
  }

  // ── Derived totals ─────────────────────────────────────────────────────────
  // Include free-text items (no product_id) that have a name and rate entered
  const filledItems = items.filter(i => i.product_id || (i.product_name && parseFloat(i.rate) > 0))
  const totals      = calcBillTotals(filledItems)
  const profitSummary = getBillProfitSummary(filledItems)
  const filteredCustomerDirectory = useMemo(
    () => customerDirectory.filter((entry) => matchesCustomerSearch(entry, debouncedCustomerPickerSearch)),
    [customerDirectory, debouncedCustomerPickerSearch]
  )

  function handlePayModeChange(nextPayMode) {
    setPayMode(nextPayMode)
    const isCreditMode = String(nextPayMode || '').toLowerCase() === 'credit'
    if (!isCreditMode) return

    const currentPaid = parseFloat(paidAmt)
    const hasPaidInput = paidAmt !== '' && Number.isFinite(currentPaid)
    if (!hasPaidInput || currentPaid >= totals.total) {
      setPaidAmt('0')
    }
  }

  async function handleHistoryPaymentModeUpdate(bill, nextMode) {
    if (!shop?.id || !bill?.id || !nextMode) return
    const normalizedMode = normalizePaymentModeForDb(nextMode)

    setHistoryUpdatingBillId(bill.id)
    try {
      const total = Number(bill.total || 0)
      const currentPaid = Number(bill.paid_amount || 0)
      const currentMode = normalizePaymentModeForDb(bill.payment_mode)
      const isCreditMode = normalizedMode === 'credit'
      const shouldForceCreditReset = isCreditMode && currentPaid > 0
      const shouldRepairCreditSync = isCreditMode && Math.max(0, total - currentPaid) > 0
      if (currentMode === normalizedMode && !shouldForceCreditReset && !shouldRepairCreditSync) return

      if (isCreditMode && !isValidCreditPhone(bill.customer_phone)) {
        showToast('Valid 10-digit customer phone is required for credit invoices', 'error')
        return
      }

      const nextPaid = isCreditMode ? 0 : currentPaid
      const nextStatus = nextPaid >= total ? 'paid' : nextPaid > 0 ? 'partial' : 'unpaid'
      let nextCustomerId = isUuidLike(bill.customer_id) ? bill.customer_id : ''
      let nextCustomerName = String(bill.customer_name || '').trim() || null
      let nextCustomerPhone = normalizePhone(bill.customer_phone)

      if (isCreditMode && !nextCustomerName) {
        const accountId = await ensureBorrowerCreditAccount(shop.id, '', bill.customer_phone, bill.bill_no, {
          billId: bill.id,
          customerId: nextCustomerId,
        })
        const { data: accountRow, error: accountErr } = await supabase
          .from('credit_accounts')
          .select('party_name,phone')
          .eq('shop_id', shop.id)
          .eq('id', accountId)
          .single()
        if (accountErr) throw accountErr
        nextCustomerName = String(accountRow?.party_name || '').trim() || nextCustomerName
        nextCustomerPhone = normalizePhone(accountRow?.phone) || nextCustomerPhone
      }

      const ensuredCustomer = await ensureCustomerRecord(shop.id, {
        id: nextCustomerId,
        name: nextCustomerName || '',
        phone: nextCustomerPhone || '',
        gstin: bill.customer_gstin || '',
        address: bill.customer_address || '',
      })
      if (ensuredCustomer?.id) {
        nextCustomerId = ensuredCustomer.id
        nextCustomerName = ensuredCustomer.name || nextCustomerName
        nextCustomerPhone = ensuredCustomer.phone || nextCustomerPhone
      }

      await updateBillWithCustomerCompatibility(shop.id, bill.id, {
        customer_id: nextCustomerId || null,
        payment_mode: normalizedMode,
        paid_amount: nextPaid,
        payment_status: nextStatus,
        customer_name: nextCustomerName,
        customer_phone: nextCustomerPhone || null,
      })

      await syncInvoiceCreditEntry({
        shopId: shop.id,
        billId: bill.id,
        billNo: bill.bill_no,
        billDate: bill.date,
        customerId: nextCustomerId,
        customerName: nextCustomerName,
        customerPhone: nextCustomerPhone,
        payMode: normalizedMode,
        paidAmount: nextPaid,
        totalAmount: total,
      })

      setHistoryBills((prevBills) => prevBills.map((row) => (
        row.id === bill.id
          ? {
            ...row,
            payment_mode: normalizedMode,
            paid_amount: nextPaid,
            payment_status: nextStatus,
            customer_id: nextCustomerId || row.customer_id,
            customer_name: nextCustomerName || row.customer_name,
            customer_phone: nextCustomerPhone || row.customer_phone,
          }
          : row
      )))
      showToast(`Payment mode updated for ${bill.bill_no}`)
    } catch (error) {
      showToast('Payment mode update failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setHistoryUpdatingBillId(null)
    }
  }

  function getHistoryDueAmount(bill) {
    return Math.max(0, Number(bill.total || 0) - Number(bill.paid_amount || 0))
  }

  async function handleHistoryRecordPayment(bill) {
    if (!shop?.id || !bill?.id) return
    const dueAmount = getHistoryDueAmount(bill)
    if (dueAmount <= 0) return

    const draftValue = historyPaymentDrafts[bill.id] ?? ''
    const amountToAdd = Number(draftValue)
    if (!Number.isFinite(amountToAdd) || amountToAdd <= 0) {
      showToast('Enter a valid amount greater than 0', 'error')
      return
    }

    const total = Number(bill.total || 0)
    const currentPaid = Number(bill.paid_amount || 0)
    const nextPaid = Math.min(total, currentPaid + amountToAdd)
    const nextMode = normalizePaymentModeForDb(bill.payment_mode || 'cash')
    const nextStatus = nextPaid >= total ? 'paid' : nextPaid > 0 ? 'partial' : 'unpaid'

    setHistoryUpdatingBillId(bill.id)
    try {
      const { error } = await supabase
        .from('bills')
        .update({
          paid_amount: nextPaid,
          payment_mode: nextMode,
          payment_status: nextStatus,
        })
        .eq('id', bill.id)
        .eq('shop_id', shop.id)

      if (error) throw error

      await syncInvoiceCreditEntry({
        shopId: shop.id,
        billId: bill.id,
        billNo: bill.bill_no,
        billDate: bill.date,
        customerId: bill.customer_id,
        customerName: bill.customer_name,
        customerPhone: bill.customer_phone,
        payMode: nextMode,
        paidAmount: nextPaid,
        totalAmount: total,
      })

      setHistoryBills((prevBills) => prevBills.map((row) => (
        row.id === bill.id
          ? { ...row, paid_amount: nextPaid, payment_mode: nextMode, payment_status: nextStatus }
          : row
      )))
      setHistoryPaymentDrafts((prevDrafts) => ({ ...prevDrafts, [bill.id]: '' }))
      showToast(`Payment recorded for ${bill.bill_no}`)
    } catch (error) {
      showToast('Payment update failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setHistoryUpdatingBillId(null)
    }
  }

  function handleToggleHistoryBillSelection(billId, checked) {
    setHistorySelectedBillIds((prevIds) => {
      if (checked) {
        return prevIds.includes(billId) ? prevIds : [...prevIds, billId]
      }
      return prevIds.filter((id) => id !== billId)
    })
  }

  function handleToggleSelectAllHistoryBills(checked) {
    if (!checked) {
      setHistorySelectedBillIds([])
      return
    }
    setHistorySelectedBillIds(historyBills.map((bill) => bill.id))
  }

  function handleMoveSelectedHistoryBillsToNumberUpdater() {
    if (!shop?.id) return
    if (!historySelectedBillIds.length) {
      showToast('Select invoices to update numbering', 'error')
      return
    }

    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(
        `invoice-number-updater:${shop.id}`,
        JSON.stringify({
          billType,
          billIds: historySelectedBillIds,
          selectedAt: Date.now(),
        })
      )
    }

    router.push('/billing/invoice-number-updater')
  }

  function getHistoryExportBills() {
    if (historySelectedBillIds.length === 0) return historyBills
    const selectedIds = new Set(historySelectedBillIds)
    return historyBills.filter((bill) => selectedIds.has(bill.id))
  }

  function handleExportHistoryCsv() {
    const exportBills = getHistoryExportBills()
    const rows = exportBills.map((bill) => ({
      Date: formatDate(bill.date),
      'Bill No': bill.bill_no,
      Type: bill.bill_type || '',
      Customer: bill.customer_name || '',
      Phone: bill.customer_phone || '',
      GSTIN: bill.customer_gstin || '',
      'Taxable Value': Number(bill.subtotal || 0),
      CGST: Number(bill.cgst_amount || 0),
      SGST: Number(bill.sgst_amount || 0),
      IGST: Number(bill.igst_amount || 0),
      GST: Number(bill.gst_amount || 0),
      Discount: Number(bill.discount_amount || 0),
      Total: Number(bill.total || 0),
      Paid: Number(bill.paid_amount || 0),
      Due: getHistoryDueAmount(bill),
      'Payment Mode': bill.payment_mode || '',
      Status: bill.payment_status || '',
      Notes: bill.notes || '',
    }))
    downloadCsv(`${billType}-export.csv`, Object.keys(rows[0] || {
      Date: '', 'Bill No': '', Type: '', Customer: '', Phone: '', GSTIN: '', 'Taxable Value': '', CGST: '', SGST: '', IGST: '', GST: '', Discount: '', Total: '', Paid: '', Due: '', 'Payment Mode': '', Status: '', Notes: '',
    }), rows)
  }

  function getHistoryInvoicePackHref() {
    const invoiceIds = getHistoryExportBills()
      .filter((bill) => bill.bill_type === 'invoice')
      .map((bill) => bill.id)

    return invoiceIds.length > 0
      ? `/reports/invoice-pack?ids=${encodeURIComponent(invoiceIds.join(','))}`
      : '/reports/invoice-pack'
  }

  async function handleHistoryPrint(bill) {
    if (!shop?.id || !bill?.id) return

    setHistoryPrintingBillId(bill.id)
    try {
      const { data: lineItems, error: itemsErr } = await supabase
        .from('bill_items')
        .select('id,sl_no,product_name,hsn_code,quantity,unit,mrp,rate,gst_rate,gst_amount,total')
        .eq('bill_id', bill.id)
        .eq('shop_id', shop.id)
        .order('sl_no')
      if (itemsErr) throw itemsErr

      const gstBreakdown = {}
      for (const item of (lineItems || [])) {
        const rate = String(item.gst_rate || 0)
        if (!gstBreakdown[rate]) gstBreakdown[rate] = { base: 0, gst: 0 }
        gstBreakdown[rate].base += Number(item.total || 0) - Number(item.gst_amount || 0)
        gstBreakdown[rate].gst += Number(item.gst_amount || 0)
      }

      const printShop = await getLatestShopForPrint(shop)
      window.addEventListener('afterprint', () => setPrintData(null), { once: true })
      printWithContent(() => setPrintData({
        bill,
        items: lineItems || [],
        shop: printShop,
        totals: {
          subtotal: Number(bill.subtotal || 0),
          gstAmount: Number(bill.gst_amount || 0),
          discountAmount: Number(bill.discount_amount || 0),
          total: Number(bill.total || 0),
          gstBreakdown,
        },
      }))
    } catch (error) {
      showToast('Print failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setHistoryPrintingBillId(null)
    }
  }

  async function handleDeleteSelectedHistoryBills() {
    if (!shop?.id) return
    if (!historySelectedBillIds.length) {
      showToast('Select at least one invoice to delete', 'error')
      return
    }
    const selectedCount = historySelectedBillIds.length
    if (!window.confirm(`Delete ${selectedCount} selected invoice${selectedCount > 1 ? 's' : ''}? This cannot be undone.`)) return

    setHistoryDeleting(true)
    try {
      for (const billId of historySelectedBillIds) {
        await removeAutoInvoiceCreditEntries(shop.id, billId)
      }

      const { error: deleteErr } = await supabase
        .from('bills')
        .delete()
        .eq('shop_id', shop.id)
        .in('id', historySelectedBillIds)
      if (deleteErr) throw deleteErr

      const selectedSet = new Set(historySelectedBillIds)
      setHistoryBills((prevBills) => prevBills.filter((bill) => !selectedSet.has(bill.id)))
      setHistoryPaymentDrafts((prevDrafts) => {
        const nextDrafts = { ...prevDrafts }
        for (const billId of historySelectedBillIds) {
          delete nextDrafts[billId]
        }
        return nextDrafts
      })
      setHistorySelectedBillIds([])
      showToast(`Deleted ${selectedCount} invoice${selectedCount > 1 ? 's' : ''}`)
    } catch (error) {
      showToast('Delete failed: ' + (error?.message || 'Unknown error'), 'error')
    } finally {
      setHistoryDeleting(false)
    }
  }

  // ── Open search for a row ──────────────────────────────────────────────────
  const openSearch = useCallback((rowIdx) => {
    setActiveRow(rowIdx)
    setSearchOpen(true)
  }, [])

  // ── Product selected from modal ───────────────────────────────────────────
  function handleProductSelect(product) {
    const rate = product.selling_price || product.mrp || 0
    setItems(prev => {
      const next = [...prev]
      const item = {
        ...next[activeRow],
        product_id:   product.id,
        product_name: getBillProductName(product),
        hsn_code:     product.hsn_code || '',
        unit:         product.unit     || 'pcs',
        mrp:          product.mrp      || rate,
        purchase_price: product.purchase_price || 0,
        rate,
        gst_rate:     product.gst_rate || 0,
        quantity:     1,
        discount_pct: '',
        stock_qty:    product.stock_qty,
        min_stock:    product.min_stock || 0,
      }
      next[activeRow] = recalc(item)
      return next
    })
    setSearchOpen(false)
    focusId(`qty-${activeRow}`)
  }

  // ── Free-text item (not in inventory) ────────────────────────────────────
  function handleFreeTextItem(name) {
    setItems(prev => {
      const next = [...prev]
      next[activeRow] = {
        ...next[activeRow],
        product_id:   null,
        product_name: name,
        unit:         'pcs',
        quantity:     1,
        purchase_price: '',
        rate:         '',
        gst_rate:     0,
        base_amount:  0,
        gst_amount:   0,
        discount_amount: 0,
        total:        0,
      }
      return next
    })
    setSearchOpen(false)
    focusId(`rate-${activeRow}`)  // focus rate — user must enter price manually
  }

  // ── Row actions ────────────────────────────────────────────────────────────
  function addRow() {
    const idx = items.length
    setItems(prev => [...prev, emptyItem()])
    setActiveRow(idx)
    setTimeout(() => openSearch(idx), 60)
  }

  function deleteRow(index) {
    if (items.length === 1) { setItems([emptyItem()]); return }
    setItems(prev => prev.filter((_, i) => i !== index))
    setActiveRow(Math.max(0, index - 1))
  }

  function resetBillForm() {
    setEditBillId(null)
    setItems([emptyItem()])
    setCustomer(emptyCustomer())
    setCustomerPickerOpen(false)
    setCustomerPickerSearch('')
    setBillDate(todayStr())
    setBillNo('')
    setPaidAmt('')
    setNotes('')
    setPlaceOfSupply(shop?.state || '')
    setReverseCharge(false)
    setActiveRow(0)
    setPrintData(null)
    setSearchOpen(false)
    setConversionSource(null)
  }

  // ── New bill ───────────────────────────────────────────────────────────────
  function handleNewBill() {
    if (filledItems.length > 0 && !window.confirm('Clear current bill and start new?')) return
    resetBillForm()
    setTimeout(() => openSearch(0), 60)
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSave(withPrint = false) {
    if (filledItems.length === 0) { showToast('Add at least one item', 'error'); return }

    // ── Guard against selling more than what's currently in stock ──────────
    // Only applies to actual GST invoices — a Quotation/Estimate is just a
    // proposal to the customer and shouldn't require stock to be on hand yet.
    // Skipped when editing an existing bill, since the loaded stock_qty there
    // already reflects this bill's own original quantity being subtracted.
    if (billType === 'invoice' && !editBillId) {
      const qtyByProduct = {}
      const stockByProduct = {}
      const nameByProduct = {}
      filledItems.forEach((item) => {
        if (!item.product_id) return
        const qty = parseFloat(item.quantity) || 0
        qtyByProduct[item.product_id] = (qtyByProduct[item.product_id] || 0) + qty
        if (typeof item.stock_qty === 'number') stockByProduct[item.product_id] = item.stock_qty
        nameByProduct[item.product_id] = item.product_name || nameByProduct[item.product_id]
      })
      const shortages = Object.keys(qtyByProduct)
        .filter((pid) => stockByProduct[pid] !== undefined && qtyByProduct[pid] > stockByProduct[pid])
        .map((pid) => `${nameByProduct[pid] || 'item'} (need ${qtyByProduct[pid]}, have ${stockByProduct[pid]})`)
      if (shortages.length > 0) {
        showToast(`Insufficient stock — ${shortages.join('; ')}`, 'error')
        return
      }
    }

    const isCreditMode = String(payMode || '').toLowerCase() === 'credit'
    if (isCreditMode && !String(customer.name || '').trim()) {
      showToast('Customer name is required for credit bills', 'error')
      focusId('customer-name')
      return
    }
    if (isCreditMode && !isValidCreditPhone(customer.phone)) {
      showToast('Valid 10-digit customer phone is required for credit bills', 'error')
      focusId('customer-phone')
      return
    }
    setSaving(true)

    try {
      // Generate bill number with type-appropriate prefix
      let finalNo = billNo.trim()
      if (!finalNo) {
        if (!shop?.id) throw new Error('Shop not loaded. Please refresh.')
        const prefix =
          billType === 'quotation' ? (shop.quotation_prefix || 'QUO')
          : billType === 'estimate' ? (shop.estimate_prefix || 'EST')
          : (shop.bill_prefix || 'INV')
        const { data: no } = await supabase.rpc('get_next_bill_no', {
          p_shop_id: shop.id,
          p_prefix:  prefix,
        })
        finalNo = no || `${prefix}-${Date.now()}`
        setBillNo(finalNo)
      } else if (!navigator.onLine) {
        setBillNo(finalNo || makeTempBillNo(getBillPrefix(shop, billType)))
      }

      const paid = normalizePaidAmount(paidAmt, totals.total, payMode)
      const ensuredCustomer = navigator.onLine
        ? await ensureCustomerRecord(shop.id, customer)
        : null
      const resolvedCustomer = ensuredCustomer
        ? {
            id: ensuredCustomer.id || '',
            name: ensuredCustomer.name || customer.name || '',
            phone: ensuredCustomer.phone || customer.phone || '',
            gstin: ensuredCustomer.gstin || customer.gstin || '',
            address: ensuredCustomer.address || customer.address || '',
          }
        : customer

      const billRow = {
        shop_id:          shop.id,
        bill_no:          finalNo,
        bill_type:        billType,
        date:             billDate,
        customer_id:      isUuidLike(resolvedCustomer.id) ? resolvedCustomer.id : null,
        customer_name:    resolvedCustomer.name    || null,
        customer_phone:   resolvedCustomer.phone   || null,
        customer_gstin:   resolvedCustomer.gstin   || null,
        customer_address: resolvedCustomer.address || null,
        subtotal:         totals.subtotal,
        cgst_amount:      totals.gstAmount / 2,
        sgst_amount:      totals.gstAmount / 2,
        gst_amount:       totals.gstAmount,
        discount_amount:  totals.discountAmount,
        total:            totals.total,
        paid_amount:      paid,
        payment_mode:     normalizePaymentModeForDb(payMode),
        payment_status:   paid >= totals.total ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
        notes:            notes || null,
        place_of_supply:  placeOfSupply || shop.state || null,
        reverse_charge:   reverseCharge,
      }

      const lineItems = filledItems.map((item, i) => ({
        shop_id:         shop.id,
        product_id:      item.product_id,
        sl_no:           i + 1,
        product_name:    item.product_name,
        hsn_code:        item.hsn_code || null,
        unit:            item.unit,
        quantity:        parseFloat(item.quantity)     || 1,
        mrp:             item.mrp,
        cost_price:      parseFloat(item.purchase_price) || 0,
        rate:            parseFloat(item.rate)         || 0,
        base_rate:       (parseFloat(item.rate) || 0) / (1 + (item.gst_rate || 0) / 100),
        gst_rate:        item.gst_rate     || 0,
        gst_amount:      item.gst_amount   || 0,
        discount_pct:    parseFloat(item.discount_pct) || 0,
        discount_amount: item.discount_amount || 0,
        total:           item.total        || 0,
      }))

      const isOfflineSave = !navigator.onLine
      if (isOfflineSave) {
        if (editBillId) {
          throw new Error('Editing bills offline is not available yet')
        }

        const queuedBill = await enqueuePendingBill(shop.id, {
          billRow,
          lineItems,
          conversionSourceId: conversionSource?.id || null,
        })

        await applyLocalStockDelta(shop.id, lineItems)
        await clearBillingDraft(shop.id)

        showToast(`✓ ${finalNo} saved offline. It will sync when internet returns.`)

        if (withPrint) {
          const clearAfterPrint = () => {
            setPrintData(null)
            resetBillForm()
          }
          window.addEventListener('afterprint', clearAfterPrint, { once: true })
          const printShop = await getLatestShopForPrint(shop)
          setPrintData({ bill: { ...billRow, id: queuedBill.id }, items: filledItems, shop: printShop, totals })
          setTimeout(() => window.print(), 200)
        } else {
          resetBillForm()
        }
        return
      }

      let savedId = editBillId
      if (editBillId) {
        await updateBillWithCustomerCompatibility(shop.id, editBillId, billRow)
      } else {
        const saved = await insertBillWithCustomerCompatibility(billRow)
        savedId = saved.id
      }

      if (editBillId) {
        const { error: delErr } = await supabase
          .from('bill_items')
          .delete()
          .eq('bill_id', editBillId)
          .eq('shop_id', shop.id)
        if (delErr) throw delErr
      }

      const savedLineItems = lineItems.map((item) => ({ ...item, bill_id: savedId }))
      const { error: itemErr } = await supabase.from('bill_items').insert(savedLineItems)
      if (itemErr) throw itemErr

      if (billType === 'invoice') {
        await syncInvoiceCreditEntry({
          shopId: shop.id,
          billId: savedId,
          billNo: finalNo,
          billDate,
          customerId: billRow.customer_id,
          customerName: billRow.customer_name,
          customerPhone: billRow.customer_phone,
          payMode,
          paidAmount: paid,
          totalAmount: totals.total,
        })
      } else {
        await removeAutoInvoiceCreditEntries(shop.id, savedId)
      }

      if (conversionSource?.id && billType === 'invoice') {
        const { error: sourceItemsErr } = await supabase
          .from('bill_items')
          .delete()
          .eq('bill_id', conversionSource.id)
          .eq('shop_id', shop.id)
        if (sourceItemsErr) throw sourceItemsErr

        const { error: sourceBillErr } = await supabase
          .from('bills')
          .delete()
          .eq('id', conversionSource.id)
          .eq('shop_id', shop.id)
        if (sourceBillErr) throw sourceBillErr
      }

      showToast(editBillId ? `✓ ${finalNo} updated` : `✓ ${finalNo} saved`)
      await clearBillingDraft(shop.id)
      loadCustomerDirectory({ preferCache: false, silent: true })

      if (withPrint) {
        const clearAfterPrint = () => {
          setPrintData(null)
          resetBillForm()
        }
        window.addEventListener('afterprint', clearAfterPrint, { once: true })
        const printShop = await getLatestShopForPrint(shop)
        printWithContent(() => setPrintData({ bill: { ...billRow, id: savedId }, items: filledItems, shop: printShop, totals }))
      } else {
        resetBillForm()
      }
    } catch (err) {
      console.error(err)
      showToast('Save failed: ' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (customerPickerOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setCustomerPickerOpen(false)
        }
        return
      }
      if (searchOpen) return

      switch (e.key) {
        case 'F2':  e.preventDefault(); handleNewBill();        break
        case 'F3':  e.preventDefault(); openSearch(activeRow);  break
        case 'F4':  e.preventDefault(); addRow();               break
        case 'F8':  e.preventDefault(); handleSave(true);       break
        case 'F9':  e.preventDefault(); handleSave(false);      break
        case '/':
          if (!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) {
            e.preventDefault()
            openSearch(activeRow)
          }
          break
        default:
          if (e.ctrlKey && e.key.toLowerCase() === 'd') {
            e.preventDefault()
            deleteRow(activeRow)
          }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerPickerOpen, searchOpen, activeRow])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* PrintTemplate portaled to document.body — escapes the no-print parent */}
      {printData && mounted && createPortal(
        <PrintTemplate data={printData} />,
        document.body
      )}

      {/* Product search modal */}
      {searchOpen && (
        <ProductSearch
          onSelect={handleProductSelect}
          onAddFreeText={handleFreeTextItem}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {customerPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-3">
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <div className="text-base font-semibold text-gray-900">Select Customer</div>
                <div className="text-xs text-gray-500">Saved automatically from bills and credit book</div>
              </div>
              <button
                type="button"
                onClick={() => setCustomerPickerOpen(false)}
                className="rounded border px-3 py-1 text-sm text-gray-600 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
            <div className="border-b px-4 py-3">
              <input
                autoFocus
                value={customerPickerSearch}
                onChange={(event) => setCustomerPickerSearch(event.target.value)}
                placeholder="Search by name, phone, GSTIN, invoice no..."
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div className="max-h-[26rem] overflow-y-auto">
              {customerDirectoryLoading ? (
                <div className="px-4 py-8 text-center text-sm text-gray-500">Loading customers...</div>
              ) : filteredCustomerDirectory.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-gray-500">No matching customers found.</div>
              ) : (
                filteredCustomerDirectory.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => applySelectedCustomer(entry)}
                    className="flex w-full items-start justify-between gap-3 border-b px-4 py-3 text-left hover:bg-gray-50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900">{entry.name || entry.phone || 'Unnamed customer'}</div>
                      <div className="text-xs text-gray-500">
                        {entry.phone || 'No phone'}{entry.gstin ? ` • ${entry.gstin}` : ''}{entry.lastBillNo ? ` • ${entry.lastBillNo}` : ''}
                      </div>
                      {entry.address && <div className="mt-1 text-xs text-gray-400 truncate">{entry.address}</div>}
                    </div>
                    <div className="text-right text-xs text-gray-500">
                      <div>{entry.billCount} bill{entry.billCount === 1 ? '' : 's'}</div>
                      {entry.totalOutstanding > 0 && <div className="font-medium text-cyan-700">{fmt(entry.totalOutstanding)} due</div>}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className={`fixed top-4 left-4 right-4 z-50 px-4 py-2 rounded-lg shadow-lg text-white text-sm font-medium no-print sm:left-auto sm:max-w-sm ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* On mobile the fixed 3-pane column collapsed the items area to a few
          pixels, so below md the page flows in one natural scroll instead. */}
      <div className="flex flex-col min-h-full md:h-full no-print">

        {/* ── Top bar ─────────────────────────────────────────────────── */}
        <div className="bg-white border-b px-4 py-2 flex flex-wrap items-center gap-2 sm:gap-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <select
              value={billType}
              onChange={e => { setBillType(e.target.value); setViewMode('form') }}
              className="border rounded px-2 py-1 text-sm font-semibold"
            >
              <option value="invoice">Tax Invoice</option>
              <option value="quotation">Quotation</option>
              <option value="estimate">Estimate</option>
            </select>
          </div>

          {/* New / History tabs */}
          <div className="flex gap-1">
            <button
              onClick={() => setViewMode('form')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${view === 'form' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >New</button>
            <button
              onClick={() => setViewMode('history')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${view === 'history' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >History</button>
          </div>

          {view === 'form' && (
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:ml-auto text-sm">
              {editBillId && (
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-medium">
                  Editing Existing Bill
                </span>
              )}
              <label className="text-gray-500">Bill No</label>
              <input
                value={billNo}
                onChange={e => setBillNo(e.target.value)}
                placeholder="Auto"
                className="border rounded px-2 py-1 w-28 font-mono text-sm"
              />
              <label className="text-gray-500 sm:ml-2">Date</label>
              <input
                type="date"
                value={billDate}
                onChange={e => setBillDate(e.target.value)}
                className="border rounded px-2 py-1 text-sm"
              />
            </div>
          )}
        </div>

        {/* ── Shortcut strip (desktop only) ──────────────────────────── */}
        {view === 'form' && (
        <div className="shortcuts-bar bg-blue-700 text-white text-xs px-4 py-1 flex flex-wrap gap-4 flex-shrink-0 no-print">
          <span><kbd>F2</kbd> New</span>
          <span><kbd>F3</kbd> or <kbd>/</kbd> Search product</span>
          <span><kbd>F4</kbd> Add row</span>
          <span><kbd>F8</kbd> Save+Print</span>
          <span><kbd>F9</kbd> Save</span>
          <span><kbd>Ctrl+D</kbd> Delete row</span>
          <span><kbd>↑↓ Enter</kbd> Pick item in search</span>
        </div>
        )}

        {view === 'form' && isOffline && (
          <div className="px-4 py-1 text-xs bg-amber-50 text-amber-700 border-b border-amber-200">
            Offline mode: bills save locally and sync automatically when internet returns.
          </div>
        )}

        {/* ── History view ─────────────────────────────────────────── */}
        {view === 'history' && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                placeholder={`Search ${billType} by bill no or customer`}
                className="w-full max-w-md border rounded-lg px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleMoveSelectedHistoryBillsToNumberUpdater}
                disabled={historySelectedBillIds.length === 0}
                className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
              >
                Move to Number Updater{historySelectedBillIds.length ? ` (${historySelectedBillIds.length})` : ''}
              </button>
              <button
                type="button"
                onClick={handleExportHistoryCsv}
                disabled={historyBills.length === 0}
                className="px-3 py-2 rounded-lg border bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-60"
              >
                Export CSV{historySelectedBillIds.length ? ` (${historySelectedBillIds.length})` : ''}
              </button>
              {billType === 'invoice' && historyBills.length > 0 && (
                <Link
                  href={getHistoryInvoicePackHref()}
                  className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
                >
                  Export PDF{historySelectedBillIds.length ? ` (${historySelectedBillIds.length})` : ''}
                </Link>
              )}
              <button
                type="button"
                onClick={handleDeleteSelectedHistoryBills}
                disabled={historyDeleting || historySelectedBillIds.length === 0}
                className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60"
              >
                {historyDeleting ? 'Deleting…' : `Delete Selected${historySelectedBillIds.length ? ` (${historySelectedBillIds.length})` : ''}`}
              </button>
            </div>
            {historyLoading ? (
              <div className="text-center text-gray-400 py-10">Loading…</div>
            ) : historyBills.length === 0 ? (
              <div className="text-center text-gray-400 py-10">No {billType}s found</div>
            ) : (
              <div className="bg-white rounded-xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                          {['Select','Date','Bill No','Customer','Total','Paid','Due','Mode','Status','Action'].map(h => (
                        <th key={h} className="px-3 py-2 text-left">
                          {h === 'Select' ? (
                            <input
                              type="checkbox"
                              checked={historyBills.length > 0 && historySelectedBillIds.length === historyBills.length}
                              onChange={(e) => handleToggleSelectAllHistoryBills(e.target.checked)}
                              aria-label="Select all invoices in history list"
                            />
                          ) : h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyBills.map(b => (
                      <tr key={b.id} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={historySelectedBillIds.includes(b.id)}
                            onChange={(e) => handleToggleHistoryBillSelection(b.id, e.target.checked)}
                            aria-label={`Select invoice ${b.bill_no}`}
                          />
                        </td>
                        <td className="px-3 py-2">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                        <td className="px-3 py-2 font-mono font-medium">
                          <Link href={`/billing/${b.id}`} className="text-blue-700 hover:underline">
                            {b.bill_no}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-gray-600">{b.customer_name || '—'}</td>
                        <td className="px-3 py-2 font-medium text-right">₹{Number(b.total).toFixed(2)}</td>
                        <td className="px-3 py-2 font-medium text-right">₹{Number(b.paid_amount || 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">₹{getHistoryDueAmount(b).toFixed(2)}</td>
                        <td className="px-3 py-2">
                          {b.bill_type === 'invoice' ? (
                            <select
                              value={String(b.payment_mode || '').toLowerCase() || 'cash'}
                              onChange={(e) => handleHistoryPaymentModeUpdate(b, e.target.value)}
                              disabled={historyUpdatingBillId === b.id}
                              className="border rounded px-2 py-1 text-xs bg-white disabled:opacity-60"
                            >
                              {PAYMENT_MODES.map((mode) => (
                                <option key={mode} value={mode.toLowerCase()}>
                                  {mode}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-xs uppercase text-gray-500">{b.payment_mode || '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            b.payment_status === 'paid' ? 'bg-green-100 text-green-700'
                            : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                            : 'bg-gray-100 text-gray-600'
                          }`}>{b.payment_status || 'draft'}</span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleHistoryPrint(b)}
                              disabled={historyPrintingBillId === b.id}
                              className="px-2 py-1 rounded bg-gray-800 text-white text-xs hover:bg-gray-900 disabled:opacity-60"
                            >
                              {historyPrintingBillId === b.id ? 'Printing…' : 'Print'}
                            </button>
                            {b.bill_type === 'invoice' ? (
                              getHistoryDueAmount(b) > 0 ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  value={historyPaymentDrafts[b.id] ?? ''}
                                  onChange={(e) => setHistoryPaymentDrafts((prevDrafts) => ({ ...prevDrafts, [b.id]: e.target.value }))}
                                  placeholder="Paid now"
                                  className="w-24 border rounded px-2 py-1 text-xs"
                                  min="0"
                                  step="0.01"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleHistoryRecordPayment(b)}
                                  disabled={historyUpdatingBillId === b.id}
                                  className="px-2 py-1 rounded bg-green-600 text-white text-xs hover:bg-green-700 disabled:opacity-60"
                                >
                                  {historyUpdatingBillId === b.id ? 'Saving…' : 'Record'}
                                </button>
                              </div>
                              ) : (
                                <span className="text-xs text-gray-400">Settled</span>
                              )
                            ) : (
                              <Link
                                href={`/billing?convertFrom=${b.id}`}
                                className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                              >
                                Convert to Invoice
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Customer row, items, footer (form view only) ─────────── */}
        {view === 'form' && (<>
        {/* ── Customer row ────────────────────────────────────────────── */}
        <div className="bg-white border-b px-4 py-2 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-3 items-center flex-shrink-0">
          <div className="flex flex-nowrap items-center gap-1 min-w-0">
            <span className="text-xs text-gray-400 whitespace-nowrap w-16 shrink-0">Customer:</span>
            <input
              id="customer-name"
              value={customer.name}
              onChange={e => setCustomer(c => ({ ...c, name: e.target.value }))}
              placeholder="Name (optional)" className="border rounded px-2 py-1 text-sm flex-1 min-w-0" />
            <button
              type="button"
              onClick={() => {
                setCustomerPickerSearch('')
                setCustomerPickerOpen(true)
                loadCustomerDirectory({ preferCache: true, silent: true })
              }}
              className="shrink-0 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
            >
              Select
            </button>
            <Link href="/customers" className="shrink-0 whitespace-nowrap text-xs text-gray-500 hover:text-blue-600 hover:underline">
              Customers
            </Link>
          </div>
          <div className="flex flex-nowrap items-center gap-1 min-w-0">
            <span className="text-xs text-gray-400 whitespace-nowrap w-16 shrink-0">Phone:</span>
            <input id="customer-phone" value={customer.phone} onChange={e => setCustomer(c => ({ ...c, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
              placeholder="Phone" className="border rounded px-2 py-1 text-sm flex-1 min-w-0" />
          </div>
          <div className="flex flex-nowrap items-center gap-1 min-w-0">
            <span className="text-xs text-gray-400 whitespace-nowrap w-16 shrink-0">GSTIN:</span>
            <input value={customer.gstin}
              onChange={e => setCustomer(c => ({ ...c, gstin: e.target.value.toUpperCase().slice(0, 15) }))}
              placeholder="Customer GSTIN" maxLength={15}
              className="border rounded px-2 py-1 text-sm flex-1 min-w-0 font-mono uppercase" />
          </div>
          <div className="flex flex-nowrap items-center gap-1 min-w-0">
            <span className="text-xs text-gray-400 whitespace-nowrap w-16 shrink-0">Address:</span>
            <input value={customer.address} onChange={e => setCustomer(c => ({ ...c, address: e.target.value }))}
              placeholder="Address" className="border rounded px-2 py-1 text-sm flex-1 min-w-0" />
          </div>
        </div>

        {/* ── Bill items table ─────────────────────────────────────────── */}
        <div className="flex-1 md:overflow-y-auto px-4 pt-3 min-h-[45vh] md:min-h-0">
          <div className="table-scroll">
          <table className="w-full min-w-[560px] md:min-w-[640px] bg-white border rounded-lg text-sm border-collapse billing-table">
            <thead>
              <tr className="bg-gray-100 text-gray-600 text-xs">
                <th className="px-2 py-2 text-left w-8">#</th>
                <th className="px-2 py-2 text-left">Product Name</th>
                <th className="px-2 py-2 text-center w-16">HSN</th>
                <th className="px-2 py-2 text-center w-20">Qty</th>
                <th className="px-2 py-2 text-center w-14">Unit</th>
                <th className="px-2 py-2 text-right w-24">Rate (₹)</th>
                <th className="px-2 py-2 text-center w-16">GST%</th>
                <th className="px-2 py-2 text-center w-16">Disc%</th>
                <th className="px-2 py-2 text-right w-24">Amount (₹)</th>
                <th className="px-2 py-2 w-7"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const profitPreview = getProfitPreview(item)
                const hasStockQty =
                  item.stock_qty !== undefined
                  && item.stock_qty !== null
                  && item.stock_qty !== ''
                  && Number.isFinite(Number(item.stock_qty))
                const stockQty = hasStockQty ? Number(item.stock_qty) : null
                return (
                <tr
                  key={item._id}
                  onClick={() => setActiveRow(i)}
                  className={`border-t transition-colors ${
                    i === activeRow ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-2 py-1 text-gray-400 text-xs">{i + 1}</td>

                  {/* Product name / search button */}
                  <td className="px-2 py-1">
                    <button
                      className={`text-left w-full truncate ${
                        item.product_name
                          ? 'font-medium text-gray-900'
                          : 'text-gray-400 italic text-xs'
                      }`}
                      onClick={e => { e.stopPropagation(); openSearch(i) }}
                      onFocus={() => setActiveRow(i)}
                      tabIndex={0}
                      title="Tap to search, or press F3 / on a keyboard"
                    >
                      {item.product_name || 'Tap to search product…'}
                    </button>
                    {item.product_name && hasStockQty && (
                      <div className="mt-0.5 text-xs text-gray-500">
                        Stock: {stockQty}
                      </div>
                    )}
                    {/* Low / out-of-stock warning */}
                    {hasStockQty && (
                      stockQty <= 0
                        ? <div className="text-xs text-red-500 leading-tight mt-0.5">⚠ 0 left · Out of stock</div>
                        : item.min_stock > 0 && stockQty <= item.min_stock
                          ? <div className="text-xs text-yellow-600 leading-tight mt-0.5">⚡ Low stock ({stockQty} left)</div>
                          : null
                    )}
                  </td>

                  {/* HSN */}
                  <td className="px-1 py-1">
                    <input
                      value={item.hsn_code}
                      onChange={e => updateItem(i, 'hsn_code', e.target.value)}
                      onFocus={() => setActiveRow(i)}
                      className="w-full border rounded px-1 py-0.5 text-xs text-center"
                      placeholder="HSN"
                    />
                  </td>

                  {/* Qty */}
                  <td className="px-1 py-1">
                    <input
                      id={`qty-${i}`}
                      type="number"
                      value={item.quantity}
                      onChange={e => updateItem(i, 'quantity', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                          e.preventDefault()
                          focusId(`rate-${i}`)
                        }
                      }}
                      className="w-full border rounded px-1 py-0.5 text-center"
                      min="0" step="0.001"
                    />
                  </td>

                  {/* Unit */}
                  <td className="px-1 py-1 text-center text-xs text-gray-500">{item.unit}</td>

                  {/* Rate */}
                  <td className="px-1 py-1">
                    <input
                      id={`rate-${i}`}
                      type="number"
                      value={item.rate}
                      onChange={e => updateItem(i, 'rate', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                          e.preventDefault()
                          focusId(`disc-${i}`)
                        }
                      }}
                      className="w-full border rounded px-1 py-0.5 text-right"
                      min="0" step="0.01"
                    />
                  </td>

                  {/* GST% */}
                  <td className="px-1 py-1">
                    <select
                      value={item.gst_rate}
                      onChange={e => updateItem(i, 'gst_rate', parseFloat(e.target.value))}
                      onFocus={() => setActiveRow(i)}
                      className="w-full border rounded px-1 py-0.5 text-center text-xs"
                    >
                      {GST_RATES.map(r => (
                        <option key={r} value={r}>{r}%</option>
                      ))}
                    </select>
                  </td>

                  {/* Discount % */}
                  <td className="px-1 py-1">
                    <input
                      id={`disc-${i}`}
                      type="number"
                      value={item.discount_pct}
                      onChange={e => updateItem(i, 'discount_pct', e.target.value)}
                      onFocus={e => { setActiveRow(i); e.target.select() }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addRow()
                        }
                      }}
                      className="w-full border rounded px-1 py-0.5 text-center"
                      min="0" max="100" step="0.01" placeholder="0"
                    />
                  </td>

                  {/* Amount */}
                  <td className="px-2 py-1 text-right font-medium">
                    {item.total > 0 ? fmt(item.total) : '—'}
                    {profitPreview && (
                      <div className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-tight ${profitPreview.isLoss ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                        <span>Purchase {fmt(profitPreview.purchasePrice)}/unit</span>
                        <span>Cost {fmt(profitPreview.totalCost)}</span>
                        <span>·</span>
                        <span>{profitPreview.isLoss ? 'Loss' : 'Profit'} {fmt(Math.abs(profitPreview.totalProfit))}</span>
                        <span>({profitPreview.marginPct.toFixed(1)}%)</span>
                      </div>
                    )}
                  </td>

                  {/* Delete */}
                  <td className="px-1 py-1 text-center">
                    <button
                      onClick={e => { e.stopPropagation(); deleteRow(i) }}
                      className="text-red-400 hover:text-red-600 leading-none"
                      tabIndex={-1}
                      title="Delete row (Ctrl+D)"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>

          <button
            onClick={addRow}
            className="mt-2 text-sm text-blue-600 hover:text-blue-800 hover:underline"
          >
            + Add Row &nbsp;<kbd className="hidden md:inline text-xs">F4</kbd>
          </button>
          </div>{/* end table-scroll */}
        </div>

        {/* ── Footer: payment + totals + actions ──────────────────────── */}
        <div className="flex-shrink-0 border-t bg-white px-4 py-3 flex flex-col md:flex-row gap-4">

          {/* Left: notes + payment */}
          <div className="flex-1 space-y-2 order-2 md:order-1">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full border rounded px-2 py-1 text-sm resize-none"
            />
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Place of Supply</div>
                <input
                  type="text"
                  value={placeOfSupply}
                  onChange={e => setPlaceOfSupply(e.target.value)}
                  placeholder="State"
                  className="border rounded px-2 py-1 text-sm w-32"
                />
              </div>
              <div className="flex items-center gap-1.5 pb-1.5">
                <input
                  id="reverseCharge"
                  type="checkbox"
                  checked={reverseCharge}
                  onChange={e => setReverseCharge(e.target.checked)}
                />
                <label htmlFor="reverseCharge" className="text-xs text-gray-600">GST Reverse Charge</label>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Payment Mode</div>
                <select
                  value={payMode}
                  onChange={e => handlePayModeChange(e.target.value)}
                  className="border rounded px-2 py-1 text-sm"
                >
                  {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Paid Amount</div>
                <input
                  type="number"
                  value={paidAmt}
                  onChange={e => setPaidAmt(e.target.value)}
                  placeholder={String(totals.total)}
                  className="border rounded px-2 py-1 text-sm w-28"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => handleSave(true)}
                disabled={saving}
                className="flex-1 sm:flex-none px-4 py-2.5 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50 text-sm"
              >
                {saving ? 'Saving…' : <><span className="hidden md:inline">F8: </span>Save + Print</>}
              </button>
              <button
                onClick={() => handleSave(false)}
                disabled={saving}
                className="flex-1 sm:flex-none px-4 py-2.5 bg-green-600 text-white rounded font-medium hover:bg-green-700 disabled:opacity-50 text-sm"
              >
                <span className="hidden md:inline">F9: </span>Save
              </button>
              <button
                onClick={handleNewBill}
                className="flex-1 sm:flex-none px-4 py-2.5 bg-gray-200 text-gray-700 rounded font-medium hover:bg-gray-300 text-sm"
              >
                <span className="hidden md:inline">F2: </span>New Bill
              </button>
            </div>
          </div>

          {/* Right: totals box */}
          <div className="w-full md:w-64 bg-gray-50 border rounded-lg px-4 py-3 space-y-1 text-sm order-1 md:order-2">
            <div className="flex justify-between">
              <span className="text-gray-500">Subtotal (excl. GST)</span>
              <span>{fmt(totals.subtotal)}</span>
            </div>
            {totals.discountAmount > 0 && (
              <div className="flex justify-between text-red-500">
                <span>Discount</span>
                <span>– {fmt(totals.discountAmount)}</span>
              </div>
            )}
            {Object.entries(totals.gstBreakdown || {})
              .filter(([r, d]) => r !== '0' && d.gst > 0)
              .map(([r, d]) => (
                <div key={r} className="flex justify-between text-gray-500 text-xs">
                  <span>GST {r}% (CGST {r/2}% + SGST {r/2}%)</span>
                  <span>{fmt(d.gst)}</span>
                </div>
              ))}
            <div className="flex justify-between">
              <span className="text-gray-500">Total GST</span>
              <span>{fmt(totals.gstAmount)}</span>
            </div>
            <div className="flex justify-between font-bold text-lg border-t pt-2 mt-1">
              <span>Total</span>
              <span className="text-blue-700">{fmt(totals.total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Estimated Profit</span>
              <span className={profitSummary.totalProfit >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'}>
                {fmt(profitSummary.totalProfit)}
              </span>
            </div>
            <div className="text-[11px] text-gray-400">
              Per-line profit is based on stored purchase cost for each selected product.
            </div>
            {paidAmt && parseFloat(paidAmt) < totals.total && (
              <div className="flex justify-between text-orange-600 text-xs">
                <span>Balance due</span>
                <span>{fmt(totals.total - parseFloat(paidAmt))}</span>
              </div>
            )}
            <div className="text-xs text-gray-400 italic pt-1">
              {filledItems.length} item{filledItems.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        </>)}
      </div>
    </>
  )
}
