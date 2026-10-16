export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }

  row.push(field)
  if (row.some((value) => String(value || '').trim())) rows.push(row)
  return rows
}

export function csvRowsToObjects(text) {
  const rows = parseCsv(text)
  const headers = (rows[0] || []).map((header) => String(header || '').trim().toLowerCase())
  return rows.slice(1).map((row) => Object.fromEntries(
    headers.map((header, index) => [header, String(row[index] || '').trim()])
  ))
}

export function csvHeaders(text) {
  const rows = parseCsv(text)
  return (rows[0] || []).map((header) => String(header || '').trim().toLowerCase())
}

// Accepts the en-IN format produced by the export (dd/mm/yyyy) as well as ISO dates.
export function parseCsvDate(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return text
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (dmy) {
    const [, day, month, year] = dmy
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return ''
}
