import { supabase } from '@/lib/supabase'

export const CUSTOMER_MASTER_SQL_HINT = 'Run supabase/updates_2026_08_27_customer_master.sql once to enable permanent customer linking.'

export function normalizeCustomerPhone(value) {
  const digitsOnly = String(value || '').replace(/\D/g, '')
  return digitsOnly.length === 10 ? digitsOnly : ''
}

export function normalizeCustomerText(value) {
  return String(value || '').trim()
}

export function normalizeCustomerGstin(value) {
  return String(value || '').trim().toUpperCase()
}

export function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim())
}

export function isMissingCustomerSchemaError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    (message.includes('customers') && message.includes('does not exist')) ||
    (message.includes('customer_id') && message.includes('does not exist')) ||
    (message.includes('customer_id') && message.includes('could not find')) ||
    message.includes('could not find the table') ||
    message.includes('could not find a relationship')
  )
}

function normalizePaymentMode(value) {
  return String(value || '').trim().toLowerCase()
}

function createCustomerSummary(id, seed = {}) {
  return {
    id,
    name: '',
    phone: '',
    gstin: '',
    address: '',
    billCount: 0,
    totalBilled: 0,
    totalOutstanding: 0,
    totalCollected: 0,
    totalInvoiceValue: 0,
    lastBillNo: '',
    lastBillDate: '',
    lastBillType: '',
    lastSeenAt: '',
    recentBills: [],
    creditAccountId: '',
    invoiceCount: 0,
    quotationCount: 0,
    estimateCount: 0,
    paidInvoiceCount: 0,
    partialInvoiceCount: 0,
    unpaidInvoiceCount: 0,
    creditInvoiceCount: 0,
    openCreditInvoiceCount: 0,
    closedCreditInvoiceCount: 0,
    sourceBillIds: [],
    sourceAccountIds: [],
    isMasterRecord: false,
    ...seed,
  }
}

function getCustomerKeyFromBill(bill) {
  const phone = normalizeCustomerPhone(bill.customer_phone)
  if (phone) return `phone:${phone}`

  const gstin = normalizeCustomerGstin(bill.customer_gstin)
  if (gstin) return `gstin:${gstin}`

  const name = normalizeCustomerText(bill.customer_name).toLowerCase()
  const address = normalizeCustomerText(bill.customer_address).toLowerCase()
  if (name && address) return `name-address:${name}|${address}`
  if (name) return `bill:${bill.id}`
  if (address) return `bill-address:${bill.id}`
  return ''
}

function getCustomerKeyFromCreditAccount(account) {
  const phone = normalizeCustomerPhone(account.phone)
  if (phone) return `phone:${phone}`

  const name = normalizeCustomerText(account.party_name).toLowerCase()
  if (name) return `credit-account:${account.id}`
  return ''
}

function getCustomerAliasKeys(customer) {
  const aliases = []
  const phone = normalizeCustomerPhone(customer?.phone ?? customer?.customer_phone)
  const gstin = normalizeCustomerGstin(customer?.gstin ?? customer?.customer_gstin)
  const name = normalizeCustomerText(customer?.name ?? customer?.customer_name).toLowerCase()
  const address = normalizeCustomerText(customer?.address ?? customer?.customer_address).toLowerCase()

  if (phone) aliases.push(`phone:${phone}`)
  if (gstin) aliases.push(`gstin:${gstin}`)
  if (name && address) aliases.push(`name-address:${name}|${address}`)

  return aliases
}

function hasCustomerData(row) {
  return !!(
    normalizeCustomerText(row.customer_name) ||
    normalizeCustomerPhone(row.customer_phone) ||
    normalizeCustomerGstin(row.customer_gstin) ||
    normalizeCustomerText(row.customer_address)
  )
}

function mergeCustomerDetails(currentValue, incomingValue) {
  return currentValue || incomingValue || ''
}

function addRecentBill(customer, bill) {
  if (!bill.bill_no) return
  const nextRecentBills = [
    {
      billNo: bill.bill_no,
      date: bill.date || '',
      type: bill.bill_type || 'invoice',
      total: Number(bill.total || 0),
      paidAmount: Number(bill.paid_amount || 0),
      dueAmount: Math.max(0, Number(bill.total || 0) - Number(bill.paid_amount || 0)),
      paymentMode: normalizePaymentMode(bill.payment_mode),
      paymentStatus: String(bill.payment_status || '').trim().toLowerCase(),
    },
    ...(customer.recentBills || []),
  ].filter((entry, index, list) => list.findIndex((item) => item.billNo === entry.billNo) === index)
  customer.recentBills = nextRecentBills.slice(0, 3)
}

function mergeBillIntoCustomer(existing, bill) {
  const dueAmount = Math.max(0, Number(bill.total || 0) - Number(bill.paid_amount || 0))
  const totalAmount = Number(bill.total || 0)
  const paidAmount = Number(bill.paid_amount || 0)
  const billType = String(bill.bill_type || 'invoice').trim().toLowerCase()
  const paymentStatus = String(bill.payment_status || '').trim().toLowerCase()
  const paymentMode = normalizePaymentMode(bill.payment_mode)

  existing.name = mergeCustomerDetails(existing.name, normalizeCustomerText(bill.customer_name))
  existing.phone = mergeCustomerDetails(existing.phone, normalizeCustomerPhone(bill.customer_phone))
  existing.gstin = mergeCustomerDetails(existing.gstin, normalizeCustomerGstin(bill.customer_gstin))
  existing.address = mergeCustomerDetails(existing.address, normalizeCustomerText(bill.customer_address))
  existing.billCount += 1
  existing.totalBilled += totalAmount
  existing.totalOutstanding += dueAmount
  existing.lastBillNo = existing.lastBillNo || bill.bill_no || ''
  existing.lastBillDate = existing.lastBillDate || bill.date || ''
  existing.lastBillType = existing.lastBillType || bill.bill_type || 'invoice'
  existing.lastSeenAt = existing.lastSeenAt || bill.created_at || bill.date || ''

  if (billType === 'invoice') {
    existing.invoiceCount += 1
    existing.totalInvoiceValue += totalAmount
    existing.totalCollected += paidAmount
    if (paymentStatus === 'paid' || dueAmount <= 0) existing.paidInvoiceCount += 1
    else if (paymentStatus === 'partial' || paidAmount > 0) existing.partialInvoiceCount += 1
    else existing.unpaidInvoiceCount += 1

    if (paymentMode === 'credit') {
      existing.creditInvoiceCount += 1
      if (dueAmount > 0) existing.openCreditInvoiceCount += 1
      else existing.closedCreditInvoiceCount += 1
    }
  } else if (billType === 'quotation') {
    existing.quotationCount += 1
  } else if (billType === 'estimate') {
    existing.estimateCount += 1
  }

  addRecentBill(existing, bill)
}

function mergeCreditAccountIntoCustomer(existing, account) {
  existing.name = mergeCustomerDetails(existing.name, normalizeCustomerText(account.party_name))
  existing.phone = mergeCustomerDetails(existing.phone, normalizeCustomerPhone(account.phone))
  existing.creditAccountId = existing.creditAccountId || account.id || ''
}

function finalizeCustomerDirectory(customerMap) {
  return [...customerMap.values()]
    .filter((customer) => customer.name || customer.phone || customer.gstin || customer.address || customer.sourceBillIds.length || customer.sourceAccountIds.length)
    .map((customer) => ({
      ...customer,
      sourceBillIds: [...new Set(customer.sourceBillIds || [])],
      sourceAccountIds: [...new Set(customer.sourceAccountIds || [])],
    }))
    .sort((left, right) => {
      const leftTime = new Date(left.lastSeenAt || left.lastBillDate || 0).getTime()
      const rightTime = new Date(right.lastSeenAt || right.lastBillDate || 0).getTime()
      if (leftTime !== rightTime) return rightTime - leftTime
      return String(left.name || left.phone || '').localeCompare(String(right.name || right.phone || ''))
    })
}

function buildLegacyCustomerDirectory({ bills = [], creditAccounts = [] } = {}) {
  const customerMap = new Map()

  for (const bill of bills) {
    if (!hasCustomerData(bill)) continue
    const key = getCustomerKeyFromBill(bill)
    if (!key) continue
    if (!customerMap.has(key)) customerMap.set(key, createCustomerSummary(key))
    const customer = customerMap.get(key)
    mergeBillIntoCustomer(customer, bill)
    customer.sourceBillIds.push(bill.id)
  }

  for (const account of creditAccounts) {
    const key = getCustomerKeyFromCreditAccount(account)
    if (!key) continue
    if (!customerMap.has(key)) customerMap.set(key, createCustomerSummary(key))
    const customer = customerMap.get(key)
    mergeCreditAccountIntoCustomer(customer, account)
    customer.sourceAccountIds.push(account.id)
  }

  return finalizeCustomerDirectory(customerMap)
}

function buildMasterCustomerDirectory({ customers = [], bills = [], creditAccounts = [] } = {}) {
  const customerMap = new Map()
  const aliasToCustomerId = new Map()

  const ensureCustomerEntry = (key, seed = {}) => {
    if (!customerMap.has(key)) {
      customerMap.set(key, createCustomerSummary(key, seed))
    }
    return customerMap.get(key)
  }

  const resolveMasterCustomerKey = (row) => {
    for (const alias of getCustomerAliasKeys(row)) {
      if (aliasToCustomerId.has(alias)) return aliasToCustomerId.get(alias)
    }
    return ''
  }

  for (const customerRow of customers) {
    const id = customerRow.id
    if (!id) continue
    const customer = ensureCustomerEntry(id, {
      id,
      name: normalizeCustomerText(customerRow.name),
      phone: normalizeCustomerPhone(customerRow.phone),
      gstin: normalizeCustomerGstin(customerRow.gstin),
      address: normalizeCustomerText(customerRow.address),
      lastSeenAt: customerRow.updated_at || customerRow.created_at || '',
      isMasterRecord: true,
    })
    customer.name = mergeCustomerDetails(customer.name, normalizeCustomerText(customerRow.name))
    customer.phone = mergeCustomerDetails(customer.phone, normalizeCustomerPhone(customerRow.phone))
    customer.gstin = mergeCustomerDetails(customer.gstin, normalizeCustomerGstin(customerRow.gstin))
    customer.address = mergeCustomerDetails(customer.address, normalizeCustomerText(customerRow.address))

    for (const alias of getCustomerAliasKeys(customerRow)) {
      if (!aliasToCustomerId.has(alias)) aliasToCustomerId.set(alias, id)
    }
  }

  for (const bill of bills) {
    if (!hasCustomerData(bill) && !isUuidLike(bill.customer_id)) continue
    const key = isUuidLike(bill.customer_id)
      ? bill.customer_id
      : resolveMasterCustomerKey(bill) || getCustomerKeyFromBill(bill)
    if (!key) continue
    const customer = ensureCustomerEntry(key, { isMasterRecord: isUuidLike(key) })
    mergeBillIntoCustomer(customer, bill)
    customer.sourceBillIds.push(bill.id)
    if (isUuidLike(bill.customer_id)) customer.isMasterRecord = true
  }

  for (const account of creditAccounts) {
    const key = isUuidLike(account.customer_id)
      ? account.customer_id
      : resolveMasterCustomerKey({ name: account.party_name, phone: account.phone }) || getCustomerKeyFromCreditAccount(account)
    if (!key) continue
    const customer = ensureCustomerEntry(key, { isMasterRecord: isUuidLike(key) })
    mergeCreditAccountIntoCustomer(customer, account)
    customer.sourceAccountIds.push(account.id)
    if (isUuidLike(account.customer_id)) customer.isMasterRecord = true
  }

  return finalizeCustomerDirectory(customerMap)
}

async function fetchLegacyBills(shopId) {
  const { data, error } = await supabase
    .from('bills')
    .select('id,bill_no,bill_type,date,created_at,customer_name,customer_phone,customer_gstin,customer_address,total,paid_amount,payment_mode,payment_status')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

async function fetchLegacyCreditAccounts(shopId) {
  const { data, error } = await supabase
    .from('credit_accounts')
    .select('id,party_name,phone,created_at,relation_type,is_active')
    .eq('shop_id', shopId)
    .eq('relation_type', 'borrower')
    .eq('is_active', true)
    .order('party_name')
  if (error) throw error
  return data || []
}

export function matchesCustomerSearch(customer, searchTerm) {
  const term = String(searchTerm || '').trim().toLowerCase()
  if (!term) return true

  return [
    customer.name,
    customer.phone,
    customer.gstin,
    customer.address,
    customer.lastBillNo,
    ...(customer.recentBills || []).map((bill) => bill.billNo),
  ].some((value) => String(value || '').toLowerCase().includes(term))
}

export async function fetchCustomerDirectory(shopId) {
  if (!shopId) return []

  try {
    const [{ data: customers, error: customersError }, { data: bills, error: billsError }, { data: creditAccounts, error: creditAccountsError }] = await Promise.all([
      supabase
        .from('customers')
        .select('id,name,phone,gstin,address,is_active,created_at,updated_at')
        .eq('shop_id', shopId)
        .eq('is_active', true)
        .order('updated_at', { ascending: false }),
      supabase
        .from('bills')
        .select('id,bill_no,bill_type,date,created_at,customer_id,customer_name,customer_phone,customer_gstin,customer_address,total,paid_amount,payment_mode,payment_status')
        .eq('shop_id', shopId)
        .order('created_at', { ascending: false }),
      supabase
        .from('credit_accounts')
        .select('id,customer_id,party_name,phone,created_at,relation_type,is_active')
        .eq('shop_id', shopId)
        .eq('relation_type', 'borrower')
        .eq('is_active', true)
        .order('party_name'),
    ])

    if (customersError) throw customersError
    if (billsError) throw billsError
    if (creditAccountsError) throw creditAccountsError

    return buildMasterCustomerDirectory({
      customers: customers || [],
      bills: bills || [],
      creditAccounts: creditAccounts || [],
    })
  } catch (error) {
    if (!isMissingCustomerSchemaError(error)) throw error

    const [bills, creditAccounts] = await Promise.all([
      fetchLegacyBills(shopId),
      fetchLegacyCreditAccounts(shopId),
    ])

    return buildLegacyCustomerDirectory({ bills, creditAccounts })
  }
}

async function findExistingCustomer(shopId, payload) {
  if (payload.phone) {
    const { data, error } = await supabase
      .from('customers')
      .select('id,name,phone,gstin,address,is_active')
      .eq('shop_id', shopId)
      .eq('phone', payload.phone)
      .limit(1)
    if (error) throw error
    if (data?.length) return data[0]
  }

  if (payload.gstin) {
    const { data, error } = await supabase
      .from('customers')
      .select('id,name,phone,gstin,address,is_active')
      .eq('shop_id', shopId)
      .eq('gstin', payload.gstin)
      .limit(1)
    if (error) throw error
    if (data?.length) return data[0]
  }

  if (payload.name && payload.address) {
    const { data, error } = await supabase
      .from('customers')
      .select('id,name,phone,gstin,address,is_active')
      .eq('shop_id', shopId)
      .eq('name', payload.name)
      .eq('address', payload.address)
      .limit(1)
    if (error) throw error
    if (data?.length) return data[0]
  }

  return null
}

export async function ensureCustomerRecord(shopId, customer, options = {}) {
  if (!shopId) return null

  const payload = {
    name: normalizeCustomerText(customer?.name),
    phone: normalizeCustomerPhone(customer?.phone),
    gstin: normalizeCustomerGstin(customer?.gstin),
    address: normalizeCustomerText(customer?.address),
  }
  if (!payload.name && !payload.phone && !payload.gstin && !payload.address) return null

  const requestedId = isUuidLike(options.customerId || customer?.id) ? String(options.customerId || customer?.id).trim() : ''

  try {
    if (requestedId) {
      const { data, error } = await supabase
        .from('customers')
        .update({
          name: payload.name || null,
          phone: payload.phone || null,
          gstin: payload.gstin || null,
          address: payload.address || null,
          is_active: true,
        })
        .eq('shop_id', shopId)
        .eq('id', requestedId)
        .select('id,name,phone,gstin,address')
        .limit(1)
      if (error) throw error
      if (data?.length) return data[0]
    }

    const existingCustomer = await findExistingCustomer(shopId, payload)
    if (existingCustomer?.id) {
      const { data, error } = await supabase
        .from('customers')
        .update({
          name: payload.name || existingCustomer.name || null,
          phone: payload.phone || existingCustomer.phone || null,
          gstin: payload.gstin || existingCustomer.gstin || null,
          address: payload.address || existingCustomer.address || null,
          is_active: true,
        })
        .eq('shop_id', shopId)
        .eq('id', existingCustomer.id)
        .select('id,name,phone,gstin,address')
        .limit(1)
      if (error) throw error
      return data?.[0] || existingCustomer
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({
        shop_id: shopId,
        name: payload.name || null,
        phone: payload.phone || null,
        gstin: payload.gstin || null,
        address: payload.address || null,
        is_active: true,
      })
      .select('id,name,phone,gstin,address')
      .limit(1)
    if (error) throw error
    return data?.[0] || null
  } catch (error) {
    if (isMissingCustomerSchemaError(error)) return null
    throw error
  }
}

export async function archiveCustomerRecord(shopId, customerId) {
  if (!shopId || !isUuidLike(customerId)) return false

  try {
    const { error } = await supabase
      .from('customers')
      .update({ is_active: false })
      .eq('shop_id', shopId)
      .eq('id', customerId)
    if (error) throw error
    return true
  } catch (error) {
    if (isMissingCustomerSchemaError(error)) return false
    throw error
  }
}
