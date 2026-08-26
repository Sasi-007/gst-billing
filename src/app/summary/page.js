'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { buildActivityRows, calculateBankAccountSummaries, calculateExpenseCategoryBreakdown, calculateGrossProfitFromItems, getDateRangeForPeriod, todayStr } from '@/lib/finance'
import { calculateCreditBalance } from '@/lib/credits'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

function SummaryCard({ label, value, hint, className = '' }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${className}`}>{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

async function fetchSummaryDirect(shopId, dateFrom, dateTo) {
  const [
    billsRes, purchasesRes, expensesRes, investmentsRes, drawingsRes,
    productsRes, bankAccountsRes, bankTransactionsRes, creditAccountsRes, creditEntriesRes,
  ] = await Promise.all([
    supabase.from('bills').select('id,date,total,subtotal,discount_amount,gst_amount,paid_amount,payment_status').eq('shop_id', shopId).eq('bill_type', 'invoice').gte('date', dateFrom).lte('date', dateTo).order('date', { ascending: false }),
    supabase.from('purchase_bills').select('id,date,total,gst_amount,paid_amount,payment_status').eq('shop_id', shopId).gte('date', dateFrom).lte('date', dateTo).order('date', { ascending: false }),
    supabase.from('expenses').select('id,expense_date,title,category,amount,payment_mode').eq('shop_id', shopId).eq('is_active', true).gte('expense_date', dateFrom).lte('expense_date', dateTo).order('expense_date', { ascending: false }),
    supabase.from('investments').select('id,investment_date,source_name,amount,payment_mode').eq('shop_id', shopId).eq('is_active', true).gte('investment_date', dateFrom).lte('investment_date', dateTo).order('investment_date', { ascending: false }),
    supabase.from('owner_drawings').select('id,drawing_date,title,amount,payment_mode,bank_account_id').eq('shop_id', shopId).eq('is_active', true).gte('drawing_date', dateFrom).lte('drawing_date', dateTo).order('drawing_date', { ascending: false }),
    supabase.from('products').select('id,name,stock_qty,purchase_price,mrp,selling_price,min_stock,is_active').eq('shop_id', shopId).eq('is_active', true),
    supabase.from('bank_accounts').select('*').eq('shop_id', shopId).eq('is_active', true).order('account_name'),
    supabase.from('bank_transactions').select('*').eq('shop_id', shopId).eq('is_active', true),
    supabase.from('credit_accounts').select('*').eq('shop_id', shopId).eq('is_active', true),
    supabase.from('credit_entries').select('*').eq('shop_id', shopId),
  ])

  const bills = billsRes.data || []
  const billIds = bills.map(b => b.id)
  let billItems = []
  if (billIds.length > 0) {
    const { data } = await supabase.from('bill_items').select('bill_id,quantity,total,cost_price').eq('shop_id', shopId).in('bill_id', billIds)
    billItems = data || []
  }

  return {
    bills,
    billItems,
    purchases: purchasesRes.data || [],
    expenses: expensesRes.data || [],
    investments: investmentsRes.data || [],
    drawings: drawingsRes.data || [],
    products: productsRes.data || [],
    bankAccounts: bankAccountsRes.data || [],
    bankTransactions: bankTransactionsRes.data || [],
    creditAccounts: creditAccountsRes.data || [],
    creditEntries: creditEntriesRes.data || [],
  }
}

export default function SummaryPage() {
  const { shop } = useShop()
  const [period, setPeriod] = useState('daily')
  const [dateFrom, setDateFrom] = useState(todayStr())
  const [dateTo, setDateTo] = useState(todayStr())
  const [liveTick, setLiveTick] = useState(0)
  const loadedTick = useRef(0)
  const cacheKey = shop?.id ? `summary:${shop.id}:${period}:${dateFrom}:${dateTo}` : ''
  const initialCache = readPageCache(cacheKey)
  const [data, setData] = useState(() => initialCache?.data || null)
  const [loading, setLoading] = useState(() => !initialCache)
  usePageLoadingState('summary-page', loading)

  useEffect(() => {
    if (period === 'custom') return
    const nextRange = getDateRangeForPeriod(period, dateFrom, dateTo)
    setDateFrom(nextRange.dateFrom)
    setDateTo(nextRange.dateTo)
  }, [period])

  useEffect(() => {
    if (!shop?.id || !dateFrom || !dateTo) return
    let cancelled = false

    async function load() {
      const cached = readPageCache(cacheKey)
      const shouldForceFresh = liveTick !== loadedTick.current
      if (cached?.data && !shouldForceFresh) {
        setData(cached.data)
        setLoading(false)
      } else {
        setLoading(true)
      }

      try {
        const nextData = await fetchSummaryDirect(shop.id, dateFrom, dateTo)

        if (cancelled) return

        setData(nextData)
        writePageCache(cacheKey, { data: nextData })
        loadedTick.current = liveTick
        setLoading(false)
      } catch (error) {
        if (!cancelled) {
          setData({
            bills: [],
            billItems: [],
            purchases: [],
            expenses: [],
            investments: [],
            drawings: [],
            products: [],
            bankAccounts: [],
            bankTransactions: [],
            creditAccounts: [],
            creditEntries: [],
            error: error.message || 'Failed to load summary',
          })
          loadedTick.current = liveTick
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [cacheKey, dateFrom, dateTo, liveTick, shop?.id])

  useEffect(() => {
    if (!shop?.id) return
    const tables = ['bills', 'bill_items', 'purchase_bills', 'purchase_bill_items', 'expenses', 'investments', 'owner_drawings', 'products', 'bank_accounts', 'bank_transactions', 'credit_accounts', 'credit_entries']
    const channel = supabase.channel(`summary-live:${shop.id}`)
    tables.forEach((table) => {
      channel.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table,
        filter: `shop_id=eq.${shop.id}`,
      }, () => setLiveTick((tick) => tick + 1))
    })
    channel.subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [shop?.id])

  const summary = useMemo(() => {
    const bills = data?.bills || []
    const billItems = data?.billItems || []
    const purchases = data?.purchases || []
    const expenses = data?.expenses || []
    const investments = data?.investments || []
    const drawings = data?.drawings || []
    const products = data?.products || []
    const bankAccounts = data?.bankAccounts || []
    const bankTransactions = data?.bankTransactions || []
    const creditAccounts = data?.creditAccounts || []
    const creditEntries = data?.creditEntries || []

    const salesTotal = bills.reduce((sum, bill) => sum + Number(bill.total || 0), 0)
    const grossProfit = calculateGrossProfitFromItems(billItems)
    const expenseTotal = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0)
    const investmentsTotal = investments.reduce((sum, investment) => sum + Number(investment.amount || 0), 0)
    const drawingsTotal = drawings.reduce((sum, drawing) => sum + Number(drawing.amount || 0), 0)
    const purchaseTotal = purchases.reduce((sum, purchase) => sum + Number(purchase.total || 0), 0)
    const outputGstTotal = bills.reduce((sum, bill) => sum + Number(bill.gst_amount || 0), 0)
    const inputGstTotal = purchases.reduce((sum, purchase) => sum + Number(purchase.gst_amount || 0), 0)
    const netGstPayable = outputGstTotal - inputGstTotal
    const salesOutstanding = bills.reduce((sum, bill) => sum + Math.max(0, Number(bill.total || 0) - Number(bill.paid_amount || 0)), 0)
    const purchaseOutstanding = purchases.reduce((sum, purchase) => sum + Math.max(0, Number(purchase.total || 0) - Number(purchase.paid_amount || 0)), 0)
    const averageBill = bills.length > 0 ? salesTotal / bills.length : 0
    const activityRows = buildActivityRows({ dateFrom, dateTo, bills, billItems, purchases, expenses, investments, drawings })
    const bankAccountSummaries = calculateBankAccountSummaries(bankAccounts, bankTransactions)
    const totalBankBalance = bankAccountSummaries.reduce((sum, account) => sum + Number(account.currentBalance || 0), 0)
    const activeProducts = products.filter((product) => product.is_active !== false)
    const lowStockProducts = activeProducts.filter((product) => Number(product.stock_qty || 0) > 0 && Number(product.stock_qty || 0) <= Number(product.min_stock || 0))
    const outOfStockProducts = activeProducts.filter((product) => Number(product.stock_qty || 0) <= 0)
    const totalStockQty = activeProducts.reduce((sum, product) => sum + Number(product.stock_qty || 0), 0)
    const stockCostValue = activeProducts.reduce((sum, product) => sum + (Number(product.stock_qty || 0) * Number(product.purchase_price || 0)), 0)
    const stockSellingValue = activeProducts.reduce((sum, product) => {
      const sellingPrice = Number(product.selling_price || product.mrp || 0)
      return sum + (Number(product.stock_qty || 0) * sellingPrice)
    }, 0)

    const receivable = creditAccounts.reduce((sum, account) => {
      const balance = calculateCreditBalance(account, creditEntries)
      return account.relation_type === 'borrower' ? sum + Math.max(0, balance) : sum
    }, 0)
    const payable = creditAccounts.reduce((sum, account) => {
      const balance = calculateCreditBalance(account, creditEntries)
      return account.relation_type === 'lender' ? sum + Math.max(0, balance) : sum
    }, 0)

    const expenseCategories = calculateExpenseCategoryBreakdown(expenses)

    return {
      salesTotal,
      grossProfit,
      expenseTotal,
      netProfit: grossProfit - expenseTotal,
      investmentsTotal,
      drawingsTotal,
      purchaseTotal,
      outputGstTotal,
      inputGstTotal,
      netGstPayable,
      salesOutstanding,
      purchaseOutstanding,
      averageBill,
      totalBankBalance,
      bankAccountSummaries,
      activeProductsCount: activeProducts.length,
      totalStockQty,
      stockCostValue,
      stockSellingValue,
      lowStockProductsCount: lowStockProducts.length,
      outOfStockProductsCount: outOfStockProducts.length,
      receivable,
      payable,
      activityRows,
      expenseCategories,
      billCount: bills.length,
      error: data?.error || '',
    }
  }, [data, dateFrom, dateTo])

  function setPeriodRange(nextPeriod) {
    setPeriod(nextPeriod)
    if (nextPeriod === 'custom') return
    const range = getDateRangeForPeriod(nextPeriod, dateFrom, dateTo)
    setDateFrom(range.dateFrom)
    setDateTo(range.dateTo)
  }

  return (
    <div className="p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold">Business Summary</h1>
          <div className="text-sm text-gray-500 mt-0.5">See sales, gross profit, expenses, investments, purchases, and daily activity for the selected period.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/expenses" className="px-3 py-2 rounded-lg bg-white border text-sm text-gray-700 hover:bg-gray-50">Open Expenses</Link>
          <Link href="/investments" className="px-3 py-2 rounded-lg bg-white border text-sm text-gray-700 hover:bg-gray-50">Open Investments</Link>
          <Link href="/drawings" className="px-3 py-2 rounded-lg bg-white border text-sm text-gray-700 hover:bg-gray-50">Open Drawings</Link>
          <Link href="/banking" className="px-3 py-2 rounded-lg bg-white border text-sm text-gray-700 hover:bg-gray-50">Open Banking</Link>
          <Link href="/reports" className="px-3 py-2 rounded-lg bg-white border text-sm text-gray-700 hover:bg-gray-50">Open Reports</Link>
        </div>
      </div>

      <div className="bg-white border rounded-xl p-3 mb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {[
              { key: 'daily', label: 'Daily' },
              { key: 'weekly', label: 'Weekly' },
              { key: 'monthly', label: 'Monthly' },
              { key: 'custom', label: 'Custom' },
            ].map((option) => (
              <button key={option.key} onClick={() => setPeriodRange(option.key)}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${period === option.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={dateFrom} onChange={e => { setPeriod('custom'); setDateFrom(e.target.value) }}
              className="border rounded-lg px-3 py-2 text-sm" />
            <span className="text-gray-400">to</span>
            <input type="date" value={dateTo} onChange={e => { setPeriod('custom'); setDateTo(e.target.value) }}
              className="border rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingPlaceholder label="Loading summary" rows={5} fullPage />
      ) : (
        <>
          {summary.error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{summary.error}</div>}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
            <SummaryCard label="Active Products" value={summary.activeProductsCount} hint="items currently listed" className="text-indigo-700" />
            <SummaryCard label="Current Stock Qty" value={summary.totalStockQty.toFixed(0)} hint="units in inventory" className="text-blue-700" />
            <SummaryCard label="Stock Value (Cost)" value={fmt(summary.stockCostValue)} hint="based on purchase price" className="text-green-700" />
            <SummaryCard label="Stock Value (Sell)" value={fmt(summary.stockSellingValue)} hint="based on selling price" className="text-emerald-700" />
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
            <SummaryCard label="Total Sales" value={fmt(summary.salesTotal)} hint={`${summary.billCount} bills`} className="text-blue-700" />
            <SummaryCard label="Gross Profit" value={fmt(summary.grossProfit)} hint="Sales - billed product cost" className={summary.grossProfit >= 0 ? 'text-emerald-700' : 'text-red-700'} />
            <SummaryCard label="Expenses" value={fmt(summary.expenseTotal)} hint="Business running costs" className="text-red-700" />
            <SummaryCard label="Net Profit" value={fmt(summary.netProfit)} hint="Gross profit - expenses" className={summary.netProfit >= 0 ? 'text-green-700' : 'text-red-700'} />
            <SummaryCard label="Investments Added" value={fmt(summary.investmentsTotal)} hint="Owner money added" className="text-cyan-700" />
            <SummaryCard label="Owner Drawings" value={fmt(summary.drawingsTotal)} hint="Money taken out by owner" className="text-amber-700" />
            <SummaryCard label="Purchase Spend" value={fmt(summary.purchaseTotal)} hint="Stock purchases in period" className="text-purple-700" />
            <SummaryCard label="Bank Balance" value={fmt(summary.totalBankBalance)} hint={`${summary.bankAccountSummaries.length} accounts`} className={summary.totalBankBalance >= 0 ? 'text-indigo-700' : 'text-red-700'} />
            <SummaryCard label="To Collect" value={fmt(summary.receivable)} hint="Current customer credits" className="text-sky-700" />
            <SummaryCard label="To Pay" value={fmt(summary.payable)} hint="Current supplier dues" className="text-orange-700" />
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
            <SummaryCard label="Average Bill" value={fmt(summary.averageBill)} />
            <SummaryCard label="Sales Outstanding" value={fmt(summary.salesOutstanding)} className="text-amber-700" />
            <SummaryCard label="Purchase Outstanding" value={fmt(summary.purchaseOutstanding)} className="text-amber-700" />
            <SummaryCard label="GST Payable" value={fmt(summary.netGstPayable)} hint={`Output ${fmt(summary.outputGstTotal)} - Input ${fmt(summary.inputGstTotal)}`} className={summary.netGstPayable >= 0 ? 'text-red-700' : 'text-green-700'} />
            <SummaryCard label="Period" value={`${dateFrom} → ${dateTo}`} className="text-sm text-gray-700" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[2fr,1fr] gap-4">
            <div className="bg-white rounded-xl border overflow-x-auto">
              <div className="px-4 py-3 border-b">
                <div className="text-sm font-medium text-gray-700">Daily Activity</div>
                <div className="text-xs text-gray-400 mt-0.5">Sales, profit, expenses, investments, and purchases day by day for the selected period.</div>
              </div>
              {summary.activityRows.length === 0 ? (
                <div className="p-8 text-center text-gray-400">No activity found for this period</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                      {['Date', 'Sales', 'Gross Profit', 'Expenses', 'Investments', 'Drawings', 'Purchases', 'Net Profit'].map((heading) => (
                        <th key={heading} className={`px-3 py-2 ${heading === 'Date' ? 'text-left' : 'text-right'}`}>{heading}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.activityRows.map((row) => (
                      <tr key={row.date} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2">{new Date(`${row.date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                        <td className="px-3 py-2 text-right">{fmt(row.sales)}</td>
                        <td className={`px-3 py-2 text-right ${row.grossProfit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{fmt(row.grossProfit)}</td>
                        <td className="px-3 py-2 text-right text-red-700">{fmt(row.expenses)}</td>
                        <td className="px-3 py-2 text-right text-cyan-700">{fmt(row.investments)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{fmt(row.drawings)}</td>
                        <td className="px-3 py-2 text-right text-purple-700">{fmt(row.purchases)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.netProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmt(row.netProfit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="space-y-4">
              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="px-4 py-3 border-b">
                  <div className="text-sm font-medium text-gray-700">Expense Split</div>
                  <div className="text-xs text-gray-400 mt-0.5">Top categories in this selected period.</div>
                </div>
                {summary.expenseCategories.length === 0 ? (
                  <div className="p-6 text-sm text-gray-400 text-center">No expense categories yet</div>
                ) : (
                  <div className="divide-y">
                    {summary.expenseCategories.slice(0, 8).map((row) => (
                      <div key={row.category} className="px-4 py-2.5 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-gray-700">{row.category}</span>
                          <span className="font-medium text-red-700">{fmt(row.amount)} <span className="text-xs text-gray-400">({row.percent.toFixed(1)}%)</span></span>
                        </div>
                        <div className="mt-2 h-2 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.min(100, row.percent)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white rounded-xl border overflow-hidden">
                <div className="px-4 py-3 border-b">
                  <div className="text-sm font-medium text-gray-700">Bank Accounts</div>
                  <div className="text-xs text-gray-400 mt-0.5">Current balance snapshot by account.</div>
                </div>
                {summary.bankAccountSummaries.length === 0 ? (
                  <div className="p-6 text-sm text-gray-400 text-center">No bank accounts yet</div>
                ) : (
                  <div className="divide-y">
                    {summary.bankAccountSummaries.slice(0, 6).map((account) => (
                      <div key={account.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div>
                          <div className="font-medium text-gray-800">{account.account_name}</div>
                          <div className="text-xs text-gray-400 capitalize">{account.account_type}{account.bank_name ? ` · ${account.bank_name}` : ''}</div>
                        </div>
                        <div className={`font-semibold ${account.currentBalance >= 0 ? 'text-indigo-700' : 'text-red-700'}`}>{fmt(account.currentBalance)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                <div className="text-sm font-medium text-blue-900">How profit is calculated here</div>
                <div className="text-xs text-blue-800 mt-1 leading-5">
                  Gross profit = billed selling amount - stored product cost on each billed line.
                  Net profit = gross profit - expenses.
                  Investments and owner drawings are shown separately and do not change profit directly.
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
