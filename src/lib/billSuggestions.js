import { supabase } from '@/lib/supabase'

// Columns every suggestion consumer needs to build a bill row.
export const SUGGESTION_PRODUCT_COLUMNS =
  'id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,mrp,purchase_price,selling_price,gst_rate,stock_qty,min_stock,hsn_code,supplier_id,is_active,search_text'

// Products billed on the last N invoices are skipped so suggestions keep
// surfacing items the counter has not just sold.
export async function fetchRecentlyBilledProductIds(shopId, billCount = 2) {
  if (!shopId) return []

  const { data: recentBills } = await supabase
    .from('bills')
    .select('id')
    .eq('shop_id', shopId)
    .eq('bill_type', 'invoice')
    .order('created_at', { ascending: false })
    .limit(billCount)

  const recentBillIds = (recentBills || []).map((bill) => bill.id).filter(Boolean)
  if (!recentBillIds.length) return []

  const { data: recentItems } = await supabase
    .from('bill_items')
    .select('product_id')
    .eq('shop_id', shopId)
    .in('bill_id', recentBillIds)

  return [...new Set((recentItems || []).map((item) => item.product_id).filter(Boolean))]
}

// The shared suggestion rule: active, in stock, and not on the recent invoices.
export function buildSuggestionQuery(shopId, excludedIds, selectArgs) {
  let query = supabase
    .from('products')
    .select(...selectArgs)
    .eq('shop_id', shopId)
    .eq('is_active', true)
    .gt('stock_qty', 0)
  if (excludedIds?.length) query = query.not('id', 'in', `(${excludedIds.join(',')})`)
  return query
}

// Pull a randomised pool of suggestion-eligible products for auto-fill.
export async function fetchSuggestionCandidates(shopId, { poolSize = 300 } = {}) {
  if (!shopId) return []

  const excludedIds = await fetchRecentlyBilledProductIds(shopId)

  const { count, error: countErr } = await buildSuggestionQuery(shopId, excludedIds, [
    'id',
    { count: 'exact', head: true },
  ])
  if (countErr) throw countErr

  const total = Number(count || 0)
  if (total <= 0) return []

  // Window into a random slice so repeated runs do not always hit the same ids.
  const size = Math.min(poolSize, total)
  const start = total > size ? Math.floor(Math.random() * (total - size + 1)) : 0

  const { data, error } = await buildSuggestionQuery(shopId, excludedIds, [SUGGESTION_PRODUCT_COLUMNS])
    .order('id')
    .range(start, start + size - 1)
  if (error) throw error

  return data || []
}

function shuffle(list) {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

// Allowed spread around the requested amount. The plan is deliberately kept off
// the exact target (MIN_VARIANCE_PCT) so totals look like real counter bills,
// while never drifting past MAX_VARIANCE_PCT.
export const MIN_VARIANCE_PCT = 4
export const MAX_VARIANCE_PCT = 8.5

// Totals ending in 0/5 read as "made up", so they are penalised and natural
// looking amounts such as 947 or 1024 win ties.
function roundnessPenalty(total) {
  const rupees = Math.round(total)
  if (Math.abs(total - rupees) > 0.005) return 0
  if (rupees % 100 === 0) return 70
  if (rupees % 50 === 0) return 55
  if (rupees % 25 === 0) return 40
  if (rupees % 10 === 0) return 30
  if (rupees % 5 === 0) return 15
  return 0
}

// Lower is better: band violations dominate, then closeness to the preferred
// variance window, then how round the total looks.
function scorePlan(total, goal) {
  if (!(goal > 0)) return Infinity
  const devPct = Math.abs((total - goal) / goal) * 100

  let score = roundnessPenalty(total)
  if (devPct > MAX_VARIANCE_PCT) score += (devPct - MAX_VARIANCE_PCT) * 500
  else if (devPct < MIN_VARIANCE_PCT) score += (MIN_VARIANCE_PCT - devPct) * 12
  return score
}

function attemptPlan(pool, target, { maxLines, maxQtyPerLine }) {
  const lines = []
  const used = new Map()
  let total = 0

  const order = shuffle(pool)

  for (const entry of order) {
    if (lines.length >= maxLines) break
    const remaining = target - total
    if (remaining <= 0) break
    if (entry.rate > remaining * 1.35) continue

    const stockCap = Math.max(1, Math.floor(entry.stock))
    const fitQty = Math.max(1, Math.round(remaining / entry.rate))
    const qty = Math.min(fitQty, stockCap, maxQtyPerLine)
    const lineTotal = round2(entry.rate * qty)

    // Never overshoot by more than half a unit's worth once something is picked.
    if (total + lineTotal > target + entry.rate * 0.5 && lines.length) continue

    const line = { product: entry.product, rate: entry.rate, quantity: qty, total: lineTotal }
    lines.push(line)
    used.set(entry.product.id, line)
    total = round2(total + lineTotal)
  }

  // Top-up pass: the greedy pass skips items whose unit price overshoots the
  // gap, which leaves the plan far short when the catalog is small. Add single
  // units — first to existing lines, then as new lines — whenever that moves
  // the running total closer to the target.
  let improved = true
  while (improved) {
    improved = false
    for (const entry of order) {
      const line = used.get(entry.product.id)
      const qty = line?.quantity || 0
      const stockCap = Math.max(1, Math.floor(entry.stock))
      if (qty >= Math.min(stockCap, maxQtyPerLine)) continue
      if (!line && lines.length >= maxLines) continue

      const next = round2(total + entry.rate)
      if (Math.abs(target - next) >= Math.abs(target - total)) continue

      if (line) {
        line.quantity += 1
        line.total = round2(line.rate * line.quantity)
      } else {
        const added = { product: entry.product, rate: entry.rate, quantity: 1, total: entry.rate }
        lines.push(added)
        used.set(entry.product.id, added)
      }
      total = next
      improved = true
    }
  }

  return { lines, total }
}

// Nudge quantities by a unit or two to break a round-looking total or to pull
// the plan inside the allowed band, keeping the best-scoring variation.
function polishPlan(plan, goal, { maxQtyPerLine }) {
  let { lines, total } = plan
  let best = scorePlan(total, goal)
  let improved = true

  while (improved) {
    improved = false
    for (const line of lines) {
      const stockCap = Math.max(1, Math.floor(Number(line.product.stock_qty) || 0))
      for (const delta of [1, -1, 2, -2]) {
        const qty = line.quantity + delta
        if (qty < 1 || qty > Math.min(stockCap, maxQtyPerLine)) continue

        const next = round2(total + line.rate * delta)
        const score = scorePlan(next, goal)
        if (score >= best) continue

        line.quantity = qty
        line.total = round2(line.rate * qty)
        total = next
        best = score
        improved = true
        break
      }
    }
  }

  return { lines, total }
}

// Highest total the eligible stock can reach, used to tell the user when a
// target is simply out of reach instead of silently under-filling.
function maxReachable(pool, { maxLines, maxQtyPerLine }) {
  return round2(
    [...pool]
      .sort((a, b) => b.rate * Math.min(b.stock, maxQtyPerLine) - a.rate * Math.min(a.stock, maxQtyPerLine))
      .slice(0, maxLines)
      .reduce((sum, e) => sum + e.rate * Math.min(Math.floor(e.stock), maxQtyPerLine), 0)
  )
}

/**
 * Build a set of bill lines whose combined (GST-inclusive) total lands inside
 * the allowed variance band around `target` — deliberately a few percent off
 * the exact amount, and preferring natural looking totals over round ones.
 *
 * products  — suggestion-eligible products (already filtered by the rules)
 * rateFor   — (product) => rate used on the bill row
 */
export function buildAutoFillPlan(products, target, { rateFor, maxLines = 12, maxQtyPerLine = 10, attempts = 60 } = {}) {
  const goal = Number(target) || 0
  if (goal <= 0) return { lines: [], total: 0, maxPossible: 0 }

  const pool = (products || [])
    .map((product) => {
      const rate = round2(rateFor ? rateFor(product) : (product.selling_price || product.mrp || 0))
      const stock = Number(product.stock_qty) || 0
      return { product, rate, stock }
    })
    .filter((entry) => entry.rate > 0 && entry.stock > 0)

  if (!pool.length) return { lines: [], total: 0, maxPossible: 0 }

  // A small catalog can't reach a large target at the default per-line cap even
  // when stock is plentiful, so raise the cap until the target is reachable.
  const reachGoal = goal * (1 + MAX_VARIANCE_PCT / 100)
  let qtyCap = maxQtyPerLine
  const ceiling = 99
  while (qtyCap < ceiling && maxReachable(pool, { maxLines, maxQtyPerLine: qtyCap }) < reachGoal) {
    qtyCap = Math.min(ceiling, qtyCap * 2)
  }

  const maxPossible = maxReachable(pool, { maxLines, maxQtyPerLine: qtyCap })

  let best = null
  for (let i = 0; i < attempts; i++) {
    // Aim each attempt at a random point inside the preferred variance window
    // (either side of the goal) so repeated runs produce varied, natural totals
    // instead of converging on the exact amount every time.
    const spread = MIN_VARIANCE_PCT + Math.random() * (MAX_VARIANCE_PCT - MIN_VARIANCE_PCT)
    const sign = Math.random() < 0.5 ? -1 : 1
    const aim = Math.min(goal * (1 + (sign * spread) / 100), maxPossible)

    const plan = polishPlan(
      attemptPlan(pool, aim, { maxLines, maxQtyPerLine: qtyCap }),
      goal,
      { maxQtyPerLine: qtyCap },
    )
    if (!plan.lines.length) continue

    const score = scorePlan(plan.total, goal)
    // Equal-scoring plans are chosen at random so a small catalog still shows
    // some variety when the same amount is generated repeatedly.
    if (!best || score < best.score || (score === best.score && Math.random() < 0.5)) {
      best = { ...plan, score }
    }
    if (best.score === 0 && Math.random() < 0.35) break
  }

  if (!best) return { lines: [], total: 0, maxPossible }
  return { lines: best.lines, total: best.total, maxPossible }
}
