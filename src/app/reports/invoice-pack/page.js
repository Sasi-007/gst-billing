'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { todayStr } from '@/lib/finance'
import { printWithContent } from '@/lib/print'
import { useShop } from '@/context/ShopContext'
import PrintTemplate from '@/components/PrintTemplate'

function buildGstBreakdown(items) {
  const gstBreakdown = {}
  items.forEach((item) => {
    const rate = String(item.gst_rate || 0)
    if (!gstBreakdown[rate]) gstBreakdown[rate] = { base: 0, gst: 0 }
    gstBreakdown[rate].base += Number(item.total || 0) - Number(item.gst_amount || 0)
    gstBreakdown[rate].gst += Number(item.gst_amount || 0)
  })
  return gstBreakdown
}

function toPrintData(bill, items, shop) {
  return {
    bill,
    items,
    shop,
    printTemplate: 'standard',
    totals: {
      subtotal: Number(bill.subtotal || 0),
      gstAmount: Number(bill.gst_amount || 0),
      discountAmount: Number(bill.discount_amount || 0),
      total: Number(bill.total || 0),
      gstBreakdown: buildGstBreakdown(items),
    },
  }
}

export default function InvoicePackPage() {
  const searchParams = useSearchParams()
  const { shop, loading: shopLoading } = useShop()
  const idsParam = searchParams.get('ids') || ''
  const dateFrom = searchParams.get('dateFrom') || todayStr()
  const dateTo = searchParams.get('dateTo') || todayStr()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bills, setBills] = useState([])
  const [itemsByBill, setItemsByBill] = useState({})
  const [printShop, setPrintShop] = useState(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!shop?.id) return
    let cancelled = false

    async function loadInvoicePack() {
      setLoading(true)
      setError('')
      try {
        const invoiceIds = idsParam
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)

        let billsQuery = supabase
          .from('bills')
          .select('*')
          .eq('shop_id', shop.id)
          .eq('bill_type', 'invoice')
          .order('date')
          .order('bill_no')

        if (invoiceIds.length > 0) {
          billsQuery = billsQuery.in('id', invoiceIds)
        } else {
          billsQuery = billsQuery
            .gte('date', dateFrom)
            .lte('date', dateTo)
        }

        const [{ data: latestShop, error: shopErr }, { data: billRows, error: billsErr }] = await Promise.all([
          supabase.from('shops').select('*').eq('id', shop.id).single(),
          billsQuery,
        ])

        if (shopErr) throw shopErr
        if (billsErr) throw billsErr

        const billIds = (billRows || []).map((bill) => bill.id)
        const { data: itemRows, error: itemsErr } = billIds.length
          ? await supabase
            .from('bill_items')
            .select('id,bill_id,sl_no,product_name,hsn_code,quantity,unit,mrp,rate,gst_rate,gst_amount,total')
            .in('bill_id', billIds)
            .eq('shop_id', shop.id)
            .order('sl_no')
          : { data: [], error: null }

        if (itemsErr) throw itemsErr

        const grouped = {}
        ;(itemRows || []).forEach((item) => {
          if (!grouped[item.bill_id]) grouped[item.bill_id] = []
          grouped[item.bill_id].push(item)
        })

        if (!cancelled) {
          setPrintShop({ ...shop, ...latestShop })
          setBills(billRows || [])
          setItemsByBill(grouped)
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load invoice pack')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadInvoicePack()
    return () => { cancelled = true }
  }, [dateFrom, dateTo, idsParam, shop])

  const totalAmount = useMemo(
    () => bills.reduce((sum, bill) => sum + Number(bill.total || 0), 0),
    [bills]
  )

  if (shopLoading || loading) {
    return <div className="p-4 text-gray-500">Loading invoice PDF pack...</div>
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="mb-3 text-sm text-red-600">{error}</div>
        <Link href="/reports" className="text-sm text-blue-600 hover:underline">Back to Reports</Link>
      </div>
    )
  }

  return (
    <>
      <div className="no-print p-4">
        <div className="max-w-3xl rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-gray-900">GST Invoice PDF Pack</h1>
              <p className="mt-1 text-sm text-gray-500">
                {idsParam ? 'Selected invoices' : `${dateFrom} to ${dateTo}`} · {bills.length} invoice{bills.length === 1 ? '' : 's'} · {fmt(totalAmount)}
              </p>
              <p className="mt-2 text-xs text-gray-500">
                Click print, then choose "Save as PDF" to send one merged invoice file to your auditor.
              </p>
            </div>
            <div className="flex gap-2">
              <Link href="/reports" className="rounded-lg border px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
                Back
              </Link>
              <button
                type="button"
                onClick={() => printWithContent()}
                disabled={bills.length === 0}
                className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                Print / Save as PDF
              </button>
            </div>
          </div>

          {bills.length === 0 ? (
            <div className="mt-4 rounded-lg bg-gray-50 p-6 text-center text-sm text-gray-400">
              No GST sales invoices found for this date range.
            </div>
          ) : (
            <div className="mt-4 max-h-96 overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-xs text-gray-500">
                    {['Date', 'Bill No', 'Customer', 'GST', 'Total'].map((heading) => (
                      <th key={heading} className="px-3 py-2 text-left last:text-right">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => (
                    <tr key={bill.id} className="border-b">
                      <td className="px-3 py-1.5">{new Date(bill.date + 'T00:00:00').toLocaleDateString('en-IN')}</td>
                      <td className="px-3 py-1.5 font-mono font-medium">{bill.bill_no}</td>
                      <td className="px-3 py-1.5">{bill.customer_name || 'B2C Customer'}</td>
                      <td className="px-3 py-1.5">{fmt(bill.gst_amount)}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{fmt(bill.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {mounted && createPortal(
        <div className="invoice-pack-print">
        {bills.map((bill) => (
          <PrintTemplate
            key={bill.id}
            data={toPrintData(bill, itemsByBill[bill.id] || [], printShop || shop)}
          />
        ))}
        </div>,
        document.body
      )}
    </>
  )
}
