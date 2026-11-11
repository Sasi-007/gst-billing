import { supabase } from '@/lib/supabase'
import { qtyRangeFor } from '@/lib/productArchetypes'

// Columns every suggestion consumer needs to build a bill row.
export const SUGGESTION_PRODUCT_COLUMNS =
  'id,name,local_name,search_aliases,bill_name_mode,brand,barcode,unit,mrp,purchase_price,selling_price,gst_rate,stock_qty,min_stock,hsn_code,supplier_id,is_active,search_text'

// Products billed on the last N invoices are skipped so suggestions keep
// surfacing items the counter has not just sold. Returns the id set per depth
// so callers can relax the rule when the strict pool runs dry.
export async function fetchRecentlyBilledProductIds(shopId, billCount = 2) {
  const byDepth = await fetchRecentlyBilledIdsByDepth(shopId, billCount)
  return byDepth[billCount] || []
}

// Map of { 1: ids on the latest invoice, 2: ids on the latest two, ... }.
export async function fetchRecentlyBilledIdsByDepth(shopId, billCount = 2) {
  const empty = {}
  for (let d = 1; d <= billCount; d++) empty[d] = []
  if (!shopId) return empty

  const { data: recentBills } = await supabase
    .from('bills')
    .select('id')
    .eq('shop_id', shopId)
    .eq('bill_type', 'invoice')
    .order('created_at', { ascending: false })
    .limit(billCount)

  const orderedBillIds = (recentBills || []).map((bill) => bill.id).filter(Boolean)
  if (!orderedBillIds.length) return empty

  const { data: recentItems } = await supabase
    .from('bill_items')
    .select('bill_id,product_id')
    .eq('shop_id', shopId)
    .in('bill_id', orderedBillIds)

  const result = { ...empty }
  for (let depth = 1; depth <= billCount; depth++) {
    const scope = new Set(orderedBillIds.slice(0, depth))
    result[depth] = [
      ...new Set(
        (recentItems || [])
          .filter((item) => scope.has(item.bill_id) && item.product_id)
          .map((item) => item.product_id)
      ),
    ]
  }
  return result
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

// Relaxation ladder used when the strict rule starves the pool. Each tier is
// tried in order and the least-relaxed one that actually helps is used.
export const SUGGESTION_TIERS = [
  { depth: 2, label: 'not billed on the last 2 invoices', note: null },
  { depth: 1, label: 'latest invoice only', note: 'includes items from your second-last invoice' },
  { depth: 0, label: 'no exclusion', note: 'repeats items from your last 2 invoices' },
]

// Relaxing the freshness rule is only worth it when it moves the total
// meaningfully closer to the target. When the shop simply does not hold enough
// stock, repeating recent items buys nothing, so the strict rule is kept.
const RELAX_GAIN_PCT = 5

/**
 * Pull a randomised pool of in-stock products for auto-fill, together with the
 * recently-billed id sets so the planner can relax the exclusion rule when the
 * strict pool cannot reach the target. One query — tiering happens in memory.
 */
export async function fetchSuggestionCandidates(shopId, { poolSize = 300 } = {}) {
  if (!shopId) return { pool: [], recentByDepth: { 1: [], 2: [] } }

  const recentByDepth = await fetchRecentlyBilledIdsByDepth(shopId)

  const { count, error: countErr } = await buildSuggestionQuery(shopId, [], [
    'id',
    { count: 'exact', head: true },
  ])
  if (countErr) throw countErr

  const total = Number(count || 0)
  if (total <= 0) return { pool: [], recentByDepth }

  // Window into a random slice so repeated runs do not always hit the same ids.
  const size = Math.min(poolSize, total)
  const start = total > size ? Math.floor(Math.random() * (total - size + 1)) : 0

  // Category sharpens the quantity archetype, so it is pulled in for auto-fill
  // only — the shared column list stays lean for the search typeahead.
  const { data, error } = await buildSuggestionQuery(shopId, [], [
    `${SUGGESTION_PRODUCT_COLUMNS},tags,category_id,categories(name)`,
  ])
    .order('id')
    .range(start, start + size - 1)
  if (error) throw error

  return { pool: data || [], recentByDepth }
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

// Bills of cover beyond which an item counts as overstocked. Below EASY it
// keeps its normal band; at DEEP it is pushed to the archetype ceiling.
const PRESSURE_EASY_BILLS = 25
const PRESSURE_DEEP_BILLS = 80

/**
 * How badly a product is overstocked, as 0..1.
 *
 * Measured in "bills of cover": how many bills it would take to clear the
 * stock at the item's own natural quantity. A shop holding 800 toffees moves
 * them ~8 at a time, so it is carrying ~100 bills of cover and needs every
 * push it can get, while 12 bags of atta is barely 6 bills and needs none.
 */
function stockPressure(product, rate, stock) {
  const { max } = qtyRangeFor(product, rate)
  const cover = stock / Math.max(1, max)
  if (cover <= PRESSURE_EASY_BILLS) return 0
  const span = PRESSURE_DEEP_BILLS - PRESSURE_EASY_BILLS
  return Math.max(0, Math.min(1, (cover - PRESSURE_EASY_BILLS) / span))
}

// A real counter bill never shows the same quantity on every line. How many
// units a customer takes depends on what the item is, so the range comes from
// the product's purchase archetype rather than its price alone.
function rangeFor(entry, { qtyScale = 1, maxQtyPerLine = 10 } = {}) {
  const stockCap = Math.max(1, Math.floor(entry.stock))
  const { min, max } = qtyRangeFor(entry.product, entry.rate, {
    stretch: qtyScale,
    pressure: entry.pressure || 0,
  })
  const hardCap = Math.max(1, Math.min(99, Math.round(maxQtyPerLine * Math.max(1, qtyScale))))
  const capped = Math.max(1, Math.min(max, stockCap, hardCap))
  return { min: Math.max(1, Math.min(min, capped)), max: capped }
}

// Upper bound for one line, honouring stock, archetype and the caller's cap.
function capFor(entry, opts) {
  return rangeFor(entry, opts).max
}

// Pack size / price tokens that distinguish variants of the same product
// ("100G", "RS10", "1KG", "200ML") but say nothing about what the product is.
const PACK_TOKEN = /^(RS\d+(\.\d+)?|\d+(\.\d+)?RS|\d+(\.\d+)?(G|GM|GMS|KG|ML|L|LTR|MG|PC|PCS|N|NO|NOS|P|X)?|X\d+)$/

function nameTokens(product) {
  const raw = `${product?.brand || ''} ${product?.name || ''}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

  const tokens = []
  for (const token of raw) {
    if (PACK_TOKEN.test(token)) continue
    // A brand repeated from the brand column adds nothing to the key.
    if (tokens[tokens.length - 1] === token) continue
    tokens.push(token)
  }
  return tokens
}

/**
 * Group pool entries into product families so a bill never shows two packs of
 * the same thing. Shorter names win: "3ROSES" absorbs "3ROSES NATURAL CARE",
 * so the 100g pack and the RS10 sachet share one family.
 */
function assignFamilies(pool) {
  const keyed = pool.map((entry) => ({ entry, tokens: nameTokens(entry.product) }))
  // Shortest names first so they become the family roots.
  const roots = [...keyed]
    .filter((k) => k.tokens.length)
    .sort((a, b) => a.tokens.length - b.tokens.length)

  const assigned = new Map()
  for (const { entry, tokens } of keyed) {
    if (!tokens.length) { assigned.set(entry, entry.product.id); continue }
    let family = tokens.join(' ')
    for (const root of roots) {
      if (root.tokens.length >= tokens.length) break
      if (root.tokens.every((t, i) => tokens[i] === t)) {
        family = assigned.get(root.entry) || root.tokens.join(' ')
        break
      }
    }
    assigned.set(entry, family)
  }

  for (const entry of pool) entry.family = assigned.get(entry) || entry.product.id
  return pool
}

// Bills read naturally when one or two priced items anchor the total and the
// rest are small add-ons, instead of a flat list of look-alike cheap packs.
function orderPool(pool, target) {
  const anchorFloor = target * 0.06
  const anchors = shuffle(pool.filter((e) => e.rate >= anchorFloor))
  const fillers = pool.filter((e) => e.rate < anchorFloor)
  // Only a couple of priced items lead; everything else competes at random so
  // the bill mixes big-ticket lines with small staples.
  const lead = anchors.slice(0, 1 + Math.floor(Math.random() * 3))
  // Overstocked items get a head start among the rest, so they appear on more
  // bills instead of waiting behind the line limit — still randomised, so the
  // basket does not become predictable.
  const rest = [...anchors.slice(lead.length), ...fillers]
    .map((entry) => ({ entry, key: Math.random() - (entry.pressure || 0) * 0.45 }))
    .sort((a, b) => a.key - b.key)
    .map((item) => item.entry)
  return [...lead, ...rest]
}

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

function attemptPlan(pool, target, { maxLines, maxQtyPerLine, qtyScale }) {
  const lines = []
  const used = new Map()
  const usedFamilies = new Set()
  let total = 0

  const order = orderPool(pool, target)

  for (const entry of order) {
    if (lines.length >= maxLines) break
    const remaining = target - total
    if (remaining <= 0) break
    if (entry.rate > remaining * 1.35) continue
    // One pack per product family — no 100g tin next to the RS10 sachet.
    if (usedFamilies.has(entry.family)) continue

    const { min, max } = rangeFor(entry, { maxQtyPerLine, qtyScale })
    const fitQty = Math.max(1, Math.round(remaining / entry.rate))
    // Never below the archetype minimum — a lone ₹5 toffee is not a real line.
    const qty = Math.min(Math.max(fitQty, min), max)
    const lineTotal = round2(entry.rate * qty)

    // Never overshoot by more than half a unit's worth once something is picked.
    if (total + lineTotal > target + entry.rate * 0.5 && lines.length) continue

    const line = { product: entry.product, rate: entry.rate, quantity: qty, total: lineTotal }
    lines.push(line)
    used.set(entry.product.id, line)
    usedFamilies.add(entry.family)
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
      if (qty >= capFor(entry, { maxQtyPerLine, qtyScale })) continue
      if (!line && (lines.length >= maxLines || usedFamilies.has(entry.family))) continue

      const next = round2(total + entry.rate)
      if (Math.abs(target - next) >= Math.abs(target - total)) continue

      if (line) {
        line.quantity += 1
        line.total = round2(line.rate * line.quantity)
      } else {
        // New lines open at the archetype minimum, never a token single unit.
        const { min } = rangeFor(entry, { maxQtyPerLine, qtyScale })
        const openQty = min
        const openTotal = round2(entry.rate * openQty)
        if (Math.abs(target - round2(total + openTotal)) >= Math.abs(target - total)) continue
        const added = { product: entry.product, rate: entry.rate, quantity: openQty, total: openTotal }
        lines.push(added)
        used.set(entry.product.id, added)
        usedFamilies.add(entry.family)
        total = round2(total + openTotal)
        improved = true
        continue
      }
      total = next
      improved = true
    }
  }

  return { lines, total }
}

// Nudge quantities by a unit or two to break a round-looking total or to pull
// the plan inside the allowed band, keeping the best-scoring variation.
function polishPlan(plan, goal, { maxQtyPerLine, qtyScale }) {
  let { lines, total } = plan
  let best = scorePlan(total, goal)
  let improved = true

  while (improved) {
    improved = false
    for (const line of lines) {
      const { min, max } = rangeFor(
        { product: line.product, rate: line.rate, stock: Number(line.product.stock_qty) || 0 },
        { maxQtyPerLine, qtyScale },
      )
      for (const delta of [1, -1, 2, -2]) {
        const qty = line.quantity + delta
        if (qty < min || qty > max) continue

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
function maxReachable(pool, { maxLines, maxQtyPerLine, qtyScale }) {
  // One line per family, so only each family's richest entry can contribute.
  const bestPerFamily = new Map()
  for (const e of pool) {
    const cap = capFor(e, { maxQtyPerLine, qtyScale })
    const value = e.rate * cap
    const current = bestPerFamily.get(e.family)
    if (!current || value > current) bestPerFamily.set(e.family, value)
  }
  return round2(
    [...bestPerFamily.values()]
      .sort((a, b) => b - a)
      .slice(0, maxLines)
      .reduce((sum, value) => sum + value, 0)
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
  if (goal <= 0) return { lines: [], total: 0, maxPossible: 0, poolCeiling: 0 }

  const pool = (products || [])
    .map((product) => {
      const rate = round2(rateFor ? rateFor(product) : (product.selling_price || product.mrp || 0))
      const stock = Number(product.stock_qty) || 0
      return { product, rate, stock, pressure: stockPressure(product, rate, stock) }
    })
    .filter((entry) => entry.rate > 0 && entry.stock > 0)

  if (!pool.length) return { lines: [], total: 0, maxPossible: 0, poolCeiling: 0 }

  assignFamilies(pool)

  // A small catalog can't reach a large target at natural quantities, so the
  // per-line caps are stretched only as far as the target actually needs.
  const reachGoal = goal * (1 + MAX_VARIANCE_PCT / 100)
  let qtyScale = 1
  const maxScale = 16
  while (qtyScale < maxScale && maxReachable(pool, { maxLines, maxQtyPerLine, qtyScale }) < reachGoal) {
    qtyScale = Math.min(maxScale, qtyScale * 1.5)
  }

  const maxPossible = maxReachable(pool, { maxLines, maxQtyPerLine, qtyScale })
  // Ceiling with the line limit removed, so the UI can tell "allow more lines"
  // apart from "the shop does not hold this much stock".
  const poolCeiling = maxReachable(pool, { maxLines: pool.length, maxQtyPerLine, qtyScale })

  let best = null
  for (let i = 0; i < attempts; i++) {
    // Aim each attempt at a random point inside the preferred variance window
    // (either side of the goal) so repeated runs produce varied, natural totals
    // instead of converging on the exact amount every time.
    const spread = MIN_VARIANCE_PCT + Math.random() * (MAX_VARIANCE_PCT - MIN_VARIANCE_PCT)
    const sign = Math.random() < 0.5 ? -1 : 1
    const aim = Math.min(goal * (1 + (sign * spread) / 100), maxPossible)

    const plan = polishPlan(
      attemptPlan(pool, aim, { maxLines, maxQtyPerLine, qtyScale }),
      goal,
      { maxQtyPerLine, qtyScale },
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

  if (!best) return { lines: [], total: 0, maxPossible, poolCeiling }
  return { lines: best.lines, total: best.total, maxPossible, poolCeiling }
}

/**
 * Build the best plan the shop can actually produce, relaxing the
 * recently-billed rule only as far as the target requires.
 *
 * A small catalog can exhaust the strict pool: after two bills, nearly
 * everything in stock is excluded and only a few low value oddments remain.
 * Rather than dead-ending, the rule is loosened one step at a time — last 2
 * invoices, then the latest invoice only, then no exclusion — and the first
 * tier that lands inside the variance band wins. The chosen tier is reported
 * so the UI can tell the counter which rule the bill was built under.
 */
export function buildAutoFillPlanWithFallback(candidates, target, options = {}) {
  const pool = candidates?.pool || []
  const recentByDepth = candidates?.recentByDepth || {}
  const goal = Number(target) || 0

  if (!pool.length || goal <= 0) {
    return { lines: [], total: 0, maxPossible: 0, poolCeiling: 0, tier: null, relaxed: false, exhausted: !pool.length }
  }

  let fallback = null
  for (const tier of SUGGESTION_TIERS) {
    const excluded = new Set(tier.depth ? recentByDepth[tier.depth] || [] : [])
    const tierPool = excluded.size ? pool.filter((p) => !excluded.has(p.id)) : pool
    if (!tierPool.length) continue

    const plan = buildAutoFillPlan(tierPool, goal, options)
    if (!plan.lines.length) continue

    const result = {
      ...plan,
      tier,
      relaxed: tier.depth !== SUGGESTION_TIERS[0].depth,
      exhausted: false,
    }

    const devPct = Math.abs((plan.total - goal) / goal) * 100
    if (devPct <= MAX_VARIANCE_PCT) return result
    // Keep the closest near-miss, but only switch to a more relaxed tier when
    // it genuinely closes the gap. If the shortfall is caused by thin stock
    // rather than the freshness rule, every tier lands in the same place and
    // the strict rule is kept.
    const fallbackDev = fallback ? Math.abs((fallback.total - goal) / goal) * 100 : Infinity
    if (devPct < fallbackDev - RELAX_GAIN_PCT) fallback = result
  }

  return fallback || { lines: [], total: 0, maxPossible: 0, poolCeiling: 0, tier: null, relaxed: false, exhausted: true }
}

/**
 * How much billing the current stock can actually absorb.
 *
 * Auto-fill is constrained by bill *value*, but stock clears by *units*, and
 * the two run out at different speeds. A shop holding 800 one-rupee toffees
 * beside ₹9,000 of other goods can only write a dozen ₹786 bills before the
 * supporting items are gone — yet the toffee needs a hundred bills to clear,
 * because nobody buys eighty at once.
 *
 * Returns the number of bills the stock supports at `target`, and the deep
 * stock that cannot clear within that many bills.
 */
export function estimateClearance(products, target, { rateFor, maxLines = 8 } = {}) {
  const goal = Number(target) || 0
  const entries = (products || [])
    .map((product) => {
      const rate = round2(rateFor ? rateFor(product) : (product.selling_price || product.mrp || 0))
      const stock = Number(product.stock_qty) || 0
      const pressure = stockPressure(product, rate, stock)
      const { max } = qtyRangeFor(product, rate, { pressure })
      return { product, rate, stock, perBill: Math.max(1, max), value: rate * stock }
    })
    .filter((e) => e.rate > 0 && e.stock > 0)

  if (!entries.length || goal <= 0) {
    return { billsSupported: 0, totalStockValue: 0, laggards: [] }
  }

  const totalStockValue = round2(entries.reduce((sum, e) => sum + e.value, 0))
  // Value runs out first: each bill consumes roughly `goal` worth of stock.
  const billsByValue = Math.floor(totalStockValue / goal)
  // Lines run out too — a bill needs `maxLines` distinct families to fill.
  const billsSupported = Math.max(0, billsByValue)

  const laggards = entries
    .map((e) => ({
      name: e.product.name,
      stock: e.stock,
      perBill: e.perBill,
      billsToClear: Math.ceil(e.stock / e.perBill),
    }))
    .filter((e) => e.billsToClear > Math.max(1, billsSupported))
    .sort((a, b) => b.billsToClear - a.billsToClear)

  return { billsSupported, totalStockValue, laggards }
}
