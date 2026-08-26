export function calculateCreditBalance(account, entries = []) {
  const opening = Number(account?.opening_balance || 0)
  return entries.reduce((sum, entry) => {
    const amount = Number(entry.amount || 0)
    return entry.direction === 'increase' ? sum + amount : sum - amount
  }, opening)
}

export function groupCreditEntriesByAccount(entries = []) {
  const grouped = {}
  entries.forEach((entry) => {
    if (!grouped[entry.account_id]) grouped[entry.account_id] = []
    grouped[entry.account_id].push(entry)
  })
  return grouped
}

export const WEEKDAY_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
]

export function normalizeSettlementDay(cycle, value) {
  const parsed = parseInt(value || '1', 10)
  if (cycle === 'monthly') {
    return Math.max(1, Math.min(31, Number.isNaN(parsed) ? 1 : parsed))
  }
  if (cycle === 'weekly') {
    return Math.max(1, Math.min(7, Number.isNaN(parsed) ? 1 : parsed))
  }
  return null
}

export function formatSettlementLabel(cycle, settlementDay) {
  if (cycle === 'weekly') {
    const weekday = WEEKDAY_OPTIONS.find((item) => item.value === String(settlementDay || '1'))
    return `Weekly${weekday ? ` · ${weekday.label}` : ''}`
  }
  if (cycle === 'monthly') {
    return `Monthly · day ${settlementDay || 1}`
  }
  return 'Daily'
}
