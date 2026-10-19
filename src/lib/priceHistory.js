/**
 * Product rate (price) history.
 *
 * Inventory here is maintained mainly for rate upkeep rather than purchase
 * uploads, so the question "what did we charge for this last month?" has to be
 * answerable from the product itself.
 *
 * Rows are written by a database trigger on `products`, never by this module —
 * prices are updated from several screens and a trigger is the only way to
 * guarantee every change is recorded. Callers only *tag* a change by sending
 * `last_price_source` / `last_price_note` in the same update payload.
 */

import { supabase } from './supabase'
import { fetchAllRows, fetchAllRowsByIds } from './supabaseBatch'

export const PRICE_SOURCES = {
  initial: { label: 'Opening rate', icon: '🏁' },
  manual: { label: 'Manual update', icon: '✏️' },
  bulk: { label: 'Bulk rate update', icon: '📋' },
  'price-check': { label: 'Price check screen', icon: '💰' },
  import: { label: 'CSV upload', icon: '📥' },
  purchase: { label: 'Purchase entry', icon: '🛒' },
}

export function sourceLabel(source) {
  return PRICE_SOURCES[source]?.label || 'Rate update'
}

export function sourceIcon(source) {
  return PRICE_SOURCES[source]?.icon || '•'
}

const HISTORY_COLUMNS =
  'id,product_id,effective_date,purchase_price,selling_price,mrp,gst_rate,' +
  'prev_purchase_price,prev_selling_price,prev_mrp,source,note,created_at'

/** Full timeline for one product, newest first. */
export async function fetchProductPriceHistory(shopId, productId, limit = 50) {
  if (!shopId || !productId) return []

  const { data, error } = await supabase
    .from('product_price_history')
    .select(HISTORY_COLUMNS)
    .eq('shop_id', shopId)
    .eq('product_id', productId)
    .order('effective_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data || []
}

/**
 * Latest change per product, for the inventory list indicator.
 * Returns a Map keyed by product_id.
 *
 * Postgres has no cheap "latest per group" over REST, so this pulls recent
 * rows for the given products and reduces client-side. Ids are chunked by
 * fetchAllRowsByIds because `.in()` has a URL length limit.
 */
export async function fetchLatestPriceChanges(shopId, productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean))]
  if (!shopId || ids.length === 0) return new Map()

  const rows = await fetchAllRowsByIds(
    () => supabase
      .from('product_price_history')
      .select(HISTORY_COLUMNS)
      .eq('shop_id', shopId)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false }),
    'product_id',
    ids
  )

  const latest = new Map()
  for (const row of rows) {
    const current = latest.get(row.product_id)
    if (!current) {
      latest.set(row.product_id, row)
      continue
    }
    // Batching loses ordering across chunks, so compare explicitly.
    const newer = row.effective_date > current.effective_date
      || (row.effective_date === current.effective_date && row.created_at > current.created_at)
    if (newer) latest.set(row.product_id, row)
  }
  return latest
}

/** Every rate change in a date window, for month-end extracts. */
export async function fetchPriceHistoryForPeriod(shopId, dateFrom, dateTo) {
  if (!shopId) return []

  const rows = await fetchAllRows(() => supabase
    .from('product_price_history')
    .select(`${HISTORY_COLUMNS},products(name,local_name,unit,hsn_code)`)
    .eq('shop_id', shopId)
    .gte('effective_date', dateFrom)
    .lte('effective_date', dateTo)
    .order('effective_date', { ascending: true })
    .order('created_at', { ascending: true }))

  return rows
}
function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Direction and size of the selling-rate move, falling back to purchase rate
 * for cost-only products. Returns null when there is nothing to compare
 * against (the opening row).
 */
export function describeChange(row) {
  if (!row) return null

  const pairs = [
    ['selling_price', 'prev_selling_price'],
    ['purchase_price', 'prev_purchase_price'],
    ['mrp', 'prev_mrp'],
  ]

  for (const [field, prevField] of pairs) {
    if (row[prevField] === null || row[prevField] === undefined) continue
    const next = toNumber(row[field])
    const prev = toNumber(row[prevField])
    if (next === prev) continue

    const diff = next - prev
    return {
      field,
      prev,
      next,
      diff,
      direction: diff > 0 ? 'up' : 'down',
      percent: prev === 0 ? null : Math.abs((diff / prev) * 100),
    }
  }

  return null
}

/** True when every tracked rate on the row is unchanged from its predecessor. */
export function isOpeningRow(row) {
  return !!row && row.prev_selling_price === null
    && row.prev_purchase_price === null && row.prev_mrp === null
}
