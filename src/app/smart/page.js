'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'
import { todayStr } from '@/lib/finance'
import { readPageCache, writePageCache } from '@/lib/pageCache'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'
import { useConfirm } from '@/context/ConfirmDialogContext'
import {
  buildPlan, buildHistory, scoreFactors, fromPaise,
  IDEAL_UTILIZATION_PCT, SCORE_GOAL,
} from '@/lib/creditCardPlanner'

// This page is deliberately self-contained: it reads and writes only the three
// credit_card_* tables, which are keyed to the signed-in user rather than to a
// shop. Switching shops must not change what is shown here, and no shop
// colleague should ever see these figures, so `shop` is never used in a query.

const blankCard = {
  card_name: '', issuer: '', last4: '',
  credit_limit: '', statement_day: '25', due_day: '14',
  target_utilization: String(IDEAL_UTILIZATION_PCT), opening_balance: '',
}

const blankSpend = { spend_date: todayStr(), amount: '', label: '', category: '' }
const blankPayment = { pay_date: todayStr(), amount: '', kind: 'clearance', note: '' }

const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => String(i + 1))

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtShortDate(iso) {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

function relativeDays(days) {
  if (!Number.isFinite(days)) return ''
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
  return `in ${days} days`
}

const TONE = {
  green:  { bar: 'bg-green-500',  text: 'text-green-700',  chip: 'bg-green-50 text-green-700 border-green-200' },
  blue:   { bar: 'bg-blue-500',   text: 'text-blue-700',   chip: 'bg-blue-50 text-blue-700 border-blue-200' },
  amber:  { bar: 'bg-amber-500',  text: 'text-amber-700',  chip: 'bg-amber-50 text-amber-700 border-amber-200' },
  orange: { bar: 'bg-orange-500', text: 'text-orange-700', chip: 'bg-orange-50 text-orange-700 border-orange-200' },
  red:    { bar: 'bg-red-500',    text: 'text-red-700',    chip: 'bg-red-50 text-red-700 border-red-200' },
}

function StatCard({ label, value, hint, className = '' }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-xs text-gray-500 truncate">{label}</div>
      <div className={`text-lg sm:text-xl font-bold mt-1 tabular-nums break-words ${className}`}>{value}</div>
      {hint && <div className="text-[11px] text-gray-400 mt-0.5 leading-snug">{hint}</div>}
    </div>
  )
}

function UtilizationBar({ pct, tone }) {
  const t = TONE[tone] || TONE.blue
  return (
    <div className="mt-2">
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${t.bar}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
        <span>0%</span><span>{IDEAL_UTILIZATION_PCT}% ideal</span><span>30%</span><span>100%</span>
      </div>
    </div>
  )
}

function ActionCard({ action, onRecord }) {
  const tone = action.status === 'overdue' ? 'red' : action.status === 'urgent' ? 'amber' : 'green'
  const t = TONE[tone]
  return (
    <div className="bg-white border rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-sm text-gray-900">{action.title}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            by {fmtDate(action.byDate)} · {relativeDays(action.daysLeft)}
          </div>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${t.chip}`}>
          {action.status === 'overdue' ? 'Window missed' : action.status === 'urgent' ? 'Act now' : 'Scheduled'}
        </span>
      </div>
      <div className={`text-2xl sm:text-3xl font-bold mt-3 tabular-nums ${t.text}`}>
        {fmt(fromPaise(action.amountPaise))}
      </div>
      <p className="text-xs text-gray-500 mt-2 leading-relaxed">
        {action.kind === 'pre_statement' ? (
          <>
            Lowers the balance reported on {fmtDate(action.why.onDate)} from{' '}
            {action.why.fromPct}% to {action.why.toPct}% of your limit. This is the
            payment that moves your score.
          </>
        ) : (
          <>
            Pays the statement in full before the {fmtDate(action.why.onDate)} due
            date, so no interest is charged and the cycle is marked paid on time.
          </>
        )}
      </p>
      <button onClick={() => onRecord(action)}
        className="mt-3 w-full sm:w-auto px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
        Record this payment
      </button>
    </div>
  )
}

const FACTOR_DOT = {
  good: 'bg-green-500', warn: 'bg-amber-500', bad: 'bg-red-500',
  unknown: 'bg-gray-300', info: 'bg-blue-400',
}

const HISTORY_STATUS = {
  'on-time':     { label: 'Paid on time', cell: 'Yes', className: 'text-green-600' },
  missed:        { label: 'Missed',       cell: 'No',  className: 'text-red-600' },
  'nothing-due': { label: 'Nothing due',  cell: '—',   className: 'text-gray-400' },
  pending:       { label: 'Not due yet',  cell: '—',   className: 'text-gray-400' },
  'no-data':     { label: 'No record',    cell: '—',   className: 'text-gray-300' },
}

export default function SmartCardPage() {
  const { user, loading: shopLoading } = useShop()
  const { confirm } = useConfirm()

  const [card, setCard] = useState(null)
  const [spends, setSpends] = useState([])
  const [payments, setPayments] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('plan')

  const [cardForm, setCardForm] = useState(blankCard)
  const [editingCard, setEditingCard] = useState(false)
  const [spendForm, setSpendForm] = useState(blankSpend)
  const [payForm, setPayForm] = useState(blankPayment)
  const [showPayForm, setShowPayForm] = useState(false)

  const cacheKey = user?.id ? `smart-card:${user.id}` : ''
  const initialCache = readPageCache(cacheKey)
  const [loading, setLoading] = useState(() => !initialCache)
  usePageLoadingState('smart-card-page', loading)

  const load = useCallback(async () => {
    if (!user?.id) {
      setCard(null); setSpends([]); setPayments([]); setError(''); setLoading(false)
      return
    }

    const cached = readPageCache(cacheKey)
    if (cached?.card !== undefined) {
      setCard(cached.card); setSpends(cached.spends || []); setPayments(cached.payments || [])
      setLoading(false)
    } else {
      setLoading(true)
    }

    // user_id is filtered explicitly as well as by RLS. The policy is the real
    // boundary, but an explicit filter means a policy change can never silently
    // widen what this page displays.
    const { data: cards, error: cardErr } = await supabase
      .from('credit_cards').select('*')
      .eq('user_id', user.id).eq('is_active', true)
      .order('created_at', { ascending: true }).limit(1)

    if (cardErr) {
      setError(cardErr.message || 'Failed to load your card')
      setLoading(false)
      return
    }

    const activeCard = cards?.[0] || null
    if (!activeCard) {
      setCard(null); setSpends([]); setPayments([])
      writePageCache(cacheKey, { card: null, spends: [], payments: [] })
      setError(''); setLoading(false)
      return
    }

    const [{ data: spendRows, error: spendErr }, { data: payRows, error: payErr }] = await Promise.all([
      supabase.from('credit_card_spends').select('*')
        .eq('user_id', user.id).eq('card_id', activeCard.id)
        .order('spend_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('credit_card_payments').select('*')
        .eq('user_id', user.id).eq('card_id', activeCard.id)
        .order('pay_date', { ascending: false }).order('created_at', { ascending: false }),
    ])

    if (spendErr || payErr) {
      setError((spendErr || payErr).message || 'Failed to load card activity')
      setLoading(false)
      return
    }

    const nextSpends = spendRows || []
    const nextPayments = payRows || []
    setCard(activeCard); setSpends(nextSpends); setPayments(nextPayments)
    writePageCache(cacheKey, { card: activeCard, spends: nextSpends, payments: nextPayments })
    setError(''); setLoading(false)
  }, [cacheKey, user?.id])

  useEffect(() => { load() }, [load])

  // Recomputed from today's date so the plan is never stale across midnight.
  const today = todayStr()
  const plan = useMemo(
    () => (card ? buildPlan({ card, spends, payments, today }) : null),
    [card, spends, payments, today]
  )
  const history = useMemo(
    () => (card ? buildHistory({ card, spends, payments, today, count: 6 }) : []),
    [card, spends, payments, today]
  )
  const factors = useMemo(
    () => (plan ? scoreFactors({ plan, history }) : null),
    [plan, history]
  )

  function openCardEditor() {
    if (card) {
      setCardForm({
        card_name: card.card_name || '', issuer: card.issuer || '', last4: card.last4 || '',
        credit_limit: card.credit_limit ?? '', statement_day: String(card.statement_day || 25),
        due_day: String(card.due_day || 14),
        target_utilization: String(card.target_utilization ?? IDEAL_UTILIZATION_PCT),
        opening_balance: card.opening_balance ?? '',
      })
    } else {
      setCardForm(blankCard)
    }
    setEditingCard(true)
  }

  async function saveCard() {
    const limit = parseFloat(cardForm.credit_limit)
    if (!(limit > 0)) { setError('Enter a credit limit greater than zero'); return }
    const last4 = String(cardForm.last4 || '').trim()
    if (last4 && !/^\d{4}$/.test(last4)) { setError('Last 4 digits must be exactly four numbers'); return }

    const targetPct = parseFloat(cardForm.target_utilization)
    setSaving(true); setError('')

    const payload = {
      card_name: cardForm.card_name.trim() || 'My Card',
      issuer: cardForm.issuer.trim() || null,
      last4: last4 || null,
      credit_limit: limit,
      statement_day: parseInt(cardForm.statement_day, 10) || 25,
      due_day: parseInt(cardForm.due_day, 10) || 14,
      target_utilization: Number.isFinite(targetPct) && targetPct > 0 && targetPct <= 100
        ? targetPct : IDEAL_UTILIZATION_PCT,
      opening_balance: parseFloat(cardForm.opening_balance) || 0,
    }

    // user_id is left out on insert so the column default (auth.uid()) fills
    // it. Sending it from the client would be the one value worth spoofing.
    const { error: saveErr } = card
      ? await supabase.from('credit_cards').update(payload).eq('id', card.id).eq('user_id', user.id)
      : await supabase.from('credit_cards').insert(payload)

    if (saveErr) { setError(saveErr.message || 'Failed to save card'); setSaving(false); return }
    setEditingCard(false); setSaving(false)
    await load()
  }

  async function addSpend() {
    const amount = parseFloat(spendForm.amount)
    if (!(amount > 0)) { setError('Enter a spend amount greater than zero'); return }
    if (!card?.id) return
    setSaving(true); setError('')

    const { error: insErr } = await supabase.from('credit_card_spends').insert({
      card_id: card.id,
      spend_date: spendForm.spend_date || todayStr(),
      amount,
      label: spendForm.label.trim() || null,
      category: spendForm.category.trim() || null,
    })

    if (insErr) { setError(insErr.message || 'Failed to add spend'); setSaving(false); return }
    setSpendForm({ ...blankSpend, spend_date: spendForm.spend_date })
    setSaving(false)
    await load()
  }

  async function addPayment() {
    const amount = parseFloat(payForm.amount)
    if (!(amount > 0)) { setError('Enter a payment amount greater than zero'); return }
    if (!card?.id) return
    setSaving(true); setError('')

    const { error: insErr } = await supabase.from('credit_card_payments').insert({
      card_id: card.id,
      pay_date: payForm.pay_date || todayStr(),
      amount,
      kind: payForm.kind,
      note: payForm.note.trim() || null,
    })

    if (insErr) { setError(insErr.message || 'Failed to record payment'); setSaving(false); return }
    setPayForm({ ...blankPayment, pay_date: todayStr() })
    setShowPayForm(false); setSaving(false)
    await load()
  }

  function recordPlanned(action) {
    setPayForm({
      pay_date: todayStr(),
      amount: String(fromPaise(action.amountPaise)),
      kind: action.kind,
      note: action.title,
    })
    setShowPayForm(true)
    setTab('activity')
  }

  async function removeRow(table, id, label) {
    const ok = await confirm({
      title: `Remove this ${label}?`,
      message: 'It is deleted permanently and every figure on this page is recalculated without it.',
      confirmLabel: 'Remove',
    })
    if (!ok) return
    setError('')
    const { error: delErr } = await supabase.from(table).delete().eq('id', id).eq('user_id', user.id)
    if (delErr) { setError(delErr.message || 'Failed to remove entry'); return }
    await load()
  }

  if (shopLoading || loading) {
    return <div className="p-4"><LoadingPlaceholder label="Loading your card plan" rows={5} fullPage /></div>
  }

  if (!user?.id) {
    return (
      <div className="p-4">
        <div className="bg-white rounded-xl border p-8 text-center text-gray-500">
          Sign in to use the credit card planner.
        </div>
      </div>
    )
  }

  const errorBanner = error ? (
    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 break-words">
      {error}
    </div>
  ) : null

  // ── Setup / edit form ──────────────────────────────────────────
  if (!card || editingCard) {
    return (
      <div className="p-3 sm:p-4 max-w-2xl mx-auto">
        <h1 className="text-lg sm:text-xl font-bold">{card ? 'Edit card' : 'Set up your credit card'}</h1>
        <p className="text-xs sm:text-sm text-gray-500 mt-1 mb-4 leading-relaxed">
          Private to your login. This is kept completely separate from your shop&apos;s billing,
          expenses and banking data.
        </p>
        {errorBanner}

        <div className="bg-white rounded-xl border p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Card name</label>
              <input value={cardForm.card_name} onChange={e => setCardForm(p => ({ ...p, card_name: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="My Card" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Bank / issuer</label>
              <input value={cardForm.issuer} onChange={e => setCardForm(p => ({ ...p, issuer: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="HDFC, ICICI, SBI..." />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Last 4 digits (optional)</label>
              <input value={cardForm.last4} inputMode="numeric" maxLength={4}
                onChange={e => setCardForm(p => ({ ...p, last4: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="1234" />
              <p className="text-[11px] text-gray-400 mt-1">Never enter the full card number.</p>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Credit limit *</label>
              <input type="number" min="0" step="0.01" inputMode="decimal" value={cardForm.credit_limit}
                onChange={e => setCardForm(p => ({ ...p, credit_limit: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="100000" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Statement / billing day *</label>
              <select value={cardForm.statement_day} onChange={e => setCardForm(p => ({ ...p, statement_day: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm">
                {DAY_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">The day your bill is generated. Your balance is reported to the bureau on this day.</p>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Payment due day *</label>
              <select value={cardForm.due_day} onChange={e => setCardForm(p => ({ ...p, due_day: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm">
                {DAY_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">Treated as next month when it is not after the statement day.</p>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Target utilisation %</label>
              <input type="number" min="1" max="100" step="0.5" inputMode="decimal" value={cardForm.target_utilization}
                onChange={e => setCardForm(p => ({ ...p, target_utilization: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
              <p className="text-[11px] text-gray-400 mt-1">{IDEAL_UTILIZATION_PCT}% is the sweet spot for scoring.</p>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Balance already outstanding</label>
              <input type="number" min="0" step="0.01" inputMode="decimal" value={cardForm.opening_balance}
                onChange={e => setCardForm(p => ({ ...p, opening_balance: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0.00" />
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-2">
            {card && (
              <button onClick={() => { setEditingCard(false); setError('') }}
                className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
            )}
            <button onClick={saveCard} disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : card ? 'Save changes' : 'Start planning'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main dashboard ─────────────────────────────────────────────
  return (
    <div className="p-3 sm:p-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-bold truncate">
            {card.card_name}
            {card.last4 && <span className="text-gray-400 font-normal"> ···· {card.last4}</span>}
          </h1>
          <div className="text-xs sm:text-sm text-gray-500 mt-0.5">
            {card.issuer ? `${card.issuer} · ` : ''}Limit {fmt(card.credit_limit)} · Statement {fmtShortDate(plan.statementDate)} · Due {fmtShortDate(plan.dueDate)}
          </div>
        </div>
        <button onClick={openCardEditor}
          className="px-3 py-2 border rounded-lg text-sm hover:bg-gray-50 whitespace-nowrap">Edit card</button>
      </div>

      {errorBanner}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 mb-4">
        <StatCard label="Outstanding now" value={fmt(fromPaise(plan.currentBalancePaise))}
          hint={`${plan.currentPct}% of limit`} className={TONE[plan.currentBand.tone].text} />
        <StatCard label="Will report on statement" value={`${plan.projectedPct}%`}
          hint={fmt(fromPaise(plan.projectedStatementPaise))} className={TONE[plan.projectedBand.tone].text} />
        <StatCard label="Safe to spend" value={fmt(fromPaise(plan.safeToSpendPaise))}
          hint={`Keeps you at or under ${card.target_utilization}%`} className="text-gray-900" />
        <StatCard label="Statement closes" value={relativeDays(plan.daysToStatement)}
          hint={fmtDate(plan.statementDate)} className="text-gray-900" />
      </div>

      <div className="bg-white border rounded-xl p-4 mb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">Projected reported utilisation</span>
          <span className={`text-sm font-bold ${TONE[plan.projectedBand.tone].text}`}>
            {plan.projectedPct}% · {plan.projectedBand.label}
          </span>
        </div>
        <UtilizationBar pct={plan.projectedPct} tone={plan.projectedBand.tone} />
        {plan.preStatementPayPaise > 0 && (
          <p className="text-xs text-gray-500 mt-3 leading-relaxed">
            Following the plan below brings this down to{' '}
            <span className="font-semibold text-green-700">{plan.reportedPct}%</span> before the
            statement is generated on {fmtDate(plan.statementDate)}.
          </p>
        )}
      </div>

      <div className="flex gap-1 border-b mb-4 overflow-x-auto">
        {[['plan', 'Action plan'], ['activity', 'Spends & payments'], ['history', 'History'], ['score', 'Score levers']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-3 sm:px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === id ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'plan' && (
        <div className="space-y-3">
          {plan.actions.length === 0 ? (
            <div className="bg-white rounded-xl border p-6 sm:p-8 text-center">
              <div className="text-sm text-gray-700 font-medium">Nothing to pay right now</div>
              <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto leading-relaxed">
                Your balance is already at or below target. Add your spends as they happen and a
                plan will appear here.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {plan.actions.map(a => <ActionCard key={a.id} action={a} onRecord={recordPlanned} />)}
            </div>
          )}

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <div className="text-sm font-semibold text-blue-900">Why two payments?</div>
            <p className="text-xs text-blue-800 mt-1.5 leading-relaxed">
              Your bank reports your balance to the bureau on the <strong>statement date</strong>,
              not the due date. Paying only by the due date avoids interest but still reports a
              high balance. Paying down <em>before</em> the statement is what actually lowers the
              utilisation on your report.
            </p>
            <p className="text-xs text-blue-800 mt-2 leading-relaxed">
              Never pay only the minimum due. It keeps the account current but leaves a high
              reported balance and starts interest on the rest.
            </p>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-sm">All spends</span>
                <span className="text-xs text-gray-500 tabular-nums">
                  {fmt(fromPaise(plan.spentThisCyclePaise))} this cycle
                </span>
              </div>
              {spends.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-400">No spends recorded yet</div>
              ) : (
                <ul className="divide-y">
                  {spends.map(s => (
                    <li key={s.id} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-gray-900 truncate">{s.label || 'Spend'}</div>
                        <div className="text-[11px] text-gray-500">
                          {fmtDate(s.spend_date)}{s.category ? ` · ${s.category}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-sm font-semibold tabular-nums">{fmt(s.amount)}</span>
                        <button onClick={() => removeRow('credit_card_spends', s.id, 'spend')}
                          className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-sm">Payments made</span>
                <button onClick={() => { setShowPayForm(v => !v); setError('') }}
                  className="text-xs text-blue-600 hover:underline">
                  {showPayForm ? 'Close' : '+ Record payment'}
                </button>
              </div>

              {showPayForm && (
                <div className="p-4 border-b bg-gray-50 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Date</label>
                      <input type="date" value={payForm.pay_date}
                        onChange={e => setPayForm(p => ({ ...p, pay_date: e.target.value }))}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Amount *</label>
                      <input type="number" min="0" step="0.01" inputMode="decimal" value={payForm.amount}
                        onChange={e => setPayForm(p => ({ ...p, amount: e.target.value }))}
                        className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0.00" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Type</label>
                      <select value={payForm.kind} onChange={e => setPayForm(p => ({ ...p, kind: e.target.value }))}
                        className="w-full border rounded-lg px-3 py-2 text-sm">
                        <option value="pre_statement">Before statement (lowers reported balance)</option>
                        <option value="clearance">Statement clearance</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Note</label>
                      <input value={payForm.note} onChange={e => setPayForm(p => ({ ...p, note: e.target.value }))}
                        className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Optional" />
                    </div>
                  </div>
                  <button onClick={addPayment} disabled={saving}
                    className="w-full sm:w-auto px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50">
                    {saving ? 'Saving…' : 'Save payment'}
                  </button>
                </div>
              )}

              {payments.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-400">No payments recorded yet</div>
              ) : (
                <ul className="divide-y">
                  {payments.map(p => (
                    <li key={p.id} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-gray-900 truncate">{p.note || 'Payment'}</div>
                        <div className="text-[11px] text-gray-500">
                          {fmtDate(p.pay_date)} · {p.kind === 'pre_statement' ? 'Before statement' : p.kind === 'clearance' ? 'Clearance' : 'Other'}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-sm font-semibold text-green-700 tabular-nums">{fmt(p.amount)}</span>
                        <button onClick={() => removeRow('credit_card_payments', p.id, 'payment')}
                          className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl border p-4 lg:sticky lg:top-4">
              <h2 className="font-semibold text-sm mb-3">Add a spend</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input type="date" value={spendForm.spend_date}
                    onChange={e => setSpendForm(p => ({ ...p, spend_date: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Amount *</label>
                  <input type="number" min="0" step="0.01" inputMode="decimal" value={spendForm.amount}
                    onChange={e => setSpendForm(p => ({ ...p, amount: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">What for</label>
                  <input value={spendForm.label} onChange={e => setSpendForm(p => ({ ...p, label: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Fuel, groceries..." />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Category</label>
                  <input value={spendForm.category} onChange={e => setSpendForm(p => ({ ...p, category: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Optional" />
                </div>
                <button onClick={addSpend} disabled={saving}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Add spend'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="bg-white rounded-xl border overflow-hidden">
          {/* Table on wide screens, stacked cards on phones: a six-column money
              table cannot shrink to a phone width and stay readable. */}
          <table className="w-full text-sm hidden md:table">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs border-b">
                <th className="px-3 py-2 text-left">Statement</th>
                <th className="px-3 py-2 text-left">Due</th>
                <th className="px-3 py-2 text-right">Spent</th>
                <th className="px-3 py-2 text-right">Reported</th>
                <th className="px-3 py-2 text-right">Utilisation</th>
                <th className="px-3 py-2 text-right">Paid on time</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.statementDate} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2">{fmtDate(h.statementDate)}</td>
                  <td className="px-3 py-2 text-gray-500">{fmtDate(h.dueDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{h.hasData ? fmt(fromPaise(h.spentPaise)) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{h.hasData ? fmt(fromPaise(h.reportedPaise)) : '—'}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${h.reportedPct > 30 ? 'text-red-600' : 'text-gray-700'}`}>
                    {h.hasData ? `${h.reportedPct}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className={HISTORY_STATUS[h.status].className}>
                      {HISTORY_STATUS[h.status].cell}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="divide-y md:hidden">
            {history.map(h => (
              <li key={h.statementDate} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{fmtDate(h.statementDate)}</span>
                  <span className={`text-[11px] ${HISTORY_STATUS[h.status].className}`}>
                    {HISTORY_STATUS[h.status].label}
                  </span>
                </div>
                {h.hasData ? (
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                    <div><div className="text-gray-400">Spent</div><div className="tabular-nums">{fmt(fromPaise(h.spentPaise))}</div></div>
                    <div><div className="text-gray-400">Reported</div><div className="tabular-nums">{fmt(fromPaise(h.reportedPaise))}</div></div>
                    <div><div className="text-gray-400">Util</div>
                      <div className={`tabular-nums ${h.reportedPct > 30 ? 'text-red-600' : ''}`}>{h.reportedPct}%</div></div>
                  </div>
                ) : <div className="text-xs text-gray-400 mt-1">No activity recorded</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'score' && factors && (
        <div className="space-y-3">
          <div className="bg-white rounded-xl border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-sm">Levers toward {SCORE_GOAL}+</span>
              <span className="text-xs text-gray-500">{factors.readyCount} of {factors.actionableCount} on track</span>
            </div>
            <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
              These are the factors a bureau actually weighs. This page does not predict your
              score: your real CIBIL also reflects loans, enquiries and other cards that this app
              cannot see.
            </p>
          </div>

          {factors.factors.map(f => (
            <div key={f.id} className="bg-white rounded-xl border p-4">
              <div className="flex items-start gap-3">
                <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${FACTOR_DOT[f.status]}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900">{f.label}</span>
                    <span className="text-[11px] text-gray-400">~{f.weight}% of score</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1 leading-relaxed">{f.detail}</div>
                  <p className="text-[11px] text-gray-500 mt-1.5 leading-relaxed">{f.advice}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
