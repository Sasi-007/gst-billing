// Dynamic, multi-level filter engine for the inventory screen.
//
// A filter is a tree of groups (AND/OR) and rules. The same tree can be
// produced by the visual builder or by the text ("SQL-like") console, and is
// serialised into a PostgREST boolean expression so paging/counting stay
// server-side.

export const FILTER_FIELDS = [
  { key: 'name', label: 'Product Name', type: 'text', aliases: ['product', 'product_name', 'item'] },
  { key: 'local_name', label: 'Local / Tamil Name', type: 'text', aliases: ['local', 'tamil', 'tamil_name'] },
  { key: 'brand', label: 'Brand', type: 'text', aliases: [] },
  { key: 'barcode', label: 'Barcode', type: 'text', aliases: ['ean'] },
  { key: 'hsn_code', label: 'HSN Code', type: 'text', aliases: ['hsn'] },
  { key: 'unit', label: 'Unit', type: 'text', aliases: ['uom'] },
  { key: 'category_id', label: 'Category', type: 'select', source: 'categories', aliases: ['category', 'cat'] },
  { key: 'supplier_id', label: 'Supplier', type: 'select', source: 'suppliers', aliases: ['supplier', 'vendor', 'party'] },
  { key: 'stock_qty', label: 'Stock Qty', type: 'number', aliases: ['stock', 'qty', 'quantity'] },
  { key: 'min_stock', label: 'Min Stock', type: 'number', aliases: ['reorder', 'min_stock_qty'] },
  { key: 'purchase_price', label: 'Purchase Price', type: 'number', aliases: ['purchase', 'cost', 'cost_price', 'purchase_rate'] },
  { key: 'mrp', label: 'MRP', type: 'number', aliases: [] },
  { key: 'selling_price', label: 'Selling Price', type: 'number', aliases: ['selling', 'sale_price', 'price'] },
  { key: 'gst_rate', label: 'GST %', type: 'number', aliases: ['gst', 'gst_percent', 'tax'] },
  { key: 'is_active', label: 'Active', type: 'boolean', aliases: ['active', 'enabled'] },
]

export const OPERATORS = {
  eq: { label: 'is', symbol: '=', types: ['text', 'number', 'select', 'boolean'], args: 1 },
  neq: { label: 'is not', symbol: '!=', types: ['text', 'number', 'select', 'boolean'], args: 1 },
  contains: { label: 'contains', symbol: 'contains', types: ['text'], args: 1 },
  not_contains: { label: 'does not contain', symbol: 'not contains', types: ['text'], args: 1 },
  starts_with: { label: 'starts with', symbol: 'starts with', types: ['text'], args: 1 },
  ends_with: { label: 'ends with', symbol: 'ends with', types: ['text'], args: 1 },
  gt: { label: 'greater than', symbol: '>', types: ['number'], args: 1 },
  gte: { label: 'greater or equal', symbol: '>=', types: ['number'], args: 1 },
  lt: { label: 'less than', symbol: '<', types: ['number'], args: 1 },
  lte: { label: 'less or equal', symbol: '<=', types: ['number'], args: 1 },
  between: { label: 'between', symbol: 'between', types: ['number'], args: 2 },
  in: { label: 'is any of', symbol: 'in', types: ['text', 'number', 'select'], args: 'list' },
  not_in: { label: 'is none of', symbol: 'not in', types: ['text', 'number', 'select'], args: 'list' },
  is_empty: { label: 'is empty', symbol: 'is empty', types: ['text', 'number', 'select'], args: 0 },
  is_not_empty: { label: 'is not empty', symbol: 'is not empty', types: ['text', 'number', 'select'], args: 0 },
}

const FIELD_BY_KEY = new Map(FILTER_FIELDS.map((field) => [field.key, field]))

const FIELD_BY_ALIAS = (() => {
  const map = new Map()
  for (const field of FILTER_FIELDS) {
    map.set(field.key, field)
    for (const alias of field.aliases || []) map.set(alias, field)
  }
  return map
})()

export function getField(key) {
  return FIELD_BY_KEY.get(key) || null
}

export function operatorsForType(type) {
  return Object.entries(OPERATORS)
    .filter(([, op]) => op.types.includes(type))
    .map(([key, op]) => ({ key, ...op }))
}

export function defaultOperatorForType(type) {
  if (type === 'number') return 'eq'
  if (type === 'select' || type === 'boolean') return 'eq'
  return 'contains'
}

let nodeSeq = 0
function nextId() {
  nodeSeq += 1
  return `n${nodeSeq}${Math.random().toString(36).slice(2, 7)}`
}

export function makeRule(fieldKey = 'stock_qty') {
  const field = getField(fieldKey) || FILTER_FIELDS[0]
  return {
    id: nextId(),
    kind: 'rule',
    field: field.key,
    op: defaultOperatorForType(field.type),
    value: '',
    value2: '',
  }
}

export function makeGroup(op = 'and', children) {
  return {
    id: nextId(),
    kind: 'group',
    op,
    children: children || [makeRule()],
  }
}

export function emptyFilterTree() {
  return makeGroup('and', [])
}

export function countRules(node) {
  if (!node) return 0
  if (node.kind === 'rule') return 1
  return (node.children || []).reduce((sum, child) => sum + countRules(child), 0)
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

export function isRuleComplete(rule) {
  const op = OPERATORS[rule.op]
  if (!op) return false
  if (op.args === 0) return true
  if (op.args === 2) return !isBlank(rule.value) && !isBlank(rule.value2)
  if (op.args === 'list') return splitList(rule.value).length > 0
  return !isBlank(rule.value)
}

export function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

// ── PostgREST serialisation ───────────────────────────────────

// Reserved characters inside an unquoted or=() value.
function sanitizeLoose(value) {
  return String(value ?? '').replace(/[(),"\\]/g, ' ').trim()
}

function quoted(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function numeric(value) {
  const parsed = Number(String(value).trim())
  return Number.isFinite(parsed) ? String(parsed) : null
}

function boolish(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['false', 'no', '0', 'inactive', 'disabled'].includes(text)) return 'false'
  return 'true'
}

function ruleToPostgrest(rule) {
  const field = getField(rule.field)
  if (!field || !isRuleComplete(rule)) return null
  const key = field.key
  const type = field.type

  switch (rule.op) {
    case 'is_empty':
      return type === 'text' ? `or(${key}.is.null,${key}.eq.${quoted('')})` : `${key}.is.null`
    case 'is_not_empty':
      return type === 'text' ? `and(${key}.not.is.null,${key}.neq.${quoted('')})` : `${key}.not.is.null`
    case 'contains':
      return `${key}.ilike.*${sanitizeLoose(rule.value)}*`
    case 'not_contains':
      return `${key}.not.ilike.*${sanitizeLoose(rule.value)}*`
    case 'starts_with':
      return `${key}.ilike.${sanitizeLoose(rule.value)}*`
    case 'ends_with':
      return `${key}.ilike.*${sanitizeLoose(rule.value)}`
    case 'between': {
      const lo = numeric(rule.value)
      const hi = numeric(rule.value2)
      if (lo === null || hi === null) return null
      return `and(${key}.gte.${lo},${key}.lte.${hi})`
    }
    case 'in':
    case 'not_in': {
      const list = splitList(rule.value)
      if (!list.length) return null
      const encoded = list.map((item) => (type === 'number' ? numeric(item) ?? quoted(item) : quoted(item))).join(',')
      return rule.op === 'in' ? `${key}.in.(${encoded})` : `${key}.not.in.(${encoded})`
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const num = numeric(rule.value)
      if (num === null) return null
      return `${key}.${rule.op}.${num}`
    }
    case 'eq':
    case 'neq': {
      if (type === 'number') {
        const num = numeric(rule.value)
        if (num === null) return null
        return `${key}.${rule.op}.${num}`
      }
      if (type === 'boolean') return `${key}.${rule.op}.${boolish(rule.value)}`
      if (type === 'select') return `${key}.${rule.op}.${quoted(rule.value)}`
      // Text equality is matched case-insensitively for a friendlier UX.
      return rule.op === 'eq'
        ? `${key}.ilike.${sanitizeLoose(rule.value)}`
        : `${key}.not.ilike.${sanitizeLoose(rule.value)}`
    }
    default:
      return null
  }
}

function nodeToPostgrest(node) {
  if (!node) return null
  if (node.kind === 'rule') return ruleToPostgrest(node)
  const parts = (node.children || []).map(nodeToPostgrest).filter(Boolean)
  if (!parts.length) return null
  if (parts.length === 1) return parts[0]
  return `${node.op === 'or' ? 'or' : 'and'}(${parts.join(',')})`
}

/**
 * Serialises a filter tree into the string accepted by `query.or(...)`.
 * Returns '' when the tree has no usable rule.
 */
export function filterTreeToPostgrest(tree) {
  return nodeToPostgrest(tree) || ''
}

// ── Human readable serialisation (builder → text console) ─────

function ruleToText(rule, optionLabels) {
  const field = getField(rule.field)
  if (!field) return ''
  const op = OPERATORS[rule.op]
  if (!op) return ''
  const name = field.key

  if (op.args === 0) return `${name} ${op.symbol}`
  if (op.args === 2) return `${name} between ${rule.value} and ${rule.value2}`
  if (op.args === 'list') {
    const list = splitList(rule.value).map((item) => `'${labelFor(field, item, optionLabels)}'`)
    return `${name} ${op.symbol} (${list.join(', ')})`
  }
  const raw = labelFor(field, rule.value, optionLabels)
  const value = field.type === 'number' || field.type === 'boolean' ? String(raw) : `'${raw}'`
  return `${name} ${op.symbol} ${value}`
}

function labelFor(field, value, optionLabels) {
  if (field.type !== 'select' || !optionLabels) return value
  return optionLabels[field.source]?.get?.(String(value)) ?? value
}

export function filterTreeToText(node, optionLabels, depth = 0) {
  if (!node) return ''
  if (node.kind === 'rule') return ruleToText(node, optionLabels)
  const parts = (node.children || [])
    .map((child) => filterTreeToText(child, optionLabels, depth + 1))
    .filter(Boolean)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]
  const joined = parts.join(`\n${'  '.repeat(depth)}${node.op === 'or' ? 'OR' : 'AND'} `)
  return depth === 0 ? joined : `(${parts.join(` ${node.op === 'or' ? 'OR' : 'AND'} `)})`
}

// ── Text console parsing ──────────────────────────────────────

const TEXT_OPERATORS = [
  { match: ['is', 'not', 'empty'], op: 'is_not_empty' },
  { match: ['is', 'empty'], op: 'is_empty' },
  { match: ['is', 'null'], op: 'is_empty' },
  { match: ['not', 'contains'], op: 'not_contains' },
  { match: ['does', 'not', 'contain'], op: 'not_contains' },
  { match: ['not', 'like'], op: 'not_contains' },
  { match: ['not', 'in'], op: 'not_in' },
  { match: ['starts', 'with'], op: 'starts_with' },
  { match: ['ends', 'with'], op: 'ends_with' },
  { match: ['contains'], op: 'contains' },
  { match: ['like'], op: 'contains' },
  { match: ['between'], op: 'between' },
  { match: ['in'], op: 'in' },
]

const SYMBOL_OPERATORS = {
  '>=': 'gte',
  '<=': 'lte',
  '<>': 'neq',
  '!=': 'neq',
  '==': 'eq',
  '=': 'eq',
  '>': 'gt',
  '<': 'lt',
  '~': 'contains',
}

function tokenize(input) {
  const tokens = []
  let i = 0
  while (i < input.length) {
    const char = input[i]
    if (/\s/.test(char)) { i += 1; continue }
    if (char === '(' || char === ')' || char === ',') {
      tokens.push({ type: char === ',' ? 'comma' : char, value: char })
      i += 1
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      let value = ''
      i += 1
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) { value += input[i + 1]; i += 2; continue }
        value += input[i]
        i += 1
      }
      if (i >= input.length) throw new Error('Unclosed quote in filter expression')
      i += 1
      tokens.push({ type: 'string', value })
      continue
    }
    const twoChar = input.slice(i, i + 2)
    if (SYMBOL_OPERATORS[twoChar]) {
      tokens.push({ type: 'symbol', value: twoChar })
      i += 2
      continue
    }
    if (SYMBOL_OPERATORS[char]) {
      tokens.push({ type: 'symbol', value: char })
      i += 1
      continue
    }
    const wordMatch = /^[A-Za-z0-9_.%\-+₹]+/.exec(input.slice(i))
    if (wordMatch) {
      tokens.push({ type: 'word', value: wordMatch[0] })
      i += wordMatch[0].length
      continue
    }
    throw new Error(`Unexpected character "${char}" in filter expression`)
  }
  return tokens
}

/**
 * Turns a multi-line filter script into one expression. Lines are ANDed unless
 * the line itself starts with AND/OR. `#` and `--` start a comment.
 */
export function normalizeFilterScript(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)(#|--).*$/, '').trim())
    .filter(Boolean)

  return lines.reduce((acc, line, index) => {
    if (index === 0) return line
    return /^(and|or)\b/i.test(line) ? `${acc} ${line}` : `${acc} AND ${line}`
  }, '')
}

function resolveField(name) {
  const key = String(name || '').trim().toLowerCase().replace(/\s+/g, '_')
  return FIELD_BY_ALIAS.get(key) || null
}

function resolveSelectValue(field, rawValue, optionIndex) {
  const index = optionIndex?.[field.source]
  if (!index) return rawValue
  const direct = index.byId?.get?.(String(rawValue))
  if (direct) return String(rawValue)
  const byName = index.byName?.get?.(String(rawValue).trim().toLowerCase())
  if (byName) return byName
  throw new Error(`Unknown ${field.label.toLowerCase()} "${rawValue}"`)
}

function createParser(tokens, optionIndex) {
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isWord = (token, word) => token?.type === 'word' && token.value.toLowerCase() === word

  function parseExpression() {
    let node = parseTerm()
    while (isWord(peek(), 'or')) {
      next()
      const right = parseTerm()
      node = node.kind === 'group' && node.op === 'or'
        ? { ...node, children: [...node.children, right] }
        : makeGroup('or', [node, right])
    }
    return node
  }

  function parseTerm() {
    let node = parseFactor()
    while (isWord(peek(), 'and')) {
      next()
      const right = parseFactor()
      node = node.kind === 'group' && node.op === 'and'
        ? { ...node, children: [...node.children, right] }
        : makeGroup('and', [node, right])
    }
    return node
  }

  function parseFactor() {
    const token = peek()
    if (!token) throw new Error('Filter expression ended unexpectedly')
    if (token.type === '(') {
      next()
      const node = parseExpression()
      if (peek()?.type !== ')') throw new Error('Missing closing parenthesis )')
      next()
      return node
    }
    return parseCondition()
  }

  function parseOperator() {
    const token = peek()
    if (!token) throw new Error('Expected an operator')
    if (token.type === 'symbol') {
      next()
      return SYMBOL_OPERATORS[token.value]
    }
    if (token.type === 'word') {
      for (const candidate of TEXT_OPERATORS) {
        const matches = candidate.match.every(
          (word, offset) => tokens[pos + offset]?.type === 'word'
            && tokens[pos + offset].value.toLowerCase() === word,
        )
        if (matches) {
          pos += candidate.match.length
          return candidate.op
        }
      }
    }
    throw new Error(`Expected an operator after the field name, got "${token.value}"`)
  }

  function parseValueToken() {
    const token = next()
    if (!token || (token.type !== 'word' && token.type !== 'string')) {
      throw new Error('Expected a value in the filter expression')
    }
    return token.value
  }

  function parseList() {
    if (peek()?.type !== '(') throw new Error('Expected a list like in ("A", "B")')
    next()
    const values = []
    while (peek() && peek().type !== ')') {
      if (peek().type === 'comma') { next(); continue }
      values.push(parseValueToken())
    }
    if (peek()?.type !== ')') throw new Error('Missing closing parenthesis in list')
    next()
    return values
  }

  function parseCondition() {
    const fieldToken = next()
    if (!fieldToken || (fieldToken.type !== 'word' && fieldToken.type !== 'string')) {
      throw new Error('Expected a field name in the filter expression')
    }
    const field = resolveField(fieldToken.value)
    if (!field) throw new Error(`Unknown field "${fieldToken.value}"`)

    const op = parseOperator()
    const operator = OPERATORS[op]
    if (!operator.types.includes(field.type)) {
      throw new Error(`Operator "${operator.symbol}" cannot be used with ${field.label}`)
    }

    const rule = makeRule(field.key)
    rule.op = op

    if (operator.args === 0) return rule
    if (operator.args === 2) {
      rule.value = parseValueToken()
      if (!isWord(peek(), 'and')) throw new Error('between needs the form: field between 10 and 20')
      next()
      rule.value2 = parseValueToken()
      return rule
    }
    if (operator.args === 'list') {
      const values = parseList()
      rule.value = (field.type === 'select'
        ? values.map((value) => resolveSelectValue(field, value, optionIndex))
        : values).join(',')
      return rule
    }

    const raw = parseValueToken()
    rule.value = field.type === 'select' ? resolveSelectValue(field, raw, optionIndex) : raw
    return rule
  }

  return {
    parse() {
      const node = parseExpression()
      if (pos < tokens.length) {
        throw new Error(`Unexpected "${tokens[pos].value}" in filter expression`)
      }
      return node.kind === 'group' ? node : makeGroup('and', [node])
    },
  }
}

/**
 * Parses the text console into a filter tree.
 * `optionIndex` maps select sources to `{ byId: Map, byName: Map }` so that
 * `supplier = 'Annam Agencies'` can be resolved to a supplier id.
 */
export function parseFilterText(text, optionIndex) {
  const expression = normalizeFilterScript(text)
  if (!expression) return { tree: emptyFilterTree(), error: '' }
  try {
    const tokens = tokenize(expression)
    if (!tokens.length) return { tree: emptyFilterTree(), error: '' }
    return { tree: createParser(tokens, optionIndex).parse(), error: '' }
  } catch (error) {
    return { tree: null, error: error.message }
  }
}

// ── Tree editing helpers ──────────────────────────────────────

export function updateNode(tree, id, updater) {
  if (!tree) return tree
  if (tree.id === id) return updater(tree)
  if (tree.kind !== 'group') return tree
  return { ...tree, children: tree.children.map((child) => updateNode(child, id, updater)) }
}

export function removeNode(tree, id) {
  if (!tree || tree.kind !== 'group') return tree
  return {
    ...tree,
    children: tree.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === 'group' ? removeNode(child, id) : child)),
  }
}

export function addToGroup(tree, groupId, node) {
  return updateNode(tree, groupId, (group) => ({ ...group, children: [...group.children, node] }))
}

export function treeHasField(node, fieldKey) {
  if (!node) return false
  if (node.kind === 'rule') return node.field === fieldKey && isRuleComplete(node)
  return (node.children || []).some((child) => treeHasField(child, fieldKey))
}
