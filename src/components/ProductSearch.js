'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { fmt } from '../lib/gst'

/**
 * Full-screen modal product search.
 * Keyboard: type to filter · ↑↓ navigate · Enter select · Esc close
 */
export default function ProductSearch({ onSelect, onClose }) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [cursor,  setCursor]  = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounced search — 150 ms
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }

    const timer = setTimeout(async () => {
      setLoading(true)
      const q = query.trim().toLowerCase()
      const { data } = await supabase
        .from('products')
        .select('id,name,brand,barcode,unit,mrp,selling_price,gst_rate,stock_qty')
        .ilike('search_text', `%${q}%`)
        .eq('is_active', true)
        .order('name')
        .limit(12)

      setResults(data || [])
      setCursor(0)
      setLoading(false)
    }, 150)

    return () => clearTimeout(timer)
  }, [query])

  function handleKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault()
      onSelect(results[cursor])
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  // Keep selected item visible
  const itemRefs = useRef([])
  useEffect(() => {
    itemRefs.current[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <span className="text-gray-400 text-lg">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search by name, barcode, brand or tag…"
            className="flex-1 text-base outline-none"
          />
          {loading && <span className="text-xs text-gray-400 animate-pulse">searching…</span>}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {results.length === 0 && query && !loading && (
            <div className="px-4 py-6 text-center text-gray-400 text-sm">
              No products found for &ldquo;{query}&rdquo;
            </div>
          )}
          {results.length === 0 && !query && (
            <div className="px-4 py-6 text-center text-gray-400 text-sm">
              Start typing to search products
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
              {/* Product info */}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{p.name}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {p.brand && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-1.5 rounded">{p.brand}</span>
                  )}
                  {p.barcode && (
                    <span className="text-xs font-mono text-gray-400">{p.barcode}</span>
                  )}
                  <span className="text-xs text-gray-400">{p.unit}</span>
                </div>
              </div>

              {/* Price + stock */}
              <div className="text-right ml-4 flex-shrink-0">
                <div className="font-bold text-blue-700 text-sm">
                  {fmt(p.selling_price || p.mrp)}
                </div>
                <div className="text-xs text-gray-400">
                  GST {p.gst_rate}% · Stock:{' '}
                  <span className={p.stock_qty <= 0 ? 'text-red-500 font-semibold' : 'text-green-600'}>
                    {p.stock_qty}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-1.5 bg-gray-50 border-t text-xs text-gray-400 flex gap-4">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  )
}
