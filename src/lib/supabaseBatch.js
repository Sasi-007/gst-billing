// Supabase/PostgREST caps a response at 1000 rows by default and rejects very
// long request URLs (a `.in()` filter with a few hundred UUIDs already exceeds
// the 8 KB header buffer). Month-sized exports hit both limits, so reads that
// can span a whole period must page through results and chunk their id lists.

const PAGE_SIZE = 1000
const ID_BATCH_SIZE = 100

/** Pages through a query in 1000-row chunks, returning every matching row. */
export async function fetchAllRows(buildQuery) {
  const all = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  return all
}

/**
 * Runs `buildQuery` once per chunk of ids, filtering on `column`, and returns
 * the combined rows. Each chunk is itself paged, so neither the URL length nor
 * the row cap can silently truncate the result.
 */
export async function fetchAllRowsByIds(buildQuery, column, ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))]
  if (!uniqueIds.length) return []

  const all = []
  for (let i = 0; i < uniqueIds.length; i += ID_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + ID_BATCH_SIZE)
    const rows = await fetchAllRows(() => buildQuery().in(column, batch))
    all.push(...rows)
  }
  return all
}
