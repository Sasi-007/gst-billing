'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { useShop } from '@/context/ShopContext'

export default function PurchaseDetailsPage() {
  const { id } = useParams()
  const router = useRouter()
  const { shop } = useShop()
  const [loading, setLoading] = useState(true)
  const [bill, setBill] = useState(null)
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!shop?.id || !id) return

    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const { data: billRow, error: billErr } = await supabase
          .from('purchase_bills')
          .select('*, suppliers(name)')
          .eq('id', id)
          .eq('shop_id', shop.id)
          .single()
        if (billErr) throw billErr

        const { data: lineItems, error: itemsErr } = await supabase
          .from('purchase_bill_items')
          .select('id,sl_no,product_name,hsn_code,quantity,unit,rate,mrp,gst_rate,gst_amount,total')
          .eq('purchase_bill_id', id)
          .eq('shop_id', shop.id)
          .order('sl_no')
        if (itemsErr) throw itemsErr

        if (!cancelled) {
          setBill(billRow)
          setItems(lineItems || [])
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load purchase')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [id, shop?.id])

  async function handleDelete() {
    if (!window.confirm(`Delete purchase ${bill.bill_no}? This cannot be undone.`)) return
    setDeleting(true)
    const { error: delErr } = await supabase
      .from('purchase_bills')
      .delete()
      .eq('id', bill.id)
      .eq('shop_id', shop.id)
    setDeleting(false)
    if (delErr) { setError(delErr.message); return }
    router.replace('/purchases')
  }

  function handlePrint() {
    setPrintOpen(true)
    setTimeout(() => window.print(), 120)
    setTimeout(() => setPrintOpen(false), 500)
  }

  if (loading) return <div className="p-4 text-gray-500">Loading purchase details…</div>
  if (error || !bill) {
    return (
      <div className="p-4">
        <div className="mb-3 text-red-600 text-sm">{error || 'Purchase not found'}</div>
        <Link href="/purchases" className="text-blue-600 hover:underline text-sm">← Back to Purchases</Link>
      </div>
    )
  }

  return (
    <>
      {printOpen && mounted && createPortal(
        <PurchasePrintTemplate shop={shop} bill={bill} items={items} />,
        document.body
      )}

      <div className="p-4 no-print">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Purchase {bill.bill_no}</h1>
            <div className="text-sm text-gray-500 mt-0.5">
              {new Date(bill.date + 'T00:00:00').toLocaleDateString('en-IN')}
            </div>
            <div className="text-sm text-gray-600 mt-1">
              Supplier: {bill.suppliers?.name || '—'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-500">Total</div>
            <div className="text-xl font-bold text-blue-700">{fmt(bill.total)}</div>
            <div className="text-xs text-gray-500 capitalize mt-1">
              {bill.payment_mode || '—'} · {bill.payment_status || '—'}
            </div>
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={handlePrint} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Print</button>
              <Link href={`/purchases/new?editId=${bill.id}`} className="px-3 py-1.5 text-xs bg-amber-500 text-white rounded hover:bg-amber-600">Edit</Link>
              <button onClick={handleDelete} disabled={deleting} className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-xs text-gray-500">
                {['#', 'Product', 'HSN', 'Qty', 'Unit', 'Rate', 'MRP', 'GST%', 'GST', 'Amount'].map(h => (
                  <th key={h} className="px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-4 text-center text-gray-400">No line items found</td></tr>
              ) : (
                items.map((it, idx) => (
                  <tr key={it.id || idx} className="border-b last:border-b-0">
                    <td className="px-3 py-2">{it.sl_no || idx + 1}</td>
                    <td className="px-3 py-2 font-medium">{it.product_name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{it.hsn_code || '—'}</td>
                    <td className="px-3 py-2">{it.quantity}</td>
                    <td className="px-3 py-2">{it.unit || 'pcs'}</td>
                    <td className="px-3 py-2">{fmt(it.rate)}</td>
                    <td className="px-3 py-2">{fmt(it.mrp)}</td>
                    <td className="px-3 py-2">{it.gst_rate}%</td>
                    <td className="px-3 py-2">{fmt(it.gst_amount)}</td>
                    <td className="px-3 py-2 font-medium">{fmt(it.total)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function PurchasePrintTemplate({ shop, bill, items }) {
  const subtotal = Number(bill.subtotal || 0)
  const gst = Number(bill.gst_amount || 0)
  const total = Number(bill.total || 0)

  return (
    <div className="print-only">
      <div className="invoice">
        <div className="inv-header">
          <div className="inv-shop">
            <h1>{shop?.name || 'My Shop'}</h1>
            {shop?.address && <p>{shop.address}</p>}
            {(shop?.city || shop?.state) && <p>{[shop?.city, shop?.state, shop?.pincode].filter(Boolean).join(', ')}</p>}
            {shop?.phone && <p>Ph: {shop.phone}</p>}
          </div>
          <div className="inv-meta">
            <h2>PURCHASE ENTRY</h2>
            <table><tbody>
              <tr><td>Bill No</td><td><strong>{bill.bill_no}</strong></td></tr>
              <tr><td>Date</td><td>{new Date(bill.date + 'T00:00:00').toLocaleDateString('en-IN')}</td></tr>
            </tbody></table>
          </div>
        </div>

        <div className="inv-customer">
          <strong>Supplier: </strong>{bill.suppliers?.name || '—'}
          {bill.supplier_invoice_no && <> | Inv#: {bill.supplier_invoice_no}</>}
        </div>

        <table className="inv-table">
          <thead>
            <tr>
              <th>#</th><th>Description</th><th className="tc">HSN</th><th className="tc">Qty</th>
              <th className="tc">Unit</th><th className="tr">Rate</th><th className="tr">MRP</th><th className="tc">GST%</th><th className="tr">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id || i}>
                <td className="tc">{it.sl_no || i + 1}</td>
                <td>{it.product_name}</td>
                <td className="tc">{it.hsn_code || '—'}</td>
                <td className="tc">{it.quantity}</td>
                <td className="tc">{it.unit || 'pcs'}</td>
                <td className="tr">{Number(it.rate || 0).toFixed(2)}</td>
                <td className="tr">{Number(it.mrp || 0).toFixed(2)}</td>
                <td className="tc">{it.gst_rate}%</td>
                <td className="tr">{Number(it.total || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="inv-amount-box" style={{ marginTop: 12, marginLeft: 'auto' }}>
          <div className="row"><span>Subtotal</span><span>{subtotal.toFixed(2)}</span></div>
          <div className="row"><span>GST</span><span>{gst.toFixed(2)}</span></div>
          <div className="row grand"><span>TOTAL</span><span>{total.toFixed(2)}</span></div>
        </div>
      </div>
    </div>
  )
}
