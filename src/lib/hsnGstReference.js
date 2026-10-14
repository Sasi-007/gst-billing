import { supabase } from '@/lib/supabase'

/**
 * Looks up a suggested GST rate for an HSN code from the curated
 * `hsn_gst_reference` table. This is a SUGGESTION ONLY — it is not a
 * certified source of truth. Always let the user confirm/override.
 *
 * Falls back to a longest-prefix match if the exact HSN code isn't found
 * (e.g. user enters a 6-digit code but table has 8-digit entries, or vice versa).
 */
export async function suggestGstRateForHsn(hsnCode) {
  const code = String(hsnCode || '').trim()
  if (!code || code.length < 4) return null

  const { data: exact } = await supabase
    .from('hsn_gst_reference')
    .select('hsn_code,description,gst_rate')
    .eq('hsn_code', code)
    .maybeSingle()
  if (exact) return exact

  // Try progressively shorter prefixes (8 -> 6 -> 4 digits) for a best-effort match
  for (const len of [8, 6, 4]) {
    if (code.length < len) continue
    const prefix = code.slice(0, len)
    const { data: rows } = await supabase
      .from('hsn_gst_reference')
      .select('hsn_code,description,gst_rate')
      .like('hsn_code', `${prefix}%`)
      .limit(1)
    if (rows?.length) return rows[0]
  }

  return null
}
