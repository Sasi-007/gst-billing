'use client'

import { fmt, numToWords } from '@/lib/gst'

/**
 * Hidden on screen (print-only).  window.print() reveals it.
 */
export default function PrintTemplate({ data }) {
  if (!data) return null
  const { bill, items, totals } = data
  // Accept either `shop` (new multi-tenant) or `settings` (legacy)
  const s = data.shop || data.settings || {}
  // Include both inventory-linked items and free-text line items
  const billItems = items.filter(i => i.product_name)

  const isInvoice = bill.bill_type === 'invoice'
  const title =
    bill.bill_type === 'quotation' ? 'QUOTATION'
    : bill.bill_type === 'estimate' ? 'ESTIMATE'
    : 'TAX INVOICE'

  // CGST/SGST split (intra-state)
  const halfGst = totals.gstAmount / 2

  return (
    <div className="print-only">
      <div className="invoice">

        {/* ── Header ──────────────────────────────────── */}
        <div className="inv-header">
          <div className="inv-shop">
            <h1>{s?.name || s?.shop_name || 'My Shop'}</h1>
            {s?.address && <p>{s.address}</p>}
            {(s?.city || s?.state) && (
              <p>{[s?.city, s?.state, s?.pincode].filter(Boolean).join(', ')}</p>
            )}
            {s?.phone && <p>Ph: {s.phone}</p>}
            {s?.email && <p>Email: {s.email}</p>}
            {s?.gstin && <p>GSTIN: <strong>{s.gstin}</strong></p>}
          </div>

          <div className="inv-meta">
            <h2>{title}</h2>
            <table>
              <tbody>
                <tr><td>Bill No</td><td><strong>{bill.bill_no}</strong></td></tr>
                <tr>
                  <td>Date</td>
                  <td>{new Date(bill.date + 'T00:00:00').toLocaleDateString('en-IN', {
                    day: '2-digit', month: 'short', year: 'numeric'
                  })}</td>
                </tr>
                {bill.payment_mode && isInvoice && (
                  <tr><td>Payment</td><td style={{ textTransform: 'capitalize' }}>{bill.payment_mode}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Customer ────────────────────────────────── */}
        {(bill.customer_name || bill.customer_gstin) && (
          <div className="inv-customer">
            <strong>Bill To: </strong>
            {bill.customer_name}
            {bill.customer_phone && ` | Ph: ${bill.customer_phone}`}
            {bill.customer_gstin && (
              <> | GSTIN: <strong>{bill.customer_gstin}</strong></>
            )}
            {bill.customer_address && <><br />{bill.customer_address}</>}
          </div>
        )}

        {/* ── Items ───────────────────────────────────── */}
        <table className="inv-table">
          <thead>
            <tr>
              <th style={{ width: '28px' }}>#</th>
              <th>Description of Goods</th>
              <th className="tc" style={{ width: '50px' }}>HSN</th>
              <th className="tc" style={{ width: '40px' }}>Qty</th>
              <th className="tc" style={{ width: '35px' }}>Unit</th>
              <th className="tr" style={{ width: '65px' }}>Rate ₹</th>
              <th className="tc" style={{ width: '38px' }}>GST%</th>
              <th className="tr" style={{ width: '60px' }}>GST ₹</th>
              <th className="tr" style={{ width: '70px' }}>Amount ₹</th>
            </tr>
          </thead>
          <tbody>
            {billItems.map((item, i) => (
              <tr key={i}>
                <td className="tc">{i + 1}</td>
                <td>{item.product_name}</td>
                <td className="tc">{item.hsn_code || '—'}</td>
                <td className="tc">{item.quantity}</td>
                <td className="tc">{item.unit}</td>
                <td className="tr">{Number(item.rate).toFixed(2)}</td>
                <td className="tc">{item.gst_rate}%</td>
                <td className="tr">{Number(item.gst_amount).toFixed(2)}</td>
                <td className="tr">{Number(item.total).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Totals section ──────────────────────────── */}
        <div className="inv-totals">
          {/* Tax summary table */}
          <div className="inv-tax-summary">
            <strong>Tax Summary</strong>
            <table>
              <thead>
                <tr>
                  <th>GST Rate</th>
                  <th>Taxable Amt</th>
                  <th>CGST</th>
                  <th>SGST</th>
                  <th>Total Tax</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(totals.gstBreakdown || {})
                  .filter(([, d]) => d.gst > 0)
                  .map(([rate, d]) => (
                    <tr key={rate}>
                      <td style={{ textAlign: 'center' }}>{rate}%</td>
                      <td>{d.base.toFixed(2)}</td>
                      <td>{(d.gst / 2).toFixed(2)}</td>
                      <td>{(d.gst / 2).toFixed(2)}</td>
                      <td>{d.gst.toFixed(2)}</td>
                    </tr>
                  ))}
                {/* zero-rate row */}
                {totals.gstBreakdown?.['0'] && (
                  <tr>
                    <td style={{ textAlign: 'center' }}>0%</td>
                    <td>{totals.gstBreakdown['0'].base.toFixed(2)}</td>
                    <td>0.00</td><td>0.00</td><td>0.00</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Amount box */}
          <div className="inv-amount-box">
            <div className="row"><span>Subtotal (excl. GST)</span><span>{totals.subtotal.toFixed(2)}</span></div>
            {totals.discountAmount > 0 && (
              <div className="row"><span>Discount</span><span>- {totals.discountAmount.toFixed(2)}</span></div>
            )}
            {halfGst > 0 && (
              <>
                <div className="row"><span>CGST</span><span>{halfGst.toFixed(2)}</span></div>
                <div className="row"><span>SGST</span><span>{halfGst.toFixed(2)}</span></div>
              </>
            )}
            <div className="row grand">
              <span>TOTAL</span>
              <span>{totals.total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Amount in words */}
        <div className="inv-words">
          Amount in words: <em>{numToWords(totals.total)}</em>
        </div>

        {bill.notes && <div className="inv-notes">Note: {bill.notes}</div>}

      </div>
    </div>
  )
}
