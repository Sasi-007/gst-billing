// Credit-card planner maths for /smart.
//
// Pure functions only: no Supabase, no React, no Date.now() inside the maths
// (today is always passed in). That is what makes the whole engine testable,
// and this file is covered by a test suite because a wrong number here is
// money, not a cosmetic bug.
//
// Two rules the rest of this file depends on:
//
//  1. Money is integer PAISE everywhere inside the engine. Rupee floats cannot
//     represent 0.1, so repeatedly adding 0.1 drifts (0.1+0.2 === 0.30000000000000004).
//     Over a few dozen spends that drift becomes a visibly wrong balance.
//     Rupees are converted in at the edge and out again only for display.
//
//  2. Dates are date-only and computed in UTC. Using local-time Date objects
//     means a cycle boundary can shift by a day across a DST change or for a
//     user in another timezone, silently moving a spend into the wrong
//     statement -- which is exactly the number this app exists to get right.

// ── Money ────────────────────────────────────────────────────────

// Rupees (number or string) -> integer paise. Returns 0 for anything
// unparseable so a blank input can never poison a running total with NaN.
export function toPaise(rupees) {
  const n = typeof rupees === 'string' ? parseFloat(rupees) : Number(rupees)
  if (!Number.isFinite(n)) return 0
  // toFixed(4) first: Math.round(1234.565 * 100) is 123456 because the product
  // is actually 123456.49999..., so the half-up rounding silently loses a paisa.
  return Math.round(Number((n * 100).toFixed(4)))
}

export function fromPaise(paise) {
  const n = Number(paise)
  if (!Number.isFinite(n)) return 0
  return Math.round(n) / 100
}

// Percentage of a paise amount, rounded to the nearest paise.
export function pctOfPaise(paise, pct) {
  const p = Number(pct)
  if (!Number.isFinite(p)) return 0
  return Math.round((Number(paise) || 0) * (p / 100))
}

// Utilisation as a percentage, to two decimals. A zero limit yields 0 rather
// than Infinity, so a half-configured card renders instead of printing "∞%".
export function utilizationPct(balancePaise, limitPaise) {
  const limit = Number(limitPaise) || 0
  if (limit <= 0) return 0
  return Math.round(((Number(balancePaise) || 0) / limit) * 10000) / 100
}

// ── Dates ────────────────────────────────────────────────────────
// Every date in this engine is an ISO 'YYYY-MM-DD' string, manipulated through
// Date.UTC so no local-timezone offset can ever shift the day.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseISO(iso) {
  const m = ISO_RE.exec(String(iso || ''))
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const ts = Date.UTC(y, mo - 1, d)
  const dt = new Date(ts)
  // Rejects impossible dates such as 2026-02-30, which Date.UTC would silently
  // roll forward into March.
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt
}

export function toISO(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

export function addDays(iso, n) {
  const dt = parseISO(iso)
  if (!dt) return null
  return toISO(new Date(dt.getTime() + n * 86400000))
}

// Whole days from a to b (b - a). Both are UTC midnights, so this is exact and
// never off-by-one from a DST hour.
export function daysBetween(aIso, bIso) {
  const a = parseISO(aIso), b = parseISO(bIso)
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export function compareISO(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// A statement day of 31 has to mean "28th" in February and "30th" in April.
// Clamping to the month length is what every issuer does.
export function dateOnDayOfMonth(year, monthIndex, day) {
  const y = year + Math.floor(monthIndex / 12)
  const m = ((monthIndex % 12) + 12) % 12
  const d = Math.min(Math.max(Number(day) || 1, 1), daysInMonth(y, m))
  return toISO(new Date(Date.UTC(y, m, d)))
}

// ── Cycle geometry ───────────────────────────────────────────────

// Statement date of the cycle that is still open on `todayIso` -- i.e. the
// first statement date on or after today.
export function nextStatementDate(statementDay, todayIso) {
  const today = parseISO(todayIso)
  if (!today) return null
  const y = today.getUTCFullYear(), m = today.getUTCMonth()
  const thisMonth = dateOnDayOfMonth(y, m, statementDay)
  // On the statement day itself the statement has not closed yet, so today
  // still belongs to the open cycle.
  if (compareISO(thisMonth, todayIso) >= 0) return thisMonth
  return dateOnDayOfMonth(y, m + 1, statementDay)
}

// Due date belonging to a given statement date. If the configured due day is
// not strictly after the statement day it falls in the following month -- the
// usual case (statement 25th, due 14th).
export function dueDateFor(statementIso, dueDay) {
  const st = parseISO(statementIso)
  if (!st) return null
  const y = st.getUTCFullYear(), m = st.getUTCMonth()
  const sameMonth = dateOnDayOfMonth(y, m, dueDay)
  if (compareISO(sameMonth, statementIso) > 0) return sameMonth
  return dateOnDayOfMonth(y, m + 1, dueDay)
}

// The cycle whose statement is `statementIso`: it opens the day after the
// previous statement closed.
export function cycleFor(statementIso, statementDay, dueDay) {
  const st = parseISO(statementIso)
  if (!st) return null
  const prev = dateOnDayOfMonth(st.getUTCFullYear(), st.getUTCMonth() - 1, statementDay)
  return {
    start: addDays(prev, 1),
    statementDate: statementIso,
    dueDate: dueDateFor(statementIso, dueDay),
  }
}

// ── Ledger ───────────────────────────────────────────────────────

function normalizeEntries(rows, dateKey) {
  return (rows || [])
    .map((r) => ({ date: String(r?.[dateKey] || ''), paise: toPaise(r?.amount) }))
    .filter((r) => parseISO(r.date) && r.paise > 0)
}

// Outstanding balance as at the end of `asOfIso`, inclusive.
//
// A credit card revolves, so the balance is simply everything charged minus
// everything paid up to that date -- there is no per-cycle reset. The opening
// balance covers whatever was already owed when the card was added.
export function balanceAsOf({ openingPaise = 0, spends = [], payments = [] }, asOfIso) {
  if (!parseISO(asOfIso)) return 0
  let bal = Number(openingPaise) || 0
  for (const s of spends) if (compareISO(s.date, asOfIso) <= 0) bal += s.paise
  for (const p of payments) if (compareISO(p.date, asOfIso) <= 0) bal -= p.paise
  // A credit balance (overpayment) is reported as nil utilisation, not as
  // negative utilisation, so it is floored here.
  return Math.max(0, bal)
}

function sumBetween(entries, fromIso, toIso) {
  let total = 0
  for (const e of entries) {
    if (compareISO(e.date, fromIso) >= 0 && compareISO(e.date, toIso) <= 0) total += e.paise
  }
  return total
}

// ── Planner ──────────────────────────────────────────────────────

// How many days before the statement the top-up should land. Card payments
// take up to 2 working days to post, and only the balance that has actually
// posted by the statement time is the one reported.
export const PRE_STATEMENT_LEAD_DAYS = 2

// Clearance buffer before the due date. Paying on the due date itself risks a
// late mark if the transfer posts next morning.
export const CLEARANCE_LEAD_DAYS = 3

// Reported utilisation the planner treats as the top band.
export const IDEAL_UTILIZATION_PCT = 10

// Bureaus score a small reported balance above a nil one -- a card reported at
// zero month after month can read as dormant and stops building history. So
// when the target works out to nothing, aim for a token balance instead.
export const MIN_REPORTED_PAISE = 10000 // ₹100

export function targetReportedBalance(limitPaise, targetPct) {
  const limit = Number(limitPaise) || 0
  if (limit <= 0) return 0
  const target = pctOfPaise(limit, targetPct)
  if (target >= MIN_REPORTED_PAISE) return target
  // Never aim above the limit on a very small card.
  return Math.min(MIN_REPORTED_PAISE, limit)
}

export function normalizeCard(card) {
  const statementDay = Math.min(Math.max(parseInt(card?.statement_day, 10) || 1, 1), 31)
  const dueDay = Math.min(Math.max(parseInt(card?.due_day, 10) || 20, 1), 31)
  const targetPctRaw = Number(card?.target_utilization)
  return {
    id: card?.id || null,
    name: card?.card_name || 'My Card',
    limitPaise: toPaise(card?.credit_limit),
    openingPaise: toPaise(card?.opening_balance),
    statementDay,
    dueDay,
    targetPct: Number.isFinite(targetPctRaw) && targetPctRaw > 0 && targetPctRaw <= 100
      ? targetPctRaw
      : IDEAL_UTILIZATION_PCT,
  }
}

function utilizationBand(pct) {
  if (pct <= 10) return { band: 'excellent', label: 'Excellent', tone: 'green' }
  if (pct <= 30) return { band: 'good', label: 'Good', tone: 'blue' }
  if (pct <= 50) return { band: 'fair', label: 'Fair', tone: 'amber' }
  if (pct <= 75) return { band: 'poor', label: 'Poor', tone: 'orange' }
  return { band: 'critical', label: 'Critical', tone: 'red' }
}

/**
 * The full plan for the open cycle.
 *
 * Returns the two payments that matter, in the order they must happen:
 *   1. a pre-statement top-up, which is what actually moves the score, and
 *   2. a clearance payment, which is what avoids interest.
 */
export function buildPlan({ card, spends = [], payments = [], today }) {
  const c = normalizeCard(card)
  const todayIso = parseISO(today) ? today : toISO(new Date())
  const s = normalizeEntries(spends, 'spend_date')
  const p = normalizeEntries(payments, 'pay_date')
  const ledger = { openingPaise: c.openingPaise, spends: s, payments: p }

  const statementDate = nextStatementDate(c.statementDay, todayIso)
  const dueDate = dueDateFor(statementDate, c.dueDay)
  const cycle = cycleFor(statementDate, c.statementDay, c.dueDay)

  const currentBalance = balanceAsOf(ledger, todayIso)
  // Everything recorded so far will still be on the statement, so today's
  // balance is the projection unless more is spent.
  const projectedStatement = balanceAsOf(ledger, statementDate)

  const targetBalance = targetReportedBalance(c.limitPaise, c.targetPct)
  const preStatementPay = Math.max(0, projectedStatement - targetBalance)
  const reportedIfFollowed = projectedStatement - preStatementPay
  const clearancePay = reportedIfFollowed

  const payByDate = addDays(statementDate, -PRE_STATEMENT_LEAD_DAYS)
  const clearByDate = addDays(dueDate, -CLEARANCE_LEAD_DAYS)

  const currentPct = utilizationPct(currentBalance, c.limitPaise)
  const projectedPct = utilizationPct(projectedStatement, c.limitPaise)
  const reportedPct = utilizationPct(reportedIfFollowed, c.limitPaise)

  const actions = []
  if (preStatementPay > 0) {
    const daysLeft = daysBetween(todayIso, payByDate)
    actions.push({
      id: 'pre-statement',
      kind: 'pre_statement',
      title: 'Pay before statement closes',
      amountPaise: preStatementPay,
      byDate: payByDate,
      daysLeft,
      status: daysLeft < 0 ? 'overdue' : daysLeft <= 2 ? 'urgent' : 'upcoming',
      // Structured rather than a ready-made sentence: formatting a date for
      // display is the view's job, and building it here produced ISO dates in
      // the middle of a page that formats every other date as "25 Nov 2026".
      why: {
        onDate: statementDate,
        fromPct: utilizationPct(projectedStatement, c.limitPaise),
        toPct: reportedPct,
      },
    })
  }
  if (clearancePay > 0) {
    const daysLeft = daysBetween(todayIso, clearByDate)
    actions.push({
      id: 'clearance',
      kind: 'clearance',
      title: 'Clear the remaining statement balance',
      amountPaise: clearancePay,
      byDate: clearByDate,
      daysLeft,
      status: daysLeft < 0 ? 'overdue' : daysLeft <= 2 ? 'urgent' : 'upcoming',
      why: { onDate: dueDate },
    })
  }

  // Headroom before the next rupee spent would push the reported figure past
  // target. Negative headroom is surfaced as zero plus a warning.
  const safeToSpend = Math.max(0, targetBalance - currentBalance)

  return {
    card: c,
    today: todayIso,
    cycle,
    statementDate,
    dueDate,
    daysToStatement: daysBetween(todayIso, statementDate),
    daysToDue: daysBetween(todayIso, dueDate),
    currentBalancePaise: currentBalance,
    projectedStatementPaise: projectedStatement,
    targetBalancePaise: targetBalance,
    preStatementPayPaise: preStatementPay,
    clearancePayPaise: clearancePay,
    reportedIfFollowedPaise: reportedIfFollowed,
    payByDate,
    clearByDate,
    currentPct,
    projectedPct,
    reportedPct,
    currentBand: utilizationBand(currentPct),
    projectedBand: utilizationBand(projectedPct),
    safeToSpendPaise: safeToSpend,
    spentThisCyclePaise: sumBetween(s, cycle.start, statementDate),
    actions,
  }
}

// ── History ──────────────────────────────────────────────────────

// The last `count` closed cycles, newest first, with what was actually
// reported and whether the statement was cleared before its due date.
export function buildHistory({ card, spends = [], payments = [], today, count = 6 }) {
  const c = normalizeCard(card)
  const todayIso = parseISO(today) ? today : toISO(new Date())
  const s = normalizeEntries(spends, 'spend_date')
  const p = normalizeEntries(payments, 'pay_date')
  const ledger = { openingPaise: c.openingPaise, spends: s, payments: p }

  const open = nextStatementDate(c.statementDay, todayIso)
  const openDt = parseISO(open)
  const out = []

  for (let i = 1; i <= count; i += 1) {
    const stIso = dateOnDayOfMonth(openDt.getUTCFullYear(), openDt.getUTCMonth() - i, c.statementDay)
    const cyc = cycleFor(stIso, c.statementDay, c.dueDay)
    const reported = balanceAsOf(ledger, stIso)
    const paidInWindow = sumBetween(p, addDays(stIso, 1), cyc.dueDate)
    const spent = sumBetween(s, cyc.start, stIso)

    // A cycle with no balance and no activity is one we have no data for --
    // showing it as a flawless month would be inventing history.
    const hasData = reported > 0 || spent > 0 || paidInWindow > 0
    const dueIsPast = compareISO(cyc.dueDate, todayIso) < 0

    // Distinguishing these cases matters: a nil statement is not a missed
    // payment (nothing was owed), and a cycle we hold no data for is not a
    // clean one. Collapsing either into a pass/fail flag puts a false mark on
    // the user's payment history, which is the most alarming thing this page
    // could get wrong.
    let status
    if (!hasData) status = 'no-data'
    else if (!dueIsPast) status = 'pending'
    else if (reported === 0) status = 'nothing-due'
    else status = paidInWindow >= reported ? 'on-time' : 'missed'

    out.push({
      ...cyc,
      reportedPaise: reported,
      reportedPct: utilizationPct(reported, c.limitPaise),
      spentPaise: spent,
      paidPaise: paidInWindow,
      hasData,
      status,
      // Tri-state on purpose: null means "not judged", not "failed".
      onTime: status === 'on-time' ? true : status === 'missed' ? false : null,
    })
  }
  return out
}

// ── Score guidance ───────────────────────────────────────────────

export const SCORE_GOAL = 850

/**
 * A checklist of the levers that actually drive a CIBIL score, scored from the
 * data we hold.
 *
 * Deliberately NOT an attempt to predict the number: a real score also uses
 * loans, enquiries, other cards and account age that this app cannot see.
 * Presenting a made-up figure as "your score" would be the most harmful thing
 * this page could do, so it reports progress on the levers instead.
 */
export function scoreFactors({ plan, history = [] }) {
  const factors = []
  const judged = history.filter((h) => h.onTime !== null)
  const onTimeCount = judged.filter((h) => h.onTime).length

  factors.push({
    id: 'payment-history',
    label: 'On-time payments',
    weight: 35,
    detail: judged.length
      ? `${onTimeCount} of ${judged.length} recent cycles cleared in full before the due date`
      : 'No completed cycles recorded yet',
    status: !judged.length ? 'unknown' : onTimeCount === judged.length ? 'good' : 'bad',
    advice: 'A single payment 30+ days late can cost 50-100 points and stays on your report for years. This is the largest single factor.',
  })

  // Judged on the projected figure -- what gets reported if no action is taken
  // -- not on the post-plan figure. Scoring the plan's outcome would show this
  // lever as green while a large top-up is still unpaid, which is precisely
  // when the user most needs to see a warning.
  const pct = plan?.projectedPct ?? 0
  const afterPlan = plan?.reportedPct ?? 0
  factors.push({
    id: 'utilization',
    label: 'Reported utilisation',
    weight: 30,
    detail: pct > afterPlan
      ? `${pct}% reports at the next statement if you do nothing; ${afterPlan}% if you follow the plan`
      : `${pct}% would be reported at the next statement`,
    status: pct > 30 ? 'bad' : pct > 10 ? 'warn' : 'good',
    advice: `Keep the statement-date balance under ${IDEAL_UTILIZATION_PCT}% of the limit. This is the only factor you can change within a single month.`,
  })

  const reportsZero = (plan?.reportedIfFollowedPaise ?? 0) === 0 && (plan?.card?.limitPaise ?? 0) > 0
  factors.push({
    id: 'activity',
    label: 'Card stays active',
    weight: 15,
    detail: reportsZero
      ? 'Nil balance would be reported this cycle'
      : 'A small balance will be reported, which is what you want',
    status: reportsZero ? 'warn' : 'good',
    advice: 'Reporting ₹0 every month can look dormant and slows history building. A small reported balance, cleared in full, scores better than nothing at all.',
  })

  factors.push({
    id: 'age',
    label: 'Credit age',
    weight: 20,
    detail: 'Builds automatically the longer the card stays open',
    status: 'info',
    advice: 'Never close your oldest card. Age of credit cannot be rushed, and closing an old card shortens your average history.',
  })

  const good = factors.filter((f) => f.status === 'good').length
  const actionable = factors.filter((f) => f.status !== 'info').length

  return {
    goal: SCORE_GOAL,
    factors,
    onTrack: factors.every((f) => f.status === 'good' || f.status === 'info'),
    readyCount: good,
    actionableCount: actionable,
  }
}
