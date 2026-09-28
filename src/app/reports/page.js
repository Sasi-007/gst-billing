'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
import { fmt } from '../../lib/gst'
import { calculateCreditBalance, formatSettlementLabel, groupCreditEntriesByAccount } from '../../lib/credits'
import { monthStartStr, todayStr } from '../../lib/finance'
import { readPageCache, writePageCache } from '../../lib/pageCache'
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import { usePageLoadingState } from '../../context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

function num(value) {
  return Number(value) || 0
}

function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100
}

function taxableValue(item) {
  return round2(num(item.taxable_amount) || num(item.base_rate) * num(item.quantity))
}

function cgstValue(item) {
  return round2(num(item.cgst_amount) || (num(item.igst_amount) ? 0 : num(item.gst_amount) / 2))
}

function sgstValue(item) {
  return round2(num(item.sgst_amount) || (num(item.igst_amount) ? 0 : num(item.gst_amount) / 2))
}

function igstValue(item) {
  return round2(num(item.igst_amount))
}

function formatReportDate(date) {
  return date ? new Date(date + 'T00:00:00').toLocaleDateString('en-IN') : ''
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

// ── Sales Summary ──────────────────────────────────────────────────────────
function SalesSummary({ data, searchTerm }) {
  const bills = Array.isArray(data) ? data : []
  const term = (searchTerm || '').trim().toLowerCase()
  const visible = term
    ? bills.filter(b =>
      String(b.bill_no || '').toLowerCase().includes(term) ||
      String(b.customer_name || '').toLowerCase().includes(term)
    )
    : bills
  const total    = visible.reduce((s, b) => s + (b.total || 0), 0)
  const gst      = visible.reduce((s, b) => s + (b.gst_amount || 0), 0)
  const subtotal = visible.reduce((s, b) => s + (b.subtotal || 0), 0)
  const discount = visible.reduce((s, b) => s + (b.discount_amount || 0), 0)

  return (
    <>
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label:'Total Sales', value: fmt(total),    cls:'text-blue-700' },
          { label:'Taxable Amt', value: fmt(subtotal), cls:'text-gray-700' },
          { label:'Total GST',   value: fmt(gst),      cls:'text-orange-700' },
          { label:'Discounts',   value: fmt(discount), cls:'text-red-700' },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-xl font-bold mt-1 ${c.cls}`}>{c.value}</div>
            <div className="text-xs text-gray-400">{visible.length} bills</div>
          </div>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No invoices found for this period</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['Date','Bill No','Customer','Subtotal','GST','Total','Mode','Status'].map(h => (
                  <th key={h} className="px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(b => (
                <tr key={b.id} className="border-b hover:bg-gray-50 text-sm">
                  <td className="px-3 py-1.5">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                  <td className="px-3 py-1.5 font-mono font-medium">
                    <Link href={`/billing/${b.id}`} className="text-blue-700 hover:underline">
                      {b.bill_no}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-gray-600">{b.customer_name || '—'}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(b.subtotal)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(b.gst_amount)}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{fmt(b.total)}</td>
                  <td className="px-3 py-1.5 capitalize text-gray-500">{b.payment_mode}</td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      b.payment_status === 'paid' ? 'bg-green-100 text-green-700'
                      : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                      : 'bg-red-100 text-red-700'
                    }`}>{b.payment_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ── GST Summary ────────────────────────────────────────────────────────────
function GSTSummary({ data }) {
  if (!data?.sales) return <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No GST data found</div>
  const gstMap = {}

  data.sales.forEach(i => {
    const r = String(i.gst_rate || 0)
    if (!gstMap[r]) gstMap[r] = { outward_base:0, outward_gst:0, inward_base:0, inward_gst:0 }
    gstMap[r].outward_base += (parseFloat(i.base_rate) || 0) * (parseFloat(i.quantity) || 0)
    gstMap[r].outward_gst  += parseFloat(i.gst_amount)  || 0
  })
  data.purchases.forEach(i => {
    const r = String(i.gst_rate || 0)
    if (!gstMap[r]) gstMap[r] = { outward_base:0, outward_gst:0, inward_base:0, inward_gst:0 }
    gstMap[r].inward_base += (parseFloat(i.base_rate) || 0) * (parseFloat(i.quantity) || 0)
    gstMap[r].inward_gst  += parseFloat(i.gst_amount)  || 0
  })

  const rows = Object.entries(gstMap).sort((a,b) => parseFloat(a[0])-parseFloat(b[0]))
  const totOut = rows.reduce((s,[,d]) => s + d.outward_gst, 0)
  const totIn  = rows.reduce((s,[,d]) => s + d.inward_gst,  0)
  const netGST = totOut - totIn

  if (rows.length === 0) return <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No GST transactions found for this period</div>

  return (
    <div className="bg-white rounded-xl border overflow-x-auto">
      <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">
        GST Summary (outward − inward = net payable)
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-xs text-gray-500 border-b">
            {['GST Rate','Outward Taxable','Out CGST','Out SGST','Out GST','In Taxable','In GST','Net GST'].map(h => (
              <th key={h} className="px-3 py-2 text-right first:text-center">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([rate, d]) => (
            <tr key={rate} className="border-b hover:bg-gray-50">
              <td className="px-3 py-1.5 text-center font-medium">{rate}%</td>
              <td className="px-3 py-1.5 text-right">{fmt(d.outward_base)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(d.outward_gst/2)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(d.outward_gst/2)}</td>
              <td className="px-3 py-1.5 text-right font-medium">{fmt(d.outward_gst)}</td>
              <td className="px-3 py-1.5 text-right text-blue-600">{fmt(d.inward_base)}</td>
              <td className="px-3 py-1.5 text-right text-blue-600">{fmt(d.inward_gst)}</td>
              <td className={`px-3 py-1.5 text-right font-semibold ${d.outward_gst-d.inward_gst>0?'text-orange-600':'text-green-600'}`}>
                {fmt(d.outward_gst - d.inward_gst)}
              </td>
            </tr>
          ))}
          <tr className="bg-gray-50 font-bold border-t-2">
            <td className="px-3 py-2 text-center">Total</td>
            <td colSpan={3}></td>
            <td className="px-3 py-2 text-right">{fmt(totOut)}</td>
            <td></td>
            <td className="px-3 py-2 text-right text-blue-700">{fmt(totIn)}</td>
            <td className={`px-3 py-2 text-right ${netGST>0?'text-orange-700':'text-green-700'}`}>{fmt(netGST)}</td>
          </tr>
        </tbody>
      </table>
      <div className="px-4 py-2 text-xs text-gray-400">
        Net GST payable to government = Output GST − Input GST credit
      </div>
    </div>
  )
}

function GSTAuditorReport({ data, dateFrom, dateTo }) {
  const salesBills = Array.isArray(data?.salesBills) ? data.salesBills : []
  const purchaseBills = Array.isArray(data?.purchaseBills) ? data.purchaseBills : []
  const salesItems = Array.isArray(data?.salesItems) ? data.salesItems : []
  const purchaseItems = Array.isArray(data?.purchaseItems) ? data.purchaseItems : []
  const expenses = Array.isArray(data?.expenses) ? data.expenses : []

  const taxMap = {}
  const hsnMap = {}

  salesItems.forEach((item) => {
    const rate = String(item.gst_rate || 0)
    if (!taxMap[rate]) taxMap[rate] = { rate, outwardTaxable: 0, outwardGst: 0, inwardTaxable: 0, inwardGst: 0 }
    taxMap[rate].outwardTaxable += taxableValue(item)
    taxMap[rate].outwardGst += num(item.gst_amount)

    const hsn = item.hsn_code || 'Unclassified'
    const key = `${hsn}:${rate}`
    if (!hsnMap[key]) hsnMap[key] = { hsn, rate, quantity: 0, taxable: 0, gst: 0, total: 0 }
    hsnMap[key].quantity += num(item.quantity)
    hsnMap[key].taxable += taxableValue(item)
    hsnMap[key].gst += num(item.gst_amount)
    hsnMap[key].total += num(item.total)
  })

  purchaseItems.forEach((item) => {
    const rate = String(item.gst_rate || 0)
    if (!taxMap[rate]) taxMap[rate] = { rate, outwardTaxable: 0, outwardGst: 0, inwardTaxable: 0, inwardGst: 0 }
    taxMap[rate].inwardTaxable += taxableValue(item)
    taxMap[rate].inwardGst += num(item.gst_amount)
  })

  const taxRows = Object.values(taxMap).sort((a, b) => num(a.rate) - num(b.rate))
  const hsnRows = Object.values(hsnMap).sort((a, b) => String(a.hsn).localeCompare(String(b.hsn)) || num(a.rate) - num(b.rate))
  const totalSales = salesBills.reduce((sum, bill) => sum + num(bill.total), 0)
  const totalPurchases = purchaseBills.reduce((sum, bill) => sum + num(bill.total), 0)
  const outputGst = salesItems.reduce((sum, item) => sum + num(item.gst_amount), 0)
  const inputGst = purchaseItems.reduce((sum, item) => sum + num(item.gst_amount), 0)
  const netPayable = outputGst - inputGst
  const b2bSalesBills = salesBills.filter((bill) => !!String(bill.customer_gstin || '').trim())
  const b2cSalesBills = salesBills.filter((bill) => !String(bill.customer_gstin || '').trim())
  const salesBillById = Object.fromEntries(salesBills.map((bill) => [bill.id, bill]))
  const purchaseBillById = Object.fromEntries(purchaseBills.map((bill) => [bill.id, bill]))
  const b2cBillIdSet = new Set(b2cSalesBills.map((bill) => bill.id))
  const b2cSummaryMap = {}

  const salesRegisterRows = salesBills.map((bill) => ({
    Date: formatReportDate(bill.date),
    'Invoice No': bill.bill_no,
    Customer: bill.customer_name || 'B2C Customer',
    GSTIN: bill.customer_gstin || '',
    Type: bill.customer_gstin ? 'B2B' : 'B2C',
    'Taxable Value': round2(num(bill.subtotal)),
    CGST: round2(num(bill.cgst_amount) || num(bill.gst_amount) / 2),
    SGST: round2(num(bill.sgst_amount) || num(bill.gst_amount) / 2),
    IGST: round2(num(bill.igst_amount)),
    'Total GST': round2(num(bill.gst_amount)),
    'Invoice Total': round2(num(bill.total)),
    'Payment Status': bill.payment_status || '',
  }))
  const b2bRegisterRows = salesRegisterRows.filter((row) => row.Type === 'B2B')
  const b2cRegisterRows = salesRegisterRows.filter((row) => row.Type === 'B2C')

  const purchaseRegisterRows = purchaseBills.map((bill) => ({
    Date: formatReportDate(bill.date),
    'Purchase No': bill.bill_no,
    'Supplier Invoice No': bill.supplier_invoice_no || '',
    Supplier: bill.suppliers?.name || '',
    'Supplier GSTIN': bill.suppliers?.gstin || '',
    Interstate: bill.is_interstate ? 'Yes' : 'No',
    'Taxable Value': round2(num(bill.subtotal)),
    CGST: bill.is_interstate ? 0 : round2(num(bill.gst_amount) / 2),
    SGST: bill.is_interstate ? 0 : round2(num(bill.gst_amount) / 2),
    IGST: bill.is_interstate ? round2(num(bill.gst_amount)) : 0,
    'Input GST': round2(num(bill.gst_amount)),
    'Invoice Total': round2(num(bill.total)),
    'Payment Status': bill.payment_status || '',
  }))

  const salesItemRows = salesItems.map((item) => {
    const bill = salesBillById[item.bill_id] || {}
    return {
      Date: formatReportDate(bill.date),
      'Invoice No': bill.bill_no || '',
      Customer: bill.customer_name || 'B2C Customer',
      GSTIN: bill.customer_gstin || '',
      Product: item.product_name || '',
      HSN: item.hsn_code || '',
      Quantity: round2(num(item.quantity)),
      'GST Rate': `${item.gst_rate || 0}%`,
      'Taxable Value': taxableValue(item),
      CGST: round2(num(item.gst_amount) / 2),
      SGST: round2(num(item.gst_amount) / 2),
      IGST: 0,
      'Total GST': round2(num(item.gst_amount)),
      'Line Total': round2(num(item.total)),
    }
  })

  salesItems.forEach((item) => {
    if (!b2cBillIdSet.has(item.bill_id)) return
    const rate = String(item.gst_rate || 0)
    if (!b2cSummaryMap[rate]) b2cSummaryMap[rate] = { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, total: 0 }
    b2cSummaryMap[rate].taxable += taxableValue(item)
    b2cSummaryMap[rate].cgst += round2(num(item.gst_amount) / 2)
    b2cSummaryMap[rate].sgst += round2(num(item.gst_amount) / 2)
    b2cSummaryMap[rate].gst += num(item.gst_amount)
    b2cSummaryMap[rate].total += num(item.total)
  })

  const b2cSummaryRows = Object.values(b2cSummaryMap)
    .sort((a, b) => num(a.rate) - num(b.rate))
    .map((row) => ({
      'GST Rate': `${row.rate}%`,
      'Taxable Value': round2(row.taxable),
      CGST: round2(row.cgst),
      SGST: round2(row.sgst),
      IGST: round2(row.igst),
      'Total GST': round2(row.gst),
      'Sales Value': round2(row.total),
    }))

  const purchaseItemRows = purchaseItems.map((item) => {
    const bill = purchaseBillById[item.purchase_bill_id] || {}
    return {
      Date: formatReportDate(bill.date),
      'Purchase No': bill.bill_no || '',
      'Supplier Invoice No': bill.supplier_invoice_no || '',
      Supplier: bill.suppliers?.name || '',
      'Supplier GSTIN': bill.suppliers?.gstin || '',
      Product: item.product_name || '',
      HSN: item.hsn_code || '',
      Quantity: round2(num(item.quantity)),
      'GST Rate': `${item.gst_rate || 0}%`,
      'Taxable Value': taxableValue(item),
      CGST: cgstValue(item),
      SGST: sgstValue(item),
      IGST: igstValue(item),
      'Input GST': round2(num(item.gst_amount)),
      'Line Total': round2(num(item.total)),
    }
  })

  const taxSummaryRows = taxRows.map((row) => ({
    'GST Rate': `${row.rate}%`,
    'Outward Taxable': round2(row.outwardTaxable),
    'Outward CGST': round2(row.outwardGst / 2),
    'Outward SGST': round2(row.outwardGst / 2),
    'Outward GST': round2(row.outwardGst),
    'Inward Taxable': round2(row.inwardTaxable),
    'Input GST': round2(row.inwardGst),
    'Net GST Payable': round2(row.outwardGst - row.inwardGst),
  }))

  const hsnSummaryRows = hsnRows.map((row) => ({
    HSN: row.hsn,
    'GST Rate': `${row.rate}%`,
    Quantity: round2(row.quantity),
    'Taxable Value': round2(row.taxable),
    GST: round2(row.gst),
    'Sales Value': round2(row.total),
  }))

  const expenseRows = expenses.map((expense) => ({
    Date: formatReportDate(expense.expense_date),
    Title: expense.title,
    Category: expense.category || '',
    Amount: round2(expense.amount),
    'Payment Mode': expense.payment_mode || '',
    Notes: expense.notes || '',
  }))

  const prefix = `gst-auditor-${dateFrom}-to-${dateTo}`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Sales Turnover', value: fmt(totalSales), cls: 'text-blue-700' },
          { label: 'Purchase Value', value: fmt(totalPurchases), cls: 'text-purple-700' },
          { label: 'Output GST', value: fmt(outputGst), cls: 'text-orange-700' },
          { label: 'Net GST Payable', value: fmt(netPayable), cls: netPayable > 0 ? 'text-red-700' : 'text-green-700' },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className={`text-xl font-bold mt-1 ${card.cls}`}>{card.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">B2C Invoices</div>
          <div className="text-xl font-bold mt-1 text-green-700">{b2cSalesBills.length}</div>
          <div className="text-xs text-gray-400">{fmt(b2cSalesBills.reduce((sum, bill) => sum + num(bill.total), 0))}</div>
        </div>
        <div className="bg-white border rounded-lg p-3">
          <div className="text-xs text-gray-500">B2B Invoices</div>
          <div className="text-xl font-bold mt-1 text-indigo-700">{b2bSalesBills.length}</div>
          <div className="text-xs text-gray-400">{fmt(b2bSalesBills.reduce((sum, bill) => sum + num(bill.total), 0))}</div>
        </div>
      </div>

      <div className="bg-white rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-gray-800">GST Auditor Export</div>
            <div className="text-xs text-gray-500 mt-1">
              B2C/B2B exports are enabled automatically from billing: invoice with GSTIN = B2B, without GSTIN = B2C.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => downloadCsv(`${prefix}-sales-register.csv`, Object.keys(salesRegisterRows[0] || {
              Date: '', 'Invoice No': '', Customer: '', GSTIN: '', Type: '', 'Taxable Value': '', CGST: '', SGST: '', IGST: '', 'Total GST': '', 'Invoice Total': '', 'Payment Status': '',
            }), salesRegisterRows)} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700">Sales CSV</button>
            {b2cRegisterRows.length > 0 && (
              <button type="button" onClick={() => downloadCsv(`${prefix}-b2c-sales-register.csv`, Object.keys(b2cRegisterRows[0]), b2cRegisterRows)} className="px-3 py-2 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700">B2C Sales CSV</button>
            )}
            {b2cSummaryRows.length > 0 && (
              <button type="button" onClick={() => downloadCsv(`${prefix}-b2c-summary.csv`, Object.keys(b2cSummaryRows[0]), b2cSummaryRows)} className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700">B2C Summary CSV</button>
            )}
            {b2bRegisterRows.length > 0 && (
              <button type="button" onClick={() => downloadCsv(`${prefix}-b2b-sales-register.csv`, Object.keys(b2bRegisterRows[0]), b2bRegisterRows)} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700">B2B Sales CSV</button>
            )}
            {salesBills.length > 0 && (
              <Link href={`/reports/invoice-pack?dateFrom=${dateFrom}&dateTo=${dateTo}`} className="px-3 py-2 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700">
                Merged Invoice PDF
              </Link>
            )}
            <button type="button" onClick={() => downloadCsv(`${prefix}-purchase-register.csv`, Object.keys(purchaseRegisterRows[0] || {
              Date: '', 'Purchase No': '', 'Supplier Invoice No': '', Supplier: '', 'Supplier GSTIN': '', Interstate: '', 'Taxable Value': '', CGST: '', SGST: '', IGST: '', 'Input GST': '', 'Invoice Total': '', 'Payment Status': '',
            }), purchaseRegisterRows)} className="px-3 py-2 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700">Purchases CSV</button>
            <button type="button" onClick={() => downloadCsv(`${prefix}-sales-items.csv`, Object.keys(salesItemRows[0] || {
              Date: '', 'Invoice No': '', Customer: '', GSTIN: '', Product: '', HSN: '', Quantity: '', 'GST Rate': '', 'Taxable Value': '', CGST: '', SGST: '', IGST: '', 'Total GST': '', 'Line Total': '',
            }), salesItemRows)} className="px-3 py-2 bg-sky-600 text-white rounded-lg text-xs font-medium hover:bg-sky-700">Sales Items CSV</button>
            <button type="button" onClick={() => downloadCsv(`${prefix}-purchase-items.csv`, Object.keys(purchaseItemRows[0] || {
              Date: '', 'Purchase No': '', 'Supplier Invoice No': '', Supplier: '', 'Supplier GSTIN': '', Product: '', HSN: '', Quantity: '', 'GST Rate': '', 'Taxable Value': '', CGST: '', SGST: '', IGST: '', 'Input GST': '', 'Line Total': '',
            }), purchaseItemRows)} className="px-3 py-2 bg-fuchsia-600 text-white rounded-lg text-xs font-medium hover:bg-fuchsia-700">Purchase Items CSV</button>
            <button type="button" onClick={() => downloadCsv(`${prefix}-tax-summary.csv`, Object.keys(taxSummaryRows[0] || {
              'GST Rate': '', 'Outward Taxable': '', 'Outward CGST': '', 'Outward SGST': '', 'Outward GST': '', 'Inward Taxable': '', 'Input GST': '', 'Net GST Payable': '',
            }), taxSummaryRows)} className="px-3 py-2 bg-orange-600 text-white rounded-lg text-xs font-medium hover:bg-orange-700">Tax Summary CSV</button>
            <button type="button" onClick={() => downloadCsv(`${prefix}-hsn-summary.csv`, Object.keys(hsnSummaryRows[0] || {
              HSN: '', 'GST Rate': '', Quantity: '', 'Taxable Value': '', GST: '', 'Sales Value': '',
            }), hsnSummaryRows)} className="px-3 py-2 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700">HSN CSV</button>
            <button type="button" onClick={() => downloadCsv(`${prefix}-expenses.csv`, Object.keys(expenseRows[0] || {
              Date: '', Title: '', Category: '', Amount: '', 'Payment Mode': '', Notes: '',
            }), expenseRows)} className="px-3 py-2 bg-gray-700 text-white rounded-lg text-xs font-medium hover:bg-gray-800">Expenses CSV</button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">GST Rate Summary</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              {['GST Rate', 'Outward Taxable', 'Outward GST', 'Inward Taxable', 'Input GST', 'Net GST'].map((h) => (
                <th key={h} className="px-3 py-2 text-right first:text-center">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {taxRows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No GST transactions found for this period</td></tr>
            ) : taxRows.map((row) => (
              <tr key={row.rate} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5 text-center font-medium">{row.rate}%</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.outwardTaxable)}</td>
                <td className="px-3 py-1.5 text-right text-orange-700">{fmt(row.outwardGst)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.inwardTaxable)}</td>
                <td className="px-3 py-1.5 text-right text-blue-700">{fmt(row.inwardGst)}</td>
                <td className={`px-3 py-1.5 text-right font-semibold ${row.outwardGst - row.inwardGst > 0 ? 'text-red-700' : 'text-green-700'}`}>{fmt(row.outwardGst - row.inwardGst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">B2C Sales Summary</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              {['GST Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total GST', 'Sales Value'].map((h) => (
                <th key={h} className="px-3 py-2 text-right first:text-center">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b2cSummaryRows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No B2C invoices found for this period</td></tr>
            ) : b2cSummaryRows.map((row) => (
              <tr key={row['GST Rate']} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5 text-center font-medium">{row['GST Rate']}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row['Taxable Value'])}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.CGST)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.SGST)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.IGST)}</td>
                <td className="px-3 py-1.5 text-right text-orange-700">{fmt(row['Total GST'])}</td>
                <td className="px-3 py-1.5 text-right font-medium">{fmt(row['Sales Value'])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <div className="px-4 py-3 border-b text-sm font-medium text-gray-700">HSN Sales Summary</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              {['HSN', 'GST Rate', 'Qty', 'Taxable', 'GST', 'Sales Value'].map((h) => (
                <th key={h} className={`px-3 py-2 ${h === 'HSN' ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hsnRows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No HSN sales found for this period</td></tr>
            ) : hsnRows.map((row) => (
              <tr key={`${row.hsn}-${row.rate}`} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5 font-medium">{row.hsn}</td>
                <td className="px-3 py-1.5 text-right">{row.rate}%</td>
                <td className="px-3 py-1.5 text-right">{round2(row.quantity)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.taxable)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.gst)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{fmt(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
        ITC is shown from entered GST purchase bills. Final ITC should still be reconciled by the auditor with GSTR-2B on the GST portal.
      </div>
    </div>
  )
}

// ── Top Products ──────────────────────────────────────────────────────────
function TopProducts({ data }) {
  const products = Array.isArray(data) ? data : []
  if (products.length === 0) return <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No sales data found for this period</div>
  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-xs text-gray-500 border-b">
            <th className="px-3 py-2 text-left">#</th>
            <th className="px-3 py-2 text-left">Product</th>
            <th className="px-3 py-2 text-right">Qty Sold</th>
            <th className="px-3 py-2 text-right">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p, i) => (
            <tr key={p.name} className="border-b hover:bg-gray-50">
              <td className="px-3 py-1.5 text-gray-400">{i+1}</td>
              <td className="px-3 py-1.5 font-medium">{p.name}</td>
              <td className="px-3 py-1.5 text-right">{Number(p.qty).toFixed(2)}</td>
              <td className="px-3 py-1.5 text-right font-medium text-blue-700">{fmt(p.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CreditSummary({ data, searchTerm }) {
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []
  const allEntriesByAccount = groupCreditEntriesByAccount(data?.allEntries || [])
  const periodEntriesByAccount = groupCreditEntriesByAccount(data?.periodEntries || [])
  const term = (searchTerm || '').trim().toLowerCase()

  const visible = accounts
    .map((account) => {
      const currentBalance = calculateCreditBalance(account, allEntriesByAccount[account.id] || [])
      const periodEntries = periodEntriesByAccount[account.id] || []
      const increased = periodEntries.reduce(
        (sum, entry) => sum + (entry.direction === 'increase' ? Number(entry.amount || 0) : 0),
        0
      )
      const decreased = periodEntries.reduce(
        (sum, entry) => sum + (entry.direction === 'decrease' ? Number(entry.amount || 0) : 0),
        0
      )

      return {
        ...account,
        currentBalance,
        periodEntriesCount: periodEntries.length,
        periodIncreased: increased,
        periodDecreased: decreased,
      }
    })
    .filter((account) => {
      if (!term) return true
      return (
        String(account.party_name || '').toLowerCase().includes(term) ||
        String(account.phone || '').toLowerCase().includes(term)
      )
    })
    .sort((a, b) => Math.abs(b.currentBalance) - Math.abs(a.currentBalance))

  const receivable = visible
    .filter((account) => account.relation_type === 'borrower')
    .reduce((sum, account) => sum + Math.max(0, account.currentBalance), 0)
  const payable = visible
    .filter((account) => account.relation_type === 'lender')
    .reduce((sum, account) => sum + Math.max(0, account.currentBalance), 0)
  const periodIn = visible.reduce((sum, account) => sum + account.periodIncreased, 0)
  const periodOut = visible.reduce((sum, account) => sum + account.periodDecreased, 0)
  const customerAccounts = visible.filter((account) => account.relation_type === 'borrower')
  const supplierAccounts = visible.filter((account) => account.relation_type === 'lender')

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Credit Accounts', value: visible.length, cls: 'text-gray-700' },
          { label: 'To Collect', value: fmt(receivable), cls: 'text-cyan-700' },
          { label: 'To Pay', value: fmt(payable), cls: 'text-purple-700' },
          { label: 'Period Entries', value: visible.reduce((sum, account) => sum + account.periodEntriesCount, 0), cls: 'text-orange-700' },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className={`text-xl font-bold mt-1 ${card.cls}`}>{card.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-cyan-50 border rounded-lg p-3">
          <div className="text-xs text-cyan-700">Period Increase</div>
          <div className="text-lg font-bold text-cyan-800 mt-1">{fmt(periodIn)}</div>
        </div>
        <div className="bg-green-50 border rounded-lg p-3">
          <div className="text-xs text-green-700">Period Collection / Repayment</div>
          <div className="text-lg font-bold text-green-800 mt-1">{fmt(periodOut)}</div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No credit accounts found for this selection</div>
      ) : (
        <div className="space-y-4">
          <CreditReportSection
            title="Customers who owe us"
            subtitle="Shop gave credit and needs to collect back"
            accounts={customerAccounts}
            amountClassName="text-cyan-700"
            inLabel="Credit Given"
            outLabel="Collected"
          />
          <CreditReportSection
            title="Suppliers / agencies we owe"
            subtitle="Shop took credit and needs to repay"
            accounts={supplierAccounts}
            amountClassName="text-purple-700"
            inLabel="Borrowed More"
            outLabel="Repaid"
          />
          <div className="text-right">
            <Link href="/credits" className="text-xs text-blue-600 hover:underline">Open Credit Book</Link>
          </div>
        </div>
      )}
    </>
  )
}

function CreditReportSection({ title, subtitle, accounts, amountClassName, inLabel, outLabel }) {
  return (
    <div className="bg-white rounded-xl border overflow-x-auto">
      <div className="px-4 py-3 border-b">
        <div className="text-sm font-medium text-gray-700">{title}</div>
        <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>
      </div>
      {accounts.length === 0 ? (
        <div className="p-6 text-sm text-gray-400 text-center">No accounts in this section</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 border-b">
              {['Party', 'Phone', 'Settlement', 'Current Balance', inLabel, outLabel, 'Entries', 'Status'].map((h) => (
                <th key={h} className={`px-3 py-2 ${['Current Balance', inLabel, outLabel, 'Entries'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id} className="border-b hover:bg-gray-50">
                <td className="px-3 py-1.5 font-medium text-gray-900">{account.party_name}</td>
                <td className="px-3 py-1.5 text-gray-500">{account.phone || '—'}</td>
                <td className="px-3 py-1.5 text-gray-500">{formatSettlementLabel(account.settlement_cycle, account.settlement_day)}</td>
                <td className={`px-3 py-1.5 text-right font-semibold ${amountClassName}`}>{fmt(account.currentBalance)}</td>
                <td className="px-3 py-1.5 text-right text-cyan-700">{fmt(account.periodIncreased)}</td>
                <td className="px-3 py-1.5 text-right text-green-700">{fmt(account.periodDecreased)}</td>
                <td className="px-3 py-1.5 text-right">{account.periodEntriesCount}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${account.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {account.is_active ? 'Active' : 'Archived'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function billStockCheckGap(row) {
  try {
    sessionStorage.setItem('prefillStockCheckItem', JSON.stringify({
      product_id: row.productId,
      product_name: row.name,
      hsn_code: row.hsn,
      unit: row.unit,
      gst_rate: row.gstRate,
      selling_price: row.sellingPrice,
      quantity: row.otherQty,
    }))
  } catch { /* sessionStorage unavailable — link still opens billing */ }
  window.open('/billing', '_blank')
}

function StockReconciliation({ data, dateFrom, dateTo }) {
  const purchaseItems = Array.isArray(data?.purchaseItems) ? data.purchaseItems : []
  const invoiceItems = Array.isArray(data?.invoiceItems) ? data.invoiceItems : []
  const otherItems = Array.isArray(data?.otherItems) ? data.otherItems : []
  const products = Array.isArray(data?.products) ? data.products : []
  const productById = Object.fromEntries(products.map((product) => [product.id, product]))

  const rowMap = {}
  function ensureRow(productId) {
    if (!rowMap[productId]) {
      const product = productById[productId] || {}
      rowMap[productId] = {
        productId,
        name: product.name || 'Unknown product',
        hsn: product.hsn_code || '',
        gstRate: num(product.gst_rate),
        unit: product.unit || 'pcs',
        sellingPrice: num(product.selling_price),
        currentStock: num(product.stock_qty),
        purchasedQty: 0,
        invoicedQty: 0,
        otherQty: 0,
      }
    }
    return rowMap[productId]
  }

  purchaseItems.forEach((item) => {
    if (!item.product_id) return
    ensureRow(item.product_id).purchasedQty += num(item.quantity)
  })
  invoiceItems.forEach((item) => {
    if (!item.product_id) return
    ensureRow(item.product_id).invoicedQty += num(item.quantity)
  })
  otherItems.forEach((item) => {
    if (!item.product_id) return
    ensureRow(item.product_id).otherQty += num(item.quantity)
  })

  const rows = Object.values(rowMap)
    .map((row) => ({ ...row, gapValue: round2(row.otherQty * row.sellingPrice) }))
    .sort((a, b) => b.otherQty - a.otherQty || b.purchasedQty - a.purchasedQty)

  const totalPurchased = rows.reduce((sum, row) => sum + row.purchasedQty, 0)
  const totalInvoiced = rows.reduce((sum, row) => sum + row.invoicedQty, 0)
  const totalGapQty = rows.reduce((sum, row) => sum + row.otherQty, 0)
  const totalGapValue = rows.reduce((sum, row) => sum + row.gapValue, 0)
  const gapRows = rows.filter((row) => row.otherQty > 0)

  const prefix = `stock-check-${dateFrom}-to-${dateTo}`
  const exportRows = rows.map((row) => ({
    Product: row.name,
    HSN: row.hsn,
    'GST Rate': `${row.gstRate}%`,
    'Purchased Qty': row.purchasedQty,
    'GST Invoiced Qty': row.invoicedQty,
    'Uninvoiced Qty': row.otherQty,
    'Est. Uninvoiced Value': row.gapValue,
    'Current Stock': row.currentStock,
  }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Purchased Qty (Period)', value: totalPurchased.toLocaleString('en-IN'), cls: 'text-purple-700' },
          { label: 'GST Invoiced Qty (Period)', value: totalInvoiced.toLocaleString('en-IN'), cls: 'text-blue-700' },
          { label: 'Uninvoiced Qty (Period)', value: totalGapQty.toLocaleString('en-IN'), cls: totalGapQty > 0 ? 'text-red-700' : 'text-green-700' },
          { label: 'Est. Uninvoiced Value', value: fmt(totalGapValue), cls: totalGapValue > 0 ? 'text-red-700' : 'text-green-700' },
        ].map((card) => (
          <div key={card.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{card.label}</div>
            <div className={`text-xl font-bold mt-1 ${card.cls}`}>{card.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
        This compares products purchased and sold in this period against GST invoices raised in the same period.
        <strong> Uninvoiced Qty</strong> is stock that left (via quotation/estimate bills or other recorded sales) without
        a matching GST invoice — likely missed small-customer bills. Current Stock is the live system stock, shown for reference only.
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b">
          <div className="text-sm font-semibold text-gray-800">Stock vs GST Invoice Coverage</div>
          <button
            type="button"
            onClick={() => downloadCsv(`${prefix}.csv`, Object.keys(exportRows[0] || {
              Product: '', HSN: '', 'GST Rate': '', 'Purchased Qty': '', 'GST Invoiced Qty': '', 'Uninvoiced Qty': '', 'Est. Uninvoiced Value': '', 'Current Stock': '',
            }), exportRows)}
            className="px-3 py-2 bg-gray-800 text-white rounded-lg text-xs font-medium hover:bg-gray-900"
          >
            Export CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['Product', 'HSN', 'GST%', 'Purchased', 'GST Invoiced', 'Uninvoiced', 'Est. Value', 'Current Stock', ''].map((h) => (
                  <th key={h} className="px-3 py-2 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">No purchase or sales activity for this period</td></tr>
              ) : rows.map((row) => (
                <tr key={row.productId} className={`border-b hover:bg-gray-50 ${row.otherQty > 0 ? 'bg-red-50' : ''}`}>
                  <td className="px-3 py-1.5 font-medium text-gray-900">{row.name}</td>
                  <td className="px-3 py-1.5 text-gray-500">{row.hsn || '—'}</td>
                  <td className="px-3 py-1.5">{row.gstRate}%</td>
                  <td className="px-3 py-1.5 text-right">{row.purchasedQty}</td>
                  <td className="px-3 py-1.5 text-right text-blue-700">{row.invoicedQty}</td>
                  <td className={`px-3 py-1.5 text-right font-semibold ${row.otherQty > 0 ? 'text-red-700' : 'text-gray-400'}`}>{row.otherQty}</td>
                  <td className="px-3 py-1.5 text-right">{row.gapValue > 0 ? fmt(row.gapValue) : '—'}</td>
                  <td className="px-3 py-1.5 text-right">{row.currentStock}</td>
                  <td className="px-3 py-1.5 text-right">
                    {row.otherQty > 0 && (
                      <button
                        type="button"
                        onClick={() => billStockCheckGap(row)}
                        className="text-blue-600 hover:underline text-xs"
                      >
                        Bill {row.otherQty} {row.unit}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {gapRows.length > 0 && (
        <div className="text-xs text-gray-400 px-1">
          Tip: Open a New GST Invoice, search each flagged product above and bill the shown quantity as a consolidated
          B2C counter sale to bring GST records in line with actual stock movement.
        </div>
      )}
    </div>
  )
}

const TABS = [
  { key:'sales',       label:'Sales Report' },
  { key:'gst',         label:'GST Summary' },
  { key:'auditor',     label:'GST Auditor' },
  { key:'stockcheck',  label:'Stock Check' },
  { key:'purchases',   label:'Purchase Report' },
  { key:'credits',     label:'Credit Report' },
  { key:'topproducts', label:'Top Products' },
]

async function fetchReportsDirect({ shopId, tab, dateFrom, dateTo }) {
  if (tab === 'sales') {
    const { data } = await supabase.from('bills').select('*').eq('shop_id', shopId).eq('bill_type', 'invoice').gte('date', dateFrom).lte('date', dateTo).order('date')
    return data || []
  }
  if (tab === 'purchases') {
    const { data } = await supabase.from('purchase_bills').select('*, suppliers(name)').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo).order('date')
    return data || []
  }
  if (tab === 'stockcheck') {
    const [{ data: purchaseBills }, { data: salesBills }] = await Promise.all([
      supabase.from('purchase_bills').select('id').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo),
      supabase.from('bills').select('id,bill_type').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo),
    ])
    const purchaseBillIds = (purchaseBills || []).map(b => b.id)
    const invoiceBillIds = (salesBills || []).filter(b => b.bill_type === 'invoice').map(b => b.id)
    const otherBillIds = (salesBills || []).filter(b => b.bill_type !== 'invoice').map(b => b.id)

    const [{ data: purchaseItems }, { data: invoiceItems }, { data: otherItems }] = await Promise.all([
      purchaseBillIds.length ? supabase.from('purchase_bill_items').select('product_id,quantity').in('purchase_bill_id', purchaseBillIds) : Promise.resolve({ data: [] }),
      invoiceBillIds.length ? supabase.from('bill_items').select('product_id,quantity').in('bill_id', invoiceBillIds) : Promise.resolve({ data: [] }),
      otherBillIds.length ? supabase.from('bill_items').select('product_id,quantity').in('bill_id', otherBillIds) : Promise.resolve({ data: [] }),
    ])

    const productIds = [...new Set([
      ...(purchaseItems || []).map(i => i.product_id),
      ...(invoiceItems || []).map(i => i.product_id),
      ...(otherItems || []).map(i => i.product_id),
    ].filter(Boolean))]

    const { data: products } = productIds.length
      ? await supabase.from('products').select('id,name,hsn_code,gst_rate,unit,stock_qty,selling_price').eq('shop_id', shopId).in('id', productIds)
      : { data: [] }

    return {
      purchaseItems: purchaseItems || [],
      invoiceItems: invoiceItems || [],
      otherItems: otherItems || [],
      products: products || [],
    }
  }
  if (tab === 'credits') {
    const [{ data: accounts }, { data: entries }] = await Promise.all([
      supabase.from('credit_accounts').select('*').eq('shop_id', shopId).order('party_name'),
      supabase.from('credit_entries').select('id,account_id,amount,direction,entry_date').eq('shop_id', shopId),
    ])
    const allEntries = entries || []
    return { accounts: accounts || [], allEntries, periodEntries: allEntries.filter(e => e.entry_date >= dateFrom && e.entry_date <= dateTo) }
  }
  if (tab === 'gst') {
    const [{ data: salesBills }, { data: purchaseBills }] = await Promise.all([
      supabase.from('bills').select('id').eq('shop_id', shopId).eq('bill_type', 'invoice').gte('date', dateFrom).lte('date', dateTo),
      supabase.from('purchase_bills').select('id').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo),
    ])
    const salesBillIds = (salesBills || []).map(b => b.id)
    const purchaseBillIds = (purchaseBills || []).map(b => b.id)
    const [{ data: sales }, { data: purchases }] = await Promise.all([
      salesBillIds.length ? supabase.from('bill_items').select('gst_rate,base_rate,quantity,gst_amount').in('bill_id', salesBillIds) : Promise.resolve({ data: [] }),
      purchaseBillIds.length ? supabase.from('purchase_bill_items').select('gst_rate,base_rate,quantity,gst_amount').in('purchase_bill_id', purchaseBillIds) : Promise.resolve({ data: [] }),
    ])
    return { sales: sales || [], purchases: purchases || [] }
  }
  if (tab === 'auditor') {
    const [{ data: salesBills }, { data: purchaseBills }, { data: expenses }] = await Promise.all([
      supabase
        .from('bills')
        .select('id,bill_no,date,customer_name,customer_gstin,subtotal,cgst_amount,sgst_amount,igst_amount,gst_amount,total,payment_status')
        .eq('shop_id', shopId)
        .eq('bill_type', 'invoice')
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('date'),
      supabase
        .from('purchase_bills')
        .select('id,bill_no,supplier_invoice_no,date,subtotal,gst_amount,total,payment_status,is_interstate,suppliers(name,gstin)')
        .eq('shop_id', shopId)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('date'),
      supabase
        .from('expenses')
        .select('expense_date,title,category,amount,payment_mode,notes')
        .eq('shop_id', shopId)
        .gte('expense_date', dateFrom)
        .lte('expense_date', dateTo)
        .order('expense_date'),
    ])
    const salesBillIds = (salesBills || []).map(b => b.id)
    const purchaseBillIds = (purchaseBills || []).map(b => b.id)
    const [{ data: salesItems }, { data: purchaseItems }] = await Promise.all([
      salesBillIds.length
        ? supabase.from('bill_items').select('bill_id,product_name,hsn_code,quantity,base_rate,gst_rate,gst_amount,total').in('bill_id', salesBillIds)
        : Promise.resolve({ data: [] }),
      purchaseBillIds.length
        ? supabase.from('purchase_bill_items').select('purchase_bill_id,product_name,hsn_code,quantity,base_rate,taxable_amount,gst_rate,gst_amount,cgst_amount,sgst_amount,igst_amount,total').in('purchase_bill_id', purchaseBillIds)
        : Promise.resolve({ data: [] }),
    ])
    return {
      salesBills: salesBills || [],
      purchaseBills: purchaseBills || [],
      salesItems: salesItems || [],
      purchaseItems: purchaseItems || [],
      expenses: expenses || [],
    }
  }
  if (tab === 'topproducts') {
    const { data: bills } = await supabase.from('bills').select('id').eq('shop_id', shopId).eq('bill_type', 'invoice').gte('date', dateFrom).lte('date', dateTo)
    const billIds = (bills || []).map(b => b.id)
    const { data: items } = billIds.length ? await supabase.from('bill_items').select('product_name,quantity,total').in('bill_id', billIds) : { data: [] }
    const aggregate = {}
    ;(items || []).forEach(item => {
      if (!item.product_name) return
      if (!aggregate[item.product_name]) aggregate[item.product_name] = { qty: 0, amount: 0 }
      aggregate[item.product_name].qty += parseFloat(item.quantity) || 0
      aggregate[item.product_name].amount += parseFloat(item.total) || 0
    })
    return Object.entries(aggregate).map(([name, value]) => ({ name, ...value })).sort((a, b) => b.amount - a.amount).slice(0, 30)
  }
  return []
}
function emptyDataForTab(tab) {
  if (tab === 'gst') return { sales: [], purchases: [] }
  if (tab === 'auditor') return { salesBills: [], purchaseBills: [], salesItems: [], purchaseItems: [], expenses: [] }
  if (tab === 'stockcheck') return { purchaseItems: [], invoiceItems: [], otherItems: [], products: [] }
  if (tab === 'credits') return { accounts: [], allEntries: [], periodEntries: [] }
  return []
}

export default function ReportsPage() {
  const { shop, loading: shopLoading } = useShop()
  const [tab,      setTab]      = useState('sales')
  const [dateFrom, setDateFrom] = useState(monthStartStr())
  const [dateTo,   setDateTo]   = useState(todayStr())
  const [search,   setSearch]   = useState('')
  const [liveTick, setLiveTick] = useState(0)
  const loadedLiveTickRef = useRef(0)
  const cacheKey = shop?.id ? `reports:${shop.id}:${tab}:${dateFrom}:${dateTo}` : ''
  const initialCache = readPageCache(cacheKey)
  const [data,     setData]     = useState(() => initialCache?.data || emptyDataForTab(tab))
  const [loading,  setLoading]  = useState(() => !initialCache)
  usePageLoadingState('reports-page', loading)

  useEffect(() => {
    if (!shop?.id) return
    let cancelled = false

    async function run() {
      const shouldForceFresh = liveTick !== loadedLiveTickRef.current
      const cached = shouldForceFresh ? null : readPageCache(cacheKey)
      if (cached?.data) {
        setData(cached.data)
        setLoading(false)
      } else {
        setData(emptyDataForTab(tab))
        setLoading(true)
      }

      try {
        const result = await fetchReportsDirect({
          shopId: shop.id,
          tab,
          dateFrom,
          dateTo,
        })

        writePageCache(cacheKey, { data: result })
        loadedLiveTickRef.current = liveTick
        if (!cancelled) setData(result)
      } catch (err) {
        console.error('Reports load failed:', err)
        loadedLiveTickRef.current = liveTick
        if (!cancelled) {
          setData(emptyDataForTab(tab))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => { cancelled = true }
  }, [cacheKey, dateFrom, dateTo, liveTick, shop?.id, tab])

  useEffect(() => {
    if (!shop?.id) return

    const tables = ['bills', 'bill_items', 'purchase_bills', 'purchase_bill_items', 'products', 'expenses', 'credit_accounts', 'credit_entries']
    const channel = supabase.channel(`reports-live:${shop.id}`)
    tables.forEach((table) => {
      channel.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table,
        filter: `shop_id=eq.${shop.id}`,
      }, () => {
        setLiveTick((tick) => tick + 1)
      })
    })

    channel.subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [shop?.id])

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-3">Reports</h1>

      {/* Date range */}
      <div className="flex items-center gap-3 mb-4">
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
        <span className="text-gray-400">to</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" />
        {[
          { label:'Today',      from: todayStr(),   to: todayStr() },
          { label:'This Month', from: monthStartStr(), to: todayStr() },
        ].map(p => (
          <button key={p.label}
            onClick={() => { setDateFrom(p.from); setDateTo(p.to) }}
            className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-xs hover:bg-gray-200">
            {p.label}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {(tab === 'sales' || tab === 'purchases' || tab === 'credits') && (
        <div className="mb-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={
              tab === 'sales'
                ? 'Search invoice by bill no or customer'
                : tab === 'purchases'
                  ? 'Search purchase by bill no or supplier'
                  : 'Search credit account by party or phone'
            }
            className="w-full max-w-md border rounded-lg px-3 py-2 text-sm"
          />
        </div>
      )}

      {(shopLoading || loading) ? (
        <LoadingPlaceholder label="Loading reports" rows={4} fullPage />
      ) : (
        <>
          {tab === 'sales'       && <SalesSummary data={data} searchTerm={search} />}
          {tab === 'gst'         && <GSTSummary data={data} />}
          {tab === 'auditor'     && <GSTAuditorReport data={data} dateFrom={dateFrom} dateTo={dateTo} />}
          {tab === 'stockcheck'  && <StockReconciliation data={data} dateFrom={dateFrom} dateTo={dateTo} />}
          {tab === 'purchases'   && <PurchaseSummary data={data} searchTerm={search} />}
          {tab === 'credits'     && <CreditSummary data={data} searchTerm={search} />}
          {tab === 'topproducts' && <TopProducts data={data} />}
        </>
      )}
    </div>
  )
}

function PurchaseSummary({ data, searchTerm }) {
  const bills = Array.isArray(data) ? data : []
  const term = (searchTerm || '').trim().toLowerCase()
  const visible = term
    ? bills.filter(b =>
      String(b.bill_no || '').toLowerCase().includes(term) ||
      String(b.suppliers?.name || '').toLowerCase().includes(term) ||
      String(b.supplier_invoice_no || '').toLowerCase().includes(term)
    )
    : bills

  const total = visible.reduce((sum, b) => sum + (Number(b.total) || 0), 0)
  const unpaid = visible
    .filter(b => b.payment_status !== 'paid')
    .reduce((sum, b) => sum + ((Number(b.total) || 0) - (Number(b.paid_amount) || 0)), 0)

  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { label:'Total Purchases', value: fmt(total),   cls:'text-blue-700' },
          { label:'Bills',           value: visible.length, cls:'text-gray-700' },
          { label:'Outstanding',     value: fmt(unpaid),  cls:'text-red-700' },
        ].map(c => (
          <div key={c.label} className="bg-white border rounded-lg p-3">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-xl font-bold mt-1 ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No purchases found for this period</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                {['Date','Bill No','Supplier','Sup. Inv.','GST','Total','Paid','Status'].map(h => (
                  <th key={h} className="px-3 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(b => (
                <tr key={b.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-1.5">{new Date(b.date+'T00:00:00').toLocaleDateString('en-IN')}</td>
                  <td className="px-3 py-1.5 font-mono font-medium">
                    <Link href={`/purchases/${b.id}`} className="text-blue-700 hover:underline">
                      {b.bill_no}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">{b.suppliers?.name || '—'}</td>
                  <td className="px-3 py-1.5 text-gray-500 text-xs">{b.supplier_invoice_no || '—'}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(b.gst_amount)}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{fmt(b.total)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(b.paid_amount)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      b.payment_status === 'paid' ? 'bg-green-100 text-green-700'
                      : b.payment_status === 'partial' ? 'bg-yellow-100 text-yellow-700'
                      : 'bg-red-100 text-red-700'
                    }`}>{b.payment_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
