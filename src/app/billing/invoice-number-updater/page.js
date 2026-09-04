'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useShop } from '@/context/ShopContext'

const AUTO_INVOICE_CREDIT_TAG_PREFIX = '[AUTO-INVOICE:'

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

function compareBillsByNumber(a, b) {
  const left = parseBillNumber(a.bill_no)
  const right = parseBillNumber(b.bill_no)
  if (left.prefix !== right.prefix) return left.prefix.localeCompare(right.prefix)
  if (left.number !== right.number) return left.number - right.number
  return String(a.created_at || a.date || '').localeCompare(String(b.created_at || b.date || ''))
}

function formatBillNo(prefix, number, digits) {
  const cleanPrefix = String(prefix || '').trim().toUpperCase()
  const padded = String(number).padStart(Math.max(1, Number(digits) || 1), '0')
  return cleanPrefix ? `${cleanPrefix}-${padded}` : padded
}

export default function InvoiceNumberUpdaterPage() {
  const searchParams = useSearchParams()
  const { shop } = useShop()
  const [bills, setBills] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [prefix, setPrefix] = useState('')
  const [startNumber, setStartNumber] = useState(1)
  const [digits, setDigits] = useState(4)

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

  const previewRows = useMemo(() => bills.map((bill, index) => ({
    ...bill,
    next_bill_no: formatBillNo(prefix, Number(startNumber) + index, digits),
  })), [bills, digits, prefix, startNumber])

  useEffect(() => {
    if (!shop?.id) return
    let cancelled = false

    async function loadBills() {
      setLoading(true)
      setMessage(null)

      if (!selectedBillIds.length) {
        setBills([])
        setLoading(false)
        setMessage({ type: 'error', text: 'No invoices moved here. Select invoices from Billing History first.' })
        return
      }

      const { data, error } = await supabase
        .from('bills')
        .select('id,bill_no,bill_type,date,customer_name,total,paid_amount,payment_status,created_at')
        .eq('shop_id', shop.id)
        .in('id', selectedBillIds)

      if (cancelled) return
      if (error) {
        setBills([])
        setMessage({ type: 'error', text: `Invoice load failed: ${error.message}` })
        setLoading(false)
        return
      }

      const loadedBills = (data || [])
        .filter((bill) => bill.bill_type === 'invoice')
        .sort(compareBillsByNumber)
      setBills(loadedBills)

      const firstNumber = parseBillNumber(loadedBills[0]?.bill_no)
      setPrefix(firstNumber.prefix || shop.bill_prefix || 'INV')
      setDigits(Number.isFinite(firstNumber.number) ? firstNumber.digits : 4)
      setStartNumber(Number.isFinite(firstNumber.number) ? firstNumber.number : 1)
      if (!loadedBills.length) {
        setMessage({ type: 'error', text: 'Selected records are not tax invoices.' })
      }
      setLoading(false)
    }

    loadBills()
    return () => { cancelled = true }
  }, [selectedBillIds, shop?.bill_prefix, shop?.id])

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

      if (!window.confirm(`Refresh invoice numbers for ${previewRows.length} selected invoice${previewRows.length > 1 ? 's' : ''}?`)) {
        return
      }

      const tempPrefix = `__REN-${Date.now()}-`
      for (let index = 0; index < previewRows.length; index += 1) {
        const row = previewRows[index]
        const { error } = await supabase
          .from('bills')
          .update({ bill_no: `${tempPrefix}${index}` })
          .eq('shop_id', shop.id)
          .eq('id', row.id)
        if (error) throw error
      }

      for (const row of previewRows) {
        const { error } = await supabase
          .from('bills')
          .update({ bill_no: row.next_bill_no })
          .eq('shop_id', shop.id)
          .eq('id', row.id)
        if (error) throw error
      }

      await updateCreditReferenceNotes(previewRows)
      setBills(previewRows.map((row) => ({ ...row, bill_no: row.next_bill_no })).sort(compareBillsByNumber))
      setMessage({ type: 'success', text: `Updated ${previewRows.length} invoice number${previewRows.length > 1 ? 's' : ''}.` })
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
              Selected invoices can be refreshed into a clean sequence like INV-0001, INV-0002, INV-0003.
            </p>
          </div>
          <Link href="/billing?view=history" className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Back to History
          </Link>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
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
                disabled={saving || loading || previewRows.length === 0}
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {saving ? 'Updating...' : 'Refresh Invoice Number'}
              </button>
            </div>
          </div>

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
                    <td className="px-3 py-2 font-mono font-semibold text-blue-700">{bill.next_bill_no}</td>
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
