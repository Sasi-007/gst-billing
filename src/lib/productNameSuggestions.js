function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const STOP_WORDS = new Set(['and', 'with', 'the', 'new', 'best', 'super'])

function getSearchTerms(value) {
  const text = normalize(value)
  if (!text) return []

  const tokens = text
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))

  return [...new Set([text, ...tokens])]
}

function hasSuggestionMatch(item, searchTerms) {
  const haystack = [
    item.english_name,
    ...(Array.isArray(item.aliases) ? item.aliases : []),
  ]
    .map(normalize)
    .filter(Boolean)

  return haystack.some((value) =>
    searchTerms.some((term) => value.includes(term) || term.includes(value))
  )
}

export async function findProductNameSuggestions(supabase, input, shopId, includeGlobal = true) {
  const searchTerms = getSearchTerms(input)
  if (searchTerms.length === 0) return []

  let request = supabase
    .from('product_name_suggestions')
    .select('id,shop_id,english_name,local_name,aliases,language,category')
    .eq('is_active', true)
    .limit(500)

  if (shopId && includeGlobal) {
    request = request.or(`shop_id.is.null,shop_id.eq.${shopId}`)
  } else if (shopId) {
    request = request.eq('shop_id', shopId)
  } else {
    request = request.is('shop_id', null)
  }

  const { data, error } = await request

  if (error) throw error

  return (data || [])
    .filter((item) => hasSuggestionMatch(item, searchTerms))
    .slice(0, 5)
}

export async function saveProductNameSuggestion(supabase, {
  shopId,
  englishName,
  localName,
  aliases = [],
  language = 'ta',
}) {
  const cleanEnglishName = String(englishName || '').trim()
  const cleanLocalName = String(localName || '').trim()
  if (!shopId || !cleanEnglishName || !cleanLocalName) return null

  const normalizedAliases = [
    cleanEnglishName,
    ...getSearchTerms(cleanEnglishName),
    ...aliases,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)

  const uniqueAliases = [...new Set(normalizedAliases.map((value) => value.toLowerCase()))]

  const { data: existingRows, error: lookupErr } = await supabase
    .from('product_name_suggestions')
    .select('id,aliases')
    .eq('shop_id', shopId)
    .ilike('english_name', cleanEnglishName)
    .eq('is_active', true)
    .limit(1)
  if (lookupErr) throw lookupErr

  const existing = existingRows?.[0]
  if (existing) {
    const mergedAliases = [
      ...(Array.isArray(existing.aliases) ? existing.aliases : []),
      ...uniqueAliases,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    const dedupedAliases = [...new Set(mergedAliases.map((value) => value.toLowerCase()))]

    const { data, error } = await supabase
      .from('product_name_suggestions')
      .update({
        local_name: cleanLocalName,
        aliases: dedupedAliases,
        language,
        is_active: true,
      })
      .eq('id', existing.id)
      .select('id,shop_id,english_name,local_name,aliases,language,category')
      .single()
    if (error) throw error
    return data
  }

  const { data, error } = await supabase
    .from('product_name_suggestions')
    .insert({
      shop_id: shopId,
      english_name: cleanEnglishName,
      local_name: cleanLocalName,
      aliases: uniqueAliases,
      language,
      is_active: true,
    })
    .select('id,shop_id,english_name,local_name,aliases,language,category')
    .single()
  if (error) throw error
  return data
}
