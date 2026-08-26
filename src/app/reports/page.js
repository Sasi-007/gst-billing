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

const TABS = [
  { key:'sales',       label:'Sales Report' },
  { key:'gst',         label:'GST Summary' },
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
  const [data,     setData]     = useState(() => initialCache?.data || emptyDataForTab('sales'))
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

    const tables = ['bills', 'bill_items', 'purchase_bills', 'purchase_bill_items', 'credit_accounts', 'credit_entries']
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
