export function getBillProductName(product) {
  const englishName = String(product?.name || '').trim()
  const localName = String(product?.local_name || '').trim()
  const mode = product?.bill_name_mode || 'english'

  if (mode === 'local' && localName) return localName
  if (mode === 'both' && englishName && localName) return `${englishName} / ${localName}`
  if (mode === 'both' && localName) return localName

  return englishName
}

export function getProductSubtitle(product) {
  const localName = String(product?.local_name || '').trim()
  const aliases = Array.isArray(product?.search_aliases)
    ? product.search_aliases.filter(Boolean).join(', ')
    : ''

  return [localName, aliases].filter(Boolean).join(' · ')
}
