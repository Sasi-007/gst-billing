export const MONEY_PAYMENT_MODES = ['cash', 'upi', 'card', 'bank', 'cheque', 'credit']
export const BANK_ACCOUNT_TYPES = ['bank', 'cash', 'wallet', 'upi']
export const BANK_ENTRY_TYPES = ['deposit', 'withdrawal', 'expense', 'investment', 'drawing', 'sale_receipt', 'purchase_payment', 'other']

export const EXPENSE_CATEGORY_SUGGESTIONS = [
  'Rent',
  'Salary',
  'Electricity',
  'Transport',
  'Internet',
  'Maintenance',
  'Packaging',
  'Marketing',
  'Miscellaneous',
]

function cloneDate(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayStr() {
  return formatLocalDate(cloneDate())
}

export function monthStartStr() {
  const date = cloneDate()
  date.setDate(1)
  return formatLocalDate(date)
}

export function weekStartStr() {
  const date = cloneDate()
  date.setDate(date.getDate() - 6)
  return formatLocalDate(date)
}

export function getDateRangeForPeriod(period, currentFrom = todayStr(), currentTo = todayStr()) {
  if (period === 'daily') return { dateFrom: todayStr(), dateTo: todayStr() }
  if (period === 'weekly') return { dateFrom: weekStartStr(), dateTo: todayStr() }
  if (period === 'monthly') return { dateFrom: monthStartStr(), dateTo: todayStr() }
  return { dateFrom: currentFrom, dateTo: currentTo }
}

export function buildDateBuckets(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return []
  const rows = []
  const start = new Date(`${dateFrom}T00:00:00`)
  const end = new Date(`${dateTo}T00:00:00`)
  for (let current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    rows.push(formatLocalDate(current))
  }
  return rows
}

export function calculateGrossProfitFromItems(items) {
  return (items || []).reduce((sum, item) => {
    const total = Number(item.total || 0)
    const quantity = Number(item.quantity || 0)
    const costPrice = Number(item.cost_price || 0)
    return sum + (total - (costPrice * quantity))
  }, 0)
}

export function calculateExpenseCategoryBreakdown(expenses = []) {
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0)
  return Object.entries(
    expenses.reduce((map, expense) => {
      const key = String(expense.category || 'Uncategorised')
      map[key] = (map[key] || 0) + Number(expense.amount || 0)
      return map
    }, {})
  )
    .map(([category, amount]) => ({
      category,
      amount,
      percent: total > 0 ? (amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
}

export function calculateBankAccountSummaries(accounts = [], transactions = []) {
  const grouped = transactions.reduce((map, transaction) => {
    if (!transaction?.account_id) return map
    if (!map[transaction.account_id]) map[transaction.account_id] = []
    map[transaction.account_id].push(transaction)
    return map
  }, {})

  return (accounts || []).map((account) => {
    const accountTransactions = grouped[account.id] || []
    const inflow = accountTransactions
      .filter((transaction) => transaction.direction === 'in')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0)
    const outflow = accountTransactions
      .filter((transaction) => transaction.direction === 'out')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0)

    return {
      ...account,
      inflow,
      outflow,
      currentBalance: Number(account.opening_balance || 0) + inflow - outflow,
      transactionCount: accountTransactions.length,
    }
  }).sort((a, b) => b.currentBalance - a.currentBalance)
}

export function buildActivityRows({ dateFrom, dateTo, bills = [], billItems = [], purchases = [], expenses = [], investments = [], drawings = [] }) {
  const rows = new Map(
    buildDateBuckets(dateFrom, dateTo).map((date) => [date, {
      date,
      sales: 0,
      purchases: 0,
      expenses: 0,
      investments: 0,
      drawings: 0,
      grossProfit: 0,
      netProfit: 0,
      billCount: 0,
    }])
  )

  const ensureRow = (date) => {
    if (!rows.has(date)) {
      rows.set(date, {
        date,
        sales: 0,
        purchases: 0,
        expenses: 0,
        investments: 0,
        drawings: 0,
        grossProfit: 0,
        netProfit: 0,
        billCount: 0,
      })
    }
    return rows.get(date)
  }

  const billDateById = new Map()
  bills.forEach((bill) => {
    const row = ensureRow(bill.date)
    row.sales += Number(bill.total || 0)
    row.billCount += 1
    billDateById.set(bill.id, bill.date)
  })

  billItems.forEach((item) => {
    const billDate = billDateById.get(item.bill_id)
    if (!billDate) return
    const row = ensureRow(billDate)
    row.grossProfit += Number(item.total || 0) - (Number(item.cost_price || 0) * Number(item.quantity || 0))
  })

  purchases.forEach((purchase) => {
    const row = ensureRow(purchase.date)
    row.purchases += Number(purchase.total || 0)
  })

  expenses.forEach((expense) => {
    const row = ensureRow(expense.expense_date)
    row.expenses += Number(expense.amount || 0)
  })

  investments.forEach((investment) => {
    const row = ensureRow(investment.investment_date)
    row.investments += Number(investment.amount || 0)
  })

  drawings.forEach((drawing) => {
    const row = ensureRow(drawing.drawing_date)
    row.drawings += Number(drawing.amount || 0)
  })

  return [...rows.values()]
    .map((row) => ({
      ...row,
      netProfit: row.grossProfit - row.expenses,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
}
