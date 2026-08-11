'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/gst'

/**
 * Full-screen modal product search.
 * Props:
 *   onSelect(product)    — inventory product picked
 *   onAddFreeText(name)  — item not in inventory; add as free-text line
 *   onClose()
 */
export default function ProductSearch({ onSelect, onAddFreeText, onClose }) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [cursor,  setCursor]  = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef  = useRef(null)
  const itemRefs  = useRef([])

  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounced search — 150 ms
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(search, 150)
    return () => clearTimeout(timer)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  async function search() {
    const q = query.trim().toLowerCase()
    setLoading(true)
    try {
      // OR: search_text (computed), name, barcode — name is fallback if search_text not yet built
      const { data, error } = await supabase
        .from('products')
        .select('id,name,brand,barcode,unit,mrp,selling_price,gst_rate,stock_qty,hsn_code')
        .or(`search_text.ilike.%${q}%,name.ilike.%${q}%,barcode.ilike.%${q}%`)
        .eq('is_active', true)
        .order('name')
        .limit(12)

      if (!error) { setResults(data || []); setCursor(0) }
    } finally {
      setLoading(false)
    }
  }

  // Keep highlighted row visible
  useEffect(() => {
    itemRefs.current[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  function handleKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (results.length > 0) {
        onSelect(results[cursor])
      } else if (query.trim() && onAddFreeText) {
        // Enter with no results → add as free-text
        onAddFreeText(query.trim())
      }
    } else if (e.key === 'Escape') { onClose() }
  }

  const trimmed = query.trim()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 sm:pt-16 bg-black/60 px-2"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden">

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <span className="text-gray-400 text-lg flex-shrink-0">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search by name, barcode, brand or tag…"
            className="flex-1 text-base outline-none min-w-0"
          />
          {loading && <span className="text-xs text-gray-400 animate-pulse flex-shrink-0">searching…</span>}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none flex-shrink-0">✕</button>
        </div>

        {/* Results list */}
        <div className="max-h-72 overflow-y-auto">
          {!trimmed && (
            <div className="px-4 py-5 text-center text-gray-400 text-sm">
              Start typing to search products
            </div>
          )}

          {trimmed && !loading && results.length === 0 && (
            <div className="p-4">
              <p className="text-sm text-gray-500 mb-3">
                No products found for <strong>&ldquo;{trimmed}&rdquo;</strong>
              </p>
              <div className="space-y-2">
                {onAddFreeText && (
                  <button
                    onClick={() => onAddFreeText(trimmed)}
                    className="w-full text-left px-3 py-2.5 bg-blue-50 border border-blue-200
                               text-blue-700 rounded-lg text-sm hover:bg-blue-100 transition-colors"
                  >
                    <span className="font-medium">+ Add &ldquo;{trimmed}&rdquo; directly to bill</span>
                    <span className="block text-xs text-blue-500 mt-0.5">
                      Free-text item (not linked to inventory) — you can enter price manually
                    </span>
                  </button>
                )}
                <a
                  href={`/inventory/new?name=${encodeURIComponent(trimmed)}`}
                  onClick={onClose}
                  className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200
                             text-green-700 rounded-lg text-sm hover:bg-green-100 transition-colors"
                >
                  <span>📦</span>
                  <span>
                    <span className="font-medium">Add &ldquo;{trimmed}&rdquo; to Inventory first</span>
                    <span className="block text-xs text-green-500 mt-0.5">Opens inventory page → come back to bill</span>
                  </span>
                  <span className="ml-auto">→</span>
                </a>
              </div>
            </div>
          )}

          {results.map((p, i) => (
            <div
              key={p.id}
              ref={el => (itemRefs.current[i] = el)}
              className={`flex items-center px-4 py-2.5 cursor-pointer border-b last:border-0 transition-colors ${
                i === cursor
                  ? 'bg-blue-50 border-l-4 border-l-blue-500'
                  : 'hover:bg-gray-50 border-l-4 border-l-transparent'
              }`}
              onClick={() => onSelect(p)}
              onMouseEnter={() => setCursor(i)}
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{p.name}</div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {p.brand && <span className="text-xs bg-gray-100 text-gray-600 px-1.5 rounded">{p.brand}</span>}
                  {p.barcode && <span className="text-xs font-mono text-gray-400">{p.barcode}</span>}
                  <span className="text-xs text-gray-400">{p.unit}</span>
                </div>
              </div>
              <div className="text-right ml-3 flex-shrink-0">
                <div className="font-bold text-blue-700 text-sm">{fmt(p.selling_price || p.mrp)}</div>
                <div className="text-xs text-gray-400">
                  GST {p.gst_rate}% ·{' '}
                  <span className={p.stock_qty <= 0 ? 'text-red-500 font-semibold' : 'text-green-600'}>
                    {p.stock_qty <= 0 ? 'Out of stock' : `${p.stock_qty} in stock`}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Keyboard hints */}
        <div className="px-4 py-1.5 bg-gray-50 border-t text-xs text-gray-400 flex flex-wrap gap-3">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          {trimmed && results.length === 0 && onAddFreeText && (
            <span className="text-blue-500">Enter → add as free-text item</span>
          )}
          <span>Esc close</span>
        </div>
      </div>
    </div>
  )
}
