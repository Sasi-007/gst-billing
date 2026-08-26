'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'
import PrintTemplate from '@/components/PrintTemplate'

const AUTO_INVOICE_CREDIT_NOTE = 'Auto-created from invoice credit billing'

export default function BillDetailsPage() {
  const { id } = useParams()
  const router = useRouter()
  const { shop } = useShop()
  const [loading, setLoading] = useState(true)
  const [bill, setBill] = useState(null)
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [printData, setPrintData] = useState(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!shop?.id || !id) return

    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const { data: billRow, error: billErr } = await supabase
          .from('bills')
          .select('*')
          .eq('id', id)
          .eq('shop_id', shop.id)
          .single()
        if (billErr) throw billErr

        const { data: lineItems, error: itemsErr } = await supabase
          .from('bill_items')
          .select('id,sl_no,product_name,hsn_code,quantity,unit,rate,gst_rate,gst_amount,total')
          .eq('bill_id', id)
          .eq('shop_id', shop.id)
          .order('sl_no')
        if (itemsErr) throw itemsErr

        if (!cancelled) {
          setBill(billRow)
          setItems(lineItems || [])
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Failed to load bill')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [id, shop?.id])

  if (loading) {
    return <div className="p-4 text-gray-500">Loading bill details…</div>
  }

  if (error || !bill) {
    return (
      <div className="p-4">
        <div className="mb-3 text-red-600 text-sm">{error || 'Bill not found'}</div>
        <Link href="/reports" className="text-blue-600 hover:underline text-sm">← Back to Reports</Link>
      </div>
    )
  }

  function handlePrint() {
    const gstBreakdown = {}
    for (const it of items) {
      const rate = String(it.gst_rate || 0)
      if (!gstBreakdown[rate]) gstBreakdown[rate] = { base: 0, gst: 0 }
      gstBreakdown[rate].base += (Number(it.total || 0) - Number(it.gst_amount || 0))
      gstBreakdown[rate].gst += Number(it.gst_amount || 0)
    }

    setPrintData({
      bill,
      items,
      shop,
      totals: {
        subtotal: Number(bill.subtotal || 0),
        gstAmount: Number(bill.gst_amount || 0),
        discountAmount: Number(bill.discount_amount || 0),
        total: Number(bill.total || 0),
        gstBreakdown,
      },
    })
    setTimeout(() => window.print(), 120)
  }

  async function handleDelete() {
    if (!window.confirm(`Delete bill ${bill.bill_no}? This cannot be undone.`)) return
    setDeleting(true)
    const autoTag = `[AUTO-INVOICE:${bill.id}]`
    const { data: creditRows, error: creditLookupErr } = await supabase
      .from('credit_entries')
      .select('id,account_id')
      .eq('shop_id', shop.id)
      .ilike('reference_note', `%${autoTag}%`)
    if (creditLookupErr) {
      setDeleting(false)
      setError(creditLookupErr.message)
      return
    }
    const touchedAccountIds = [...new Set((creditRows || []).map((row) => row.account_id).filter(Boolean))]
    const creditIds = (creditRows || []).map((row) => row.id).filter(Boolean)
    if (creditIds.length > 0) {
      const { error: creditDeleteErr } = await supabase
        .from('credit_entries')
        .delete()
        .eq('shop_id', shop.id)
        .in('id', creditIds)
      if (creditDeleteErr) {
        setDeleting(false)
        setError(creditDeleteErr.message)
        return
      }
    }

    if (touchedAccountIds.length > 0) {
      const { data: accountRows, error: accountErr } = await supabase
        .from('credit_accounts')
        .select('id,opening_balance,notes,relation_type')
        .eq('shop_id', shop.id)
        .in('id', touchedAccountIds)
      if (accountErr) {
        setDeleting(false)
        setError(accountErr.message)
        return
      }

      const removableAccountIds = []
      for (const account of (accountRows || [])) {
        if (account.relation_type !== 'borrower') continue
        if (String(account.notes || '') !== AUTO_INVOICE_CREDIT_NOTE) continue
        if (Number(account.opening_balance || 0) !== 0) continue

        const { data: remainingEntries, error: remainingErr } = await supabase
          .from('credit_entries')
          .select('id')
          .eq('shop_id', shop.id)
          .eq('account_id', account.id)
          .limit(1)
        if (remainingErr) {
          setDeleting(false)
          setError(remainingErr.message)
          return
        }
        if ((remainingEntries || []).length === 0) removableAccountIds.push(account.id)
      }

      if (removableAccountIds.length > 0) {
        const { error: removeAccountsErr } = await supabase
          .from('credit_accounts')
          .delete()
          .eq('shop_id', shop.id)
          .in('id', removableAccountIds)
        if (removeAccountsErr) {
          setDeleting(false)
          setError(removeAccountsErr.message)
          return
        }
      }
    }

    const { error: delErr } = await supabase
      .from('bills')
      .delete()
      .eq('id', bill.id)
      .eq('shop_id', shop.id)
    setDeleting(false)
    if (delErr) {
      setError(delErr.message)
      return
    }
    router.replace('/reports')
  }

  return (
    <>
      {printData && mounted && createPortal(
        <PrintTemplate data={printData} />,
        document.body
      )}
    <div className="p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Bill {bill.bill_no}</h1>
          <div className="text-sm text-gray-500 mt-0.5">
            {new Date(bill.date + 'T00:00:00').toLocaleDateString('en-IN')} · {bill.bill_type}
          </div>
          <div className="text-sm text-gray-600 mt-1">
            Customer: {bill.customer_name || 'Walk-in'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">Total</div>
          <div className="text-xl font-bold text-blue-700">{fmt(bill.total)}</div>
          <div className="text-xs text-gray-500 capitalize mt-1">
            {bill.payment_mode || '—'} · {bill.payment_status || '—'}
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={handlePrint} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
              Print
            </button>
            {bill.bill_type !== 'invoice' && (
              <Link href={`/billing?convertFrom=${bill.id}`} className="px-3 py-1.5 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-700">
                Convert to Invoice
              </Link>
            )}
            <Link href={`/billing?editId=${bill.id}`} className="px-3 py-1.5 text-xs bg-amber-500 text-white rounded hover:bg-amber-600">
              Edit
            </Link>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b text-xs text-gray-500">
              {['#', 'Product', 'HSN', 'Qty', 'Unit', 'Rate', 'GST%', 'GST', 'Amount'].map(h => (
                <th key={h} className="px-3 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-center text-gray-400">
                  No line items found
                </td>
              </tr>
            ) : (
              items.map((it, idx) => (
                <tr key={it.id || idx} className="border-b last:border-b-0">
                  <td className="px-3 py-2">{it.sl_no || idx + 1}</td>
                  <td className="px-3 py-2 font-medium">{it.product_name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{it.hsn_code || '—'}</td>
                  <td className="px-3 py-2">{it.quantity}</td>
                  <td className="px-3 py-2">{it.unit || 'pcs'}</td>
                  <td className="px-3 py-2">{fmt(it.rate)}</td>
                  <td className="px-3 py-2">{it.gst_rate}%</td>
                  <td className="px-3 py-2">{fmt(it.gst_amount)}</td>
                  <td className="px-3 py-2 font-medium">{fmt(it.total)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <SummaryCard label="Subtotal" value={fmt(bill.subtotal)} />
        <SummaryCard label="GST" value={fmt(bill.gst_amount)} />
        <SummaryCard label="Discount" value={fmt(bill.discount_amount)} />
        <SummaryCard label="Grand Total" value={fmt(bill.total)} strong />
      </div>
    </div>
    </>
  )
}

function SummaryCard({ label, value, strong = false }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={strong ? 'text-lg font-bold text-blue-700 mt-1' : 'text-base font-semibold mt-1'}>
        {value}
      </div>
    </div>
  )
}
