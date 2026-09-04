'use client'

import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { normalizeCustomerPhone } from '@/lib/customers'

const AUTO_PURCHASE_CREDIT_NOTE = 'Auto-created from purchase credit billing'
const AUTO_PURCHASE_CREDIT_TAG_PREFIX = '[AUTO-PURCHASE:'
const SUPPLIER_ACCOUNT_TAG_PREFIX = '[SUPPLIER:'
const PURCHASE_PAYMENT_SYNC_TAG = '[PURCHASE-SYNCED]'

function normalizeSupplierName(value) {
  return String(value || '').trim()
}

function normalizeSupplierPhone(value) {
  return normalizeCustomerPhone(value)
}

function getAutoPurchaseCreditTag(purchaseId) {
  return `${AUTO_PURCHASE_CREDIT_TAG_PREFIX}${purchaseId}]`
}

function extractAutoPurchaseIdFromReferenceNote(referenceNote) {
  const note = String(referenceNote || '')
  const start = note.indexOf(AUTO_PURCHASE_CREDIT_TAG_PREFIX)
  if (start < 0) return ''
  const end = note.indexOf(']', start)
  if (end < 0) return ''
  return note.slice(start + AUTO_PURCHASE_CREDIT_TAG_PREFIX.length, end).trim()
}

function getPurchasePaymentStatus(total, paid) {
  if (paid >= total) return 'paid'
  if (paid > 0) return 'partial'
  return 'unpaid'
}

function getSupplierAccountTag(supplierId) {
  return supplierId ? `${SUPPLIER_ACCOUNT_TAG_PREFIX}${supplierId}]` : ''
}

function buildAccountNotes(...parts) {
  return [...new Set(parts
    .flatMap((part) => String(part || '').split('\n'))
    .map((part) => part.trim())
    .filter(Boolean))]
    .join('\n')
}

function buildReferenceNote(note, tag) {
  const parts = [...new Set([String(note || '').trim(), tag].filter(Boolean))]
  return parts.join(' ').trim() || null
}

function buildFallbackSupplierName(billNo) {
  return `Unknown supplier (${billNo || 'Purchase'})`
}

async function fetchSupplierSnapshot(shopId, supplierId) {
  if (!shopId || !supplierId) return null
  const { data, error } = await supabase
    .from('suppliers')
    .select('id,name,phone')
    .eq('shop_id', shopId)
    .eq('id', supplierId)
    .limit(1)
  if (error) throw error
  return data?.[0] || null
}

async function removeAutoPurchaseCreditEntries(shopId, purchaseId) {
  if (!shopId || !purchaseId) return
  const tag = getAutoPurchaseCreditTag(purchaseId)
  const { data: existingEntries, error: lookupErr } = await supabase
    .from('credit_entries')
    .select('id,account_id')
    .eq('shop_id', shopId)
    .ilike('reference_note', `%${tag}%`)
  if (lookupErr) throw lookupErr

  const entryIds = (existingEntries || []).map((row) => row.id).filter(Boolean)
  const touchedAccountIds = [...new Set((existingEntries || []).map((row) => row.account_id).filter(Boolean))]
  if (!entryIds.length) return

  const { error: deleteErr } = await supabase
    .from('credit_entries')
    .delete()
    .eq('shop_id', shopId)
    .in('id', entryIds)
  if (deleteErr) throw deleteErr

  if (!touchedAccountIds.length) return
  const { data: accountRows, error: accountErr } = await supabase
    .from('credit_accounts')
    .select('id,opening_balance,notes,relation_type')
    .eq('shop_id', shopId)
    .in('id', touchedAccountIds)
  if (accountErr) throw accountErr

  const removableAccountIds = []
  for (const account of (accountRows || [])) {
    if (account.relation_type !== 'lender') continue
    if (!String(account.notes || '').includes(AUTO_PURCHASE_CREDIT_NOTE)) continue
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

async function findLinkedLenderAccountForPurchase(shopId, purchaseId) {
  if (!shopId || !purchaseId) return ''
  const tag = getAutoPurchaseCreditTag(purchaseId)
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

async function findLenderAccountBySupplierTag(shopId, supplierId) {
  const tag = getSupplierAccountTag(supplierId)
  if (!shopId || !tag) return null
  const { data, error } = await supabase
    .from('credit_accounts')
    .select('id,notes')
    .eq('shop_id', shopId)
    .eq('relation_type', 'lender')
    .ilike('notes', `%${tag}%`)
    .limit(1)
  if (error) throw error
  return data?.[0] || null
}

async function reactivateLenderCreditAccount(shopId, accountId, payload = {}) {
  if (!shopId || !accountId) return accountId
  const { error } = await supabase
    .from('credit_accounts')
    .update({
      ...payload,
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq('shop_id', shopId)
    .eq('id', accountId)
  if (error) throw error
  return accountId
}

async function ensureLenderCreditAccount(shopId, supplier = {}, billNo = '', purchaseId = '') {
  const supplierId = String(supplier?.id || '').trim()
  const supplierName = normalizeSupplierName(supplier?.name)
  const supplierPhone = normalizeSupplierPhone(supplier?.phone)
  const supplierTag = getSupplierAccountTag(supplierId)
  const autoPartyName = supplierName || buildFallbackSupplierName(billNo || purchaseId)
  const notes = buildAccountNotes(AUTO_PURCHASE_CREDIT_NOTE, supplierTag)

  if (purchaseId) {
    const linkedAccountId = await findLinkedLenderAccountForPurchase(shopId, purchaseId)
    if (linkedAccountId) {
      return reactivateLenderCreditAccount(shopId, linkedAccountId, {
        party_name: autoPartyName,
        phone: supplierPhone || null,
        notes,
      })
    }
  }

  if (supplierId) {
    const taggedAccount = await findLenderAccountBySupplierTag(shopId, supplierId)
    if (taggedAccount?.id) {
      return reactivateLenderCreditAccount(shopId, taggedAccount.id, {
        party_name: autoPartyName,
        phone: supplierPhone || null,
        notes: buildAccountNotes(taggedAccount.notes, notes),
      })
    }
  }

  if (supplierPhone) {
    const { data: byPhone, error: byPhoneErr } = await supabase
      .from('credit_accounts')
      .select('id,notes')
      .eq('shop_id', shopId)
      .eq('relation_type', 'lender')
      .eq('phone', supplierPhone)
      .limit(1)
    if (byPhoneErr) throw byPhoneErr
    if (byPhone?.length) {
      return reactivateLenderCreditAccount(shopId, byPhone[0].id, {
        party_name: autoPartyName,
        phone: supplierPhone,
        notes: buildAccountNotes(byPhone[0].notes, notes),
      })
    }
  }

  if (supplierName) {
    const { data: byName, error: byNameErr } = await supabase
      .from('credit_accounts')
      .select('id,notes')
      .eq('shop_id', shopId)
      .eq('relation_type', 'lender')
      .eq('party_name', supplierName)
      .limit(1)
    if (byNameErr) throw byNameErr
    if (byName?.length) {
      return reactivateLenderCreditAccount(shopId, byName[0].id, {
        party_name: supplierName,
        phone: supplierPhone || null,
        notes: buildAccountNotes(byName[0].notes, notes),
      })
    }
  }

  const { data: byAutoName, error: byAutoNameErr } = await supabase
    .from('credit_accounts')
    .select('id,notes')
    .eq('shop_id', shopId)
    .eq('relation_type', 'lender')
    .eq('party_name', autoPartyName)
    .limit(1)
  if (byAutoNameErr) throw byAutoNameErr
  if (byAutoName?.length) {
    return reactivateLenderCreditAccount(shopId, byAutoName[0].id, {
      party_name: autoPartyName,
      phone: supplierPhone || null,
      notes: buildAccountNotes(byAutoName[0].notes, notes),
    })
  }

  const { data: createdAccount, error: createErr } = await supabase
    .from('credit_accounts')
    .insert({
      shop_id: shopId,
      party_name: autoPartyName,
      phone: supplierPhone || null,
      relation_type: 'lender',
      settlement_cycle: 'daily',
      settlement_day: null,
      opening_balance: 0,
      notes,
      is_active: true,
    })
    .select('id')
    .single()
  if (createErr) throw createErr
  return createdAccount.id
}

export async function syncPurchaseCreditEntry({
  shopId,
  purchaseId,
  billNo,
  billDate,
  supplierId,
  supplierName,
  supplierPhone,
  payMode,
  paidAmount,
  totalAmount,
}) {
  if (!shopId || !purchaseId) return

  await removeAutoPurchaseCreditEntries(shopId, purchaseId)

  const total = Number(totalAmount || 0)
  const paid = Number(paidAmount || 0)
  const dueAmount = Math.max(0, total - paid)
  const normalizedPayMode = String(payMode || '').trim().toLowerCase()
  const shouldTrack = dueAmount > 0 || normalizedPayMode === 'credit'
  if (!shouldTrack || dueAmount <= 0) return

  let nextSupplier = {
    id: supplierId || '',
    name: supplierName || '',
    phone: supplierPhone || '',
  }
  if (supplierId && !supplierName && !supplierPhone) {
    const supplier = await fetchSupplierSnapshot(shopId, supplierId)
    if (supplier) nextSupplier = supplier
  }

  const accountId = await ensureLenderCreditAccount(shopId, nextSupplier, billNo, purchaseId)
  const referenceNote = `Purchase ${billNo || ''} due ${fmt(dueAmount)} ${getAutoPurchaseCreditTag(purchaseId)}`.trim()

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

export async function applyLenderRepaymentToPurchases(shopId, accountId, amount, options = {}) {
  const settlementAmount = Number(amount || 0)
  if (!shopId || !accountId || settlementAmount <= 0) return
  const entryId = String(options.entryId || '').trim()
  const entryReferenceNote = String(options.referenceNote || '').trim()
  if (entryReferenceNote.includes(PURCHASE_PAYMENT_SYNC_TAG)) return

  const { data: mappedEntries, error: entryErr } = await supabase
    .from('credit_entries')
    .select('reference_note')
    .eq('shop_id', shopId)
    .eq('account_id', accountId)
    .eq('direction', 'increase')
    .ilike('reference_note', `%${AUTO_PURCHASE_CREDIT_TAG_PREFIX}%`)
  if (entryErr) throw entryErr

  const purchaseIds = [...new Set((mappedEntries || [])
    .map((entry) => extractAutoPurchaseIdFromReferenceNote(entry.reference_note))
    .filter(Boolean))]
  if (!purchaseIds.length) return

  const { data: purchaseRows, error: purchaseErr } = await supabase
    .from('purchase_bills')
    .select('id,date,created_at,total,paid_amount,payment_status')
    .eq('shop_id', shopId)
    .in('id', purchaseIds)
  if (purchaseErr) throw purchaseErr

  const openPurchases = (purchaseRows || [])
    .filter((purchase) => Number(purchase.total || 0) - Number(purchase.paid_amount || 0) > 0)
    .sort((left, right) => {
      const leftTime = new Date(left.date ? `${left.date}T00:00:00` : left.created_at || 0).getTime()
      const rightTime = new Date(right.date ? `${right.date}T00:00:00` : right.created_at || 0).getTime()
      return leftTime - rightTime
    })

  let remaining = settlementAmount
  for (const purchase of openPurchases) {
    if (remaining <= 0) break

    const total = Number(purchase.total || 0)
    const paid = Number(purchase.paid_amount || 0)
    const due = Math.max(0, total - paid)
    if (due <= 0) continue

    const applied = Math.min(remaining, due)
    const nextPaid = paid + applied
    const nextStatus = getPurchasePaymentStatus(total, nextPaid)

    const { error: updateErr } = await supabase
      .from('purchase_bills')
      .update({
        paid_amount: nextPaid,
        payment_status: nextStatus,
      })
      .eq('id', purchase.id)
      .eq('shop_id', shopId)
    if (updateErr) throw updateErr

    remaining -= applied
  }

  if (entryId) {
    const { error: markErr } = await supabase
      .from('credit_entries')
      .update({ reference_note: buildReferenceNote(entryReferenceNote, PURCHASE_PAYMENT_SYNC_TAG) })
      .eq('shop_id', shopId)
      .eq('id', entryId)
    if (markErr) throw markErr
  }
}

export async function repairAutoPurchaseCreditLinks(shopId) {
  if (!shopId) return
  const { data: purchaseRows, error } = await supabase
    .from('purchase_bills')
    .select('id,bill_no,date,total,paid_amount,payment_mode,payment_status,supplier_id,suppliers(name,phone)')
    .eq('shop_id', shopId)
    .in('payment_status', ['unpaid', 'partial'])
  if (error) throw error

  const duePurchases = (purchaseRows || []).filter((purchase) => Math.max(0, Number(purchase.total || 0) - Number(purchase.paid_amount || 0)) > 0)
  if (!duePurchases.length) return

  const { data: creditRows, error: creditErr } = await supabase
    .from('credit_entries')
    .select('id,amount,reference_note')
    .eq('shop_id', shopId)
    .eq('direction', 'increase')
    .ilike('reference_note', `%${AUTO_PURCHASE_CREDIT_TAG_PREFIX}%`)
  if (creditErr) throw creditErr

  const creditRowsByPurchaseId = (creditRows || []).reduce((map, row) => {
    const purchaseId = extractAutoPurchaseIdFromReferenceNote(row.reference_note)
    if (!purchaseId) return map
    if (!map[purchaseId]) map[purchaseId] = []
    map[purchaseId].push(row)
    return map
  }, {})

  for (const purchase of duePurchases) {
    const dueAmount = Math.max(0, Number(purchase.total || 0) - Number(purchase.paid_amount || 0))
    const linkedRows = creditRowsByPurchaseId[purchase.id] || []
    const matchingRows = linkedRows.filter((row) => Number(row.amount || 0) === dueAmount)
    if (linkedRows.length === 1 && matchingRows.length === 1) continue
    if (linkedRows.length) {
      await removeAutoPurchaseCreditEntries(shopId, purchase.id)
    }

    await syncPurchaseCreditEntry({
      shopId,
      purchaseId: purchase.id,
      billNo: purchase.bill_no,
      billDate: purchase.date,
      supplierId: purchase.supplier_id,
      supplierName: purchase.suppliers?.name || '',
      supplierPhone: purchase.suppliers?.phone || '',
      payMode: purchase.payment_mode,
      paidAmount: purchase.paid_amount,
      totalAmount: purchase.total,
    })
  }
}

export async function removePurchaseCreditEntry(shopId, purchaseId) {
  await removeAutoPurchaseCreditEntries(shopId, purchaseId)
}

export async function repairUnsyncedLenderRepayments(shopId) {
  if (!shopId) return

  const { data: purchaseIncreaseRows, error: purchaseIncreaseErr } = await supabase
    .from('credit_entries')
    .select('account_id')
    .eq('shop_id', shopId)
    .eq('direction', 'increase')
    .ilike('reference_note', `%${AUTO_PURCHASE_CREDIT_TAG_PREFIX}%`)
  if (purchaseIncreaseErr) throw purchaseIncreaseErr

  const accountIds = [...new Set((purchaseIncreaseRows || []).map((row) => row.account_id).filter(Boolean))]
  if (!accountIds.length) return

  const { data: repaymentRows, error: repaymentErr } = await supabase
    .from('credit_entries')
    .select('id,account_id,amount,reference_note,created_at')
    .eq('shop_id', shopId)
    .eq('direction', 'decrease')
    .in('account_id', accountIds)
    .order('created_at', { ascending: true })
  if (repaymentErr) throw repaymentErr

  for (const row of (repaymentRows || [])) {
    if (String(row.reference_note || '').includes(PURCHASE_PAYMENT_SYNC_TAG)) continue
    await applyLenderRepaymentToPurchases(shopId, row.account_id, row.amount, {
      entryId: row.id,
      referenceNote: row.reference_note,
    })
  }
}
