'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useShop } from '@/context/ShopContext'

const AUTO_INVOICE_CREDIT_TAG_PREFIX = '[AUTO-INVOICE:'
const TEMP_RENUMBER_PREFIX = '__REN-'

function parseBillNumber(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(.*?)-?(\d+)$/)
  if (!match) return { prefix: '', number: Number.POSITIVE_INFINITY, digits: 4 }
  return {
    prefix: match[1].replace(/-$/, '').toUpperCase(),
    number: Number(match[2]),
    digits: match[2].length,
  }
}

function compareBillsByDate(a, b) {
  const leftDate = String(a.date || '')
  const rightDate = String(b.date || '')
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
  const leftCreated = String(a.created_at || '')
  const rightCreated = String(b.created_at || '')
  if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated)
  const left = parseBillNumber(a.bill_no)
  const right = parseBillNumber(b.bill_no)
  if (left.prefix !== right.prefix) return left.prefix.localeCompare(right.prefix)
  return left.number - right.number
}

function pickSequenceSeed(rows) {
  let seed = null
  for (const row of rows) {
    const parsed = parseBillNumber(row.bill_no)
    if (!Number.isFinite(parsed.number)) continue
    if (!seed || parsed.number < seed.number) seed = parsed
  }
  return seed
}

function formatBillNo(prefix, number, digits) {
  const cleanPrefix = String(prefix || '').trim().toUpperCase()
  const padded = String(number).padStart(Math.max(1, Number(digits) || 1), '0')
  return cleanPrefix ? `${cleanPrefix}-${padded}` : padded
}

export default function InvoiceNumberUpdaterPage() {
  const searchParams = useSearchParams()
  const { shop, setShop } = useShop()
  const [bills, setBills] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [prefix, setPrefix] = useState('')
  const [startNumber, setStartNumber] = useState(1)
  const [digits, setDigits] = useState(4)
  const [scope, setScope] = useState('selected')
  const [otherBillNos, setOtherBillNos] = useState(() => new Set())
  const [totalInvoiceCount, setTotalInvoiceCount] = useState(0)
  const [strandedBills, setStrandedBills] = useState([])
  const [reloadKey, setReloadKey] = useState(0)

  const selectedBillIds = useMemo(() => {
    if (!shop?.id || typeof window === 'undefined') return []
    const queryIds = searchParams.get('ids')
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (queryIds?.length) return queryIds

    try {
      const stored = JSON.parse(window.sessionStorage.getItem(`invoice-number-updater:${shop.id}`) || '{}')
      return Array.isArray(stored.billIds) ? stored.billIds.filter(Boolean) : []
    } catch {
      return []
    }
  }, [searchParams, shop?.id])

  const previewRows = useMemo(() => bills.map((bill, index) => {
    const nextBillNo = formatBillNo(prefix, Number(startNumber) + index, digits)
    return {
      ...bill,
      next_bill_no: nextBillNo,
      conflicts: otherBillNos.has(nextBillNo),
    }
  }), [bills, digits, otherBillNos, prefix, startNumber])

  const conflictCount = useMemo(() => previewRows.filter((row) => row.conflicts).length, [previewRows])

  useEffect(() => {
    if (!shop?.id) return
    let cancelled = false

    async function loadBills() {
      setLoading(true)
      setMessage(null)

      const renumberAll = scope === 'all'
      if (!renumberAll && !selectedBillIds.length) {
        setBills([])
        setLoading(false)
        setMessage({ type: 'error', text: 'No invoices moved here. Select invoices from Billing History first, or switch to "All invoices" below.' })
        return
      }

      let query = supabase
        .from('bills')
        .select('id,bill_no,bill_type,date,customer_name,total,paid_amount,payment_status,created_at')
        .eq('shop_id', shop.id)
        .eq('bill_type', 'invoice')
      if (!renumberAll) query = query.in('id', selectedBillIds)
      const { data, error } = await query

      if (cancelled) return
      if (error) {
        setBills([])
        setMessage({ type: 'error', text: `Invoice load failed: ${error.message}` })
        setLoading(false)
        return
      }

      const loadedBills = (data || [])
        .filter((bill) => bill.bill_type === 'invoice')
        .sort(compareBillsByDate)
      setBills(loadedBills)

      // Numbers already held by invoices outside this selection are flagged in the
      // preview instead of only failing at save time.
      const { data: otherRows } = await supabase
        .from('bills')
        .select('id,bill_no,bill_type,date,customer_name,total')
        .eq('shop_id', shop.id)
      if (!cancelled) {
        const allRows = otherRows || []
        setTotalInvoiceCount(allRows.filter((row) => row.bill_type === 'invoice').length)
        const selectedIds = new Set(loadedBills.map((row) => row.id))
        setOtherBillNos(new Set(
          allRows
            .filter((row) => !selectedIds.has(row.id))
            .map((row) => row.bill_no)
            .filter(Boolean),
        ))
        // Numbers left behind by a renumber run that stopped halfway.
        setStrandedBills(allRows.filter((row) => String(row.bill_no || '').startsWith(TEMP_RENUMBER_PREFIX)))
      }

      const seed = pickSequenceSeed(loadedBills)
      setPrefix(seed?.prefix || shop.bill_prefix || 'INV')
      setDigits(seed ? seed.digits : 4)
      setStartNumber(renumberAll ? 1 : (seed ? seed.number : 1))
      if (!loadedBills.length) {
        setMessage({ type: 'error', text: renumberAll ? 'No tax invoices found for this shop.' : 'Selected records are not tax invoices.' })
      }
      setLoading(false)
    }

    loadBills()
    return () => { cancelled = true }
  }, [reloadKey, scope, selectedBillIds, shop?.bill_prefix, shop?.id])

  async function updateCreditReferenceNotes(plan) {
    for (const row of plan) {
      const tag = `${AUTO_INVOICE_CREDIT_TAG_PREFIX}${row.id}]`
      const dueAmount = Math.max(0, Number(row.total || 0) - Number(row.paid_amount || 0))
      const nextReference = `Invoice ${row.next_bill_no} due ${dueAmount.toFixed(2)} ${tag}`
      const { data: entries, error: entryLoadErr } = await supabase
        .from('credit_entries')
        .select('id,reference_note')
        .eq('shop_id', shop.id)
        .ilike('reference_note', `%${tag}%`)
      if (entryLoadErr) throw entryLoadErr

      const changedEntries = (entries || []).filter((entry) => String(entry.reference_note || '') !== nextReference)
      for (const entry of changedEntries) {
        const { error: entryUpdateErr } = await supabase
          .from('credit_entries')
          .update({ reference_note: nextReference })
          .eq('shop_id', shop.id)
          .eq('id', entry.id)
        if (entryUpdateErr) throw entryUpdateErr
      }
    }
  }

  // The shop counter drives get_next_bill_no, so it must never sit below the
  // highest number now in use — otherwise the next new bill reuses a number.
  async function syncBillCounter(highestAssigned) {
    const { data: allBills } = await supabase
      .from('bills')
      .select('bill_no')
      .eq('shop_id', shop.id)

    const highestInUse = (allBills || []).reduce((highest, row) => {
      const billNo = String(row.bill_no || '')
      if (billNo.startsWith(TEMP_RENUMBER_PREFIX)) return highest
      const parsed = parseBillNumber(billNo)
      return Number.isFinite(parsed.number) ? Math.max(highest, parsed.number) : highest
    }, 0)

    const counter = Math.max(highestAssigned, highestInUse)
    const { data: updatedShop, error } = await supabase
      .from('shops')
      .update({ bill_counter: counter, updated_at: new Date().toISOString() })
      .eq('id', shop.id)
      .select()
      .single()
    if (updatedShop) setShop({ ...shop, ...updatedShop })
    return { counter, error }
  }

  // Renames bills left on a `__REN-…` placeholder by an interrupted run, giving
  // them fresh numbers after the highest one currently in use.
  async function handleRepairStrandedNumbers() {
    if (!shop?.id || !strandedBills.length) return
    setSaving(true)
    setMessage(null)

    try {
      const { data: allBills, error: loadErr } = await supabase
        .from('bills')
        .select('bill_no')
        .eq('shop_id', shop.id)
      if (loadErr) throw loadErr

      const used = new Set((allBills || []).map((row) => row.bill_no).filter(Boolean))
      const repairPrefix = String(prefix || shop.bill_prefix || 'INV')
      const repairDigits = Number(digits) || 4
      let nextNumber = (allBills || []).reduce((highest, row) => {
        const billNo = String(row.bill_no || '')
        if (billNo.startsWith(TEMP_RENUMBER_PREFIX)) return highest
        const parsed = parseBillNumber(billNo)
        return Number.isFinite(parsed.number) ? Math.max(highest, parsed.number) : highest
      }, 0)

      const repaired = []
      for (const bill of [...strandedBills].sort(compareBillsByDate)) {
        let candidate = ''
        do {
          nextNumber += 1
          candidate = formatBillNo(repairPrefix, nextNumber, repairDigits)
        } while (used.has(candidate))
        used.add(candidate)

        const { error } = await supabase
          .from('bills')
          .update({ bill_no: candidate })
          .eq('shop_id', shop.id)
          .eq('id', bill.id)
        if (error) throw error
        repaired.push({ ...bill, next_bill_no: candidate })
      }

      await updateCreditReferenceNotes(repaired)
      const { counter } = await syncBillCounter(nextNumber)
      setStrandedBills([])
      setReloadKey((key) => key + 1)
      setMessage({
        type: 'success',
        text: `Fixed ${repaired.length} stuck invoice number${repaired.length > 1 ? 's' : ''} (${repaired.map((row) => row.next_bill_no).slice(0, 5).join(', ')}). Counter is now ${counter}.`,
      })
    } catch (error) {
      setMessage({ type: 'error', text: `Could not fix stuck invoice numbers: ${error?.message || 'Unknown error'}` })
    } finally {
      setSaving(false)
    }
  }

  async function handleRefreshInvoiceNumbers() {
    if (!shop?.id || !previewRows.length) return
    const numericStart = Number(startNumber)
    const numericDigits = Number(digits)
    if (!Number.isInteger(numericStart) || numericStart < 1) {
      setMessage({ type: 'error', text: 'Start number must be 1 or higher.' })
      return
    }
    if (!Number.isInteger(numericDigits) || numericDigits < 1 || numericDigits > 12) {
      setMessage({ type: 'error', text: 'Digits must be between 1 and 12.' })
      return
    }

    const nextBillNos = previewRows.map((row) => row.next_bill_no)
    const selectedSet = new Set(previewRows.map((row) => row.id))
    const duplicateNextNos = nextBillNos.filter((billNo, index) => nextBillNos.indexOf(billNo) !== index)
    if (duplicateNextNos.length) {
      setMessage({ type: 'error', text: `Duplicate new invoice number: ${duplicateNextNos[0]}` })
      return
    }

    setSaving(true)
    setMessage(null)

    try {
      const { data: existingRows, error: existingErr } = await supabase
        .from('bills')
        .select('id,bill_no')
        .eq('shop_id', shop.id)
        .in('bill_no', nextBillNos)
      if (existingErr) throw existingErr

      const conflicts = (existingRows || []).filter((row) => !selectedSet.has(row.id))
      if (conflicts.length) {
        setMessage({
          type: 'error',
          text: `Cannot update. ${conflicts[0].bill_no} is already used by another invoice outside this selected list.`,
        })
        return
      }

      if (!window.confirm(`Refresh invoice numbers for ${previewRows.length} ${scope === 'all' ? 'invoice' : 'selected invoice'}${previewRows.length > 1 ? 's' : ''}? The bill counter will also move to ${numericStart + previewRows.length - 1} so the next new bill continues this series.`)) {
        return
      }

      const tempPrefix = `${TEMP_RENUMBER_PREFIX}${Date.now()}-`
      const stagedRows = []
      try {
        for (let index = 0; index < previewRows.length; index += 1) {
          const row = previewRows[index]
          const { error } = await supabase
            .from('bills')
            .update({ bill_no: `${tempPrefix}${index}` })
            .eq('shop_id', shop.id)
            .eq('id', row.id)
          if (error) throw error
          stagedRows.push(row)
        }

        for (const row of previewRows) {
          const { error } = await supabase
            .from('bills')
            .update({ bill_no: row.next_bill_no })
            .eq('shop_id', shop.id)
            .eq('id', row.id)
          if (error) throw error
          stagedRows.pop()
        }
      } catch (renameError) {
        // Roll back anything still parked on a temp number so no invoice is
        // left showing __REN-… to the user.
        for (const row of stagedRows) {
          await supabase
            .from('bills')
            .update({ bill_no: row.bill_no })
            .eq('shop_id', shop.id)
            .eq('id', row.id)
        }
        throw renameError
      }

      await updateCreditReferenceNotes(previewRows)

      const highestAssigned = numericStart + previewRows.length - 1
      const { counter, error: counterErr } = await syncBillCounter(highestAssigned)
      setBills(previewRows.map((row) => ({ ...row, bill_no: row.next_bill_no })).sort(compareBillsByDate))
      setStrandedBills([])

      if (counterErr) {
        setMessage({
          type: 'error',
          text: `Invoice numbers updated, but the bill counter could not be saved (${counterErr.message}). Set the bill counter to ${counter} in Settings so the next bill continues the series.`,
        })
      } else {
        setMessage({
          type: 'success',
          text: `Updated ${previewRows.length} invoice number${previewRows.length > 1 ? 's' : ''}. Next new invoice will be ${formatBillNo(prefix, counter + 1, numericDigits)}.`,
        })
      }
    } catch (error) {
      setMessage({ type: 'error', text: `Invoice number update failed: ${error?.message || 'Unknown error'}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Invoice Number Updater</h1>
            <p className="text-sm text-gray-500">
              Selected invoices are ordered by invoice date (oldest first) and renumbered into a clean sequence like INV-0001, INV-0002, INV-0003.
            </p>
          </div>
          <Link href="/billing?view=history" className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Back to History
          </Link>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
            <span className="font-medium text-gray-700">Renumber:</span>
            <label className="flex items-center gap-2 text-gray-700">
              <input
                type="radio"
                name="scope"
                value="selected"
                checked={scope === 'selected'}
                onChange={() => setScope('selected')}
              />
              Selected invoices ({selectedBillIds.length})
            </label>
            <label className="flex items-center gap-2 text-gray-700">
              <input
                type="radio"
                name="scope"
                value="all"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              All invoices{totalInvoiceCount ? ` (${totalInvoiceCount})` : ''}
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-sm font-medium text-gray-700">
              Prefix
              <input
                value={prefix}
                onChange={(event) => setPrefix(event.target.value.toUpperCase())}
                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm"
                placeholder="INV"
              />
            </label>
            <label className="text-sm font-medium text-gray-700">
              Start number
              <input
                type="number"
                min="1"
                value={startNumber}
                onChange={(event) => setStartNumber(event.target.value)}
                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="text-sm font-medium text-gray-700">
              Digits
              <input
                type="number"
                min="1"
                max="12"
                value={digits}
                onChange={(event) => setDigits(event.target.value)}
                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm"
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleRefreshInvoiceNumbers}
                disabled={saving || loading || previewRows.length === 0 || conflictCount > 0}
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {saving ? 'Updating...' : 'Refresh Invoice Number'}
              </button>
            </div>
          </div>

          {conflictCount > 0 && (
            <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {conflictCount} new number{conflictCount > 1 ? 's are' : ' is'} already used by invoices outside this list (highlighted below).
              Change the start number, or switch to &quot;All invoices&quot; to renumber everything in one go.
            </div>
          )}

          {strandedBills.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span>
                {strandedBills.length} invoice{strandedBills.length > 1 ? 's are' : ' is'} stuck on a temporary number
                (e.g. {strandedBills[0].bill_no}) from a renumbering that did not finish.
              </span>
              <button
                type="button"
                onClick={handleRepairStrandedNumbers}
                disabled={saving}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
              >
                {saving ? 'Fixing...' : 'Fix stuck numbers'}
              </button>
            </div>
          )}

          {message && (
            <div className={`mt-4 rounded-lg px-3 py-2 text-sm ${
              message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {message.text}
            </div>
          )}
        </div>

        <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
          {loading ? (
            <div className="p-8 text-center text-gray-400">Loading selected invoices...</div>
          ) : previewRows.length === 0 ? (
            <div className="p-8 text-center text-gray-400">No selected invoices to update.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Current Invoice No</th>
                  <th className="px-3 py-2">New Invoice No</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((bill, index) => (
                  <tr key={bill.id} className="border-b last:border-0">
                    <td className="px-3 py-2 text-gray-500">{index + 1}</td>
                    <td className="px-3 py-2">{new Date(`${bill.date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                    <td className="px-3 py-2 font-mono font-medium text-gray-700">{bill.bill_no}</td>
                    <td className="px-3 py-2 font-mono font-semibold text-blue-700">
                      {bill.next_bill_no}
                      {bill.conflicts && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">in use</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{bill.customer_name || '-'}</td>
                    <td className="px-3 py-2 text-right font-medium">₹{Number(bill.total || 0).toFixed(2)}</td>
                    <td className="px-3 py-2">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{bill.payment_status || '-'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
