import { supabase } from '@/lib/supabase'

const BRAND_SELECT = 'id,brand,stock_qty,purchase_price,selling_price,is_active'

export function cleanBrandName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Collapses spelling noise so "Aashirvaad", "AASHIRVAD" and "aashirvaad "
 * all reduce to the same comparison key.
 */
export function normalizeBrandKey(value) {
  const base = cleanBrandName(value)
    .toUpperCase()
    .replace(/[^A-Z0-9\u0B80-\u0BFF]/g, '')
  return base.replace(/([A-Z0-9])\1+/g, '$1')
}

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1]
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

export function brandSimilarity(a, b) {
  const keyA = normalizeBrandKey(a)
  const keyB = normalizeBrandKey(b)
  if (!keyA || !keyB) return 0
  if (keyA === keyB) return 1
  const distance = levenshtein(keyA, keyB)
  return 1 - distance / Math.max(keyA.length, keyB.length)
}

/** Typos stay close; genuinely different brands do not. */
export function looksLikeSameBrand(a, b) {
  const keyA = normalizeBrandKey(a)
  const keyB = normalizeBrandKey(b)
  if (!keyA || !keyB) return false
  if (keyA === keyB) return true
  if (Math.abs(keyA.length - keyB.length) > 3) return false

  const distance = levenshtein(keyA, keyB)
  const shortest = Math.min(keyA.length, keyB.length)
  if (shortest <= 4) return distance <= 1
  if (shortest <= 8) return distance <= 2
  return distance <= 3
}

/** Suggests existing brands that a freshly typed brand may be a misspelling of. */
export function suggestBrandMatches(value, brandNames, limit = 3) {
  const typed = cleanBrandName(value)
  if (typed.length < 3) return []
  const typedKey = normalizeBrandKey(typed)

  const names = (brandNames || []).map((name) => cleanBrandName(name)).filter(Boolean)
  // An exact existing brand needs no correction — only flag real look-alikes.
  const alreadyExists = names.some((name) => normalizeBrandKey(name) === typedKey)

  return names
    .filter((name) => normalizeBrandKey(name) !== typedKey)
    .filter((name) => looksLikeSameBrand(name, typed)
      || (!alreadyExists && normalizeBrandKey(name).startsWith(typedKey)))
    .sort((a, b) => brandSimilarity(b, typed) - brandSimilarity(a, typed))
    .slice(0, limit)
}

/** Reads every product once and rolls it up into a brand list with usage stats. */
export async function loadBrandSummary(shopId) {
  if (!shopId) return { brands: [], unbrandedCount: 0 }

  const pageSize = 1000
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('products')
      .select(BRAND_SELECT)
      .eq('shop_id', shopId)
      .order('id')
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }

  const byName = new Map()
  let unbrandedCount = 0

  for (const row of rows) {
    const name = cleanBrandName(row.brand)
    if (!name) {
      unbrandedCount += 1
      continue
    }
    const entry = byName.get(name) || {
      name,
      key: normalizeBrandKey(name),
      productCount: 0,
      activeCount: 0,
      stockQty: 0,
      stockValue: 0,
    }
    const qty = Number(row.stock_qty) || 0
    entry.productCount += 1
    if (row.is_active !== false) entry.activeCount += 1
    entry.stockQty += qty
    entry.stockValue += qty * (Number(row.purchase_price) || 0)
    byName.set(name, entry)
  }

  const brands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { brands, unbrandedCount }
}

/**
 * Groups brand variants that are probably the same brand.
 * The variant used by the most products becomes the suggested canonical name.
 */
export function findDuplicateBrandGroups(brands) {
  const remaining = [...(brands || [])].sort((a, b) => b.productCount - a.productCount)
  const groups = []

  while (remaining.length) {
    const seed = remaining.shift()
    const members = [seed]
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (members.some((member) => looksLikeSameBrand(member.name, remaining[i].name))) {
        members.unshift(remaining.splice(i, 1)[0])
      }
    }
    if (members.length > 1) {
      members.sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name))
      groups.push({
        id: members.map((member) => member.name).join('|'),
        suggested: members[0].name,
        members,
        productCount: members.reduce((sum, member) => sum + member.productCount, 0),
      })
    }
  }

  return groups.sort((a, b) => b.productCount - a.productCount)
}

/** Points every product on `fromNames` at `toName` (rename when a single source). */
export async function mergeBrands(shopId, fromNames, toName) {
  const target = cleanBrandName(toName)
  if (!shopId || !target) throw new Error('Pick a brand name to merge into')

  const sources = [...new Set((fromNames || []).map(cleanBrandName).filter(Boolean))]
    .filter((name) => name !== target)
  if (!sources.length) return 0

  const { data, error } = await supabase
    .from('products')
    .update({ brand: target })
    .eq('shop_id', shopId)
    .in('brand', sources)
    .select('id')

  if (error) throw error
  return (data || []).length
}

/** Clears the brand on every product using it. */
export async function clearBrand(shopId, name) {
  const brand = cleanBrandName(name)
  if (!shopId || !brand) return 0

  const { data, error } = await supabase
    .from('products')
    .update({ brand: null })
    .eq('shop_id', shopId)
    .eq('brand', brand)
    .select('id')

  if (error) throw error
  return (data || []).length
}
