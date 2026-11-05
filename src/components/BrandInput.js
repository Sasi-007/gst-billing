'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cleanBrandName, normalizeBrandKey, suggestBrandMatches } from '@/lib/brands'

/**
 * Brand picker that works the same on mobile and desktop.
 *
 * A native <datalist> is unreliable on Android/iOS browsers (the dropdown often
 * never appears), so the option list is rendered directly. It is portalled to
 * the body with fixed positioning so that scroll containers such as the Quick
 * Add table (overflow-x-auto) cannot clip it.
 */
export default function BrandInput({
  value,
  onChange,
  brands = [],
  placeholder = 'Pick existing or type new',
  className = '',
  inputClassName = 'w-full border rounded-lg px-3 py-2 text-sm',
  uppercase = true,
  showNewHint = true,
  compact = false,
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const wrapperRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const listId = useId()

  const measure = useCallback(() => {
    const node = inputRef.current
    if (!node) return
    const box = node.getBoundingClientRect()
    const spaceBelow = window.innerHeight - box.bottom
    const maxHeight = Math.max(120, Math.min(224, spaceBelow - 12))
    // Flip above the field when the keyboard or page bottom squeezes the space.
    const dropUp = spaceBelow < 160 && box.top > spaceBelow
    // Narrow table cells would otherwise clip brand names, so widen and keep it on screen.
    const margin = 8
    const width = Math.min(Math.max(box.width, 176), window.innerWidth - margin * 2)
    const left = Math.min(Math.max(margin, box.left), window.innerWidth - width - margin)
    setRect({
      left,
      width,
      top: dropUp ? undefined : box.bottom + 4,
      bottom: dropUp ? window.innerHeight - box.top + 4 : undefined,
      maxHeight: dropUp ? Math.max(120, Math.min(224, box.top - 12)) : maxHeight,
    })
  }, [])

  useEffect(() => {
    if (!open) return undefined
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(event) {
      if (wrapperRef.current?.contains(event.target)) return
      if (listRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const typed = cleanBrandName(value)
  const typedKey = normalizeBrandKey(typed)

  const options = useMemo(() => {
    const all = [...new Set((brands || []).map(cleanBrandName).filter(Boolean))]
    if (!typed) return all.slice(0, 50)
    const term = typed.toLowerCase()
    const key = normalizeBrandKey(typed)
    return all
      .filter((brand) => brand.toLowerCase().includes(term) || normalizeBrandKey(brand).includes(key))
      .slice(0, 50)
  }, [brands, typed])

  const suggestions = useMemo(() => suggestBrandMatches(value, brands), [value, brands])
  const isNew = Boolean(typed) && !brands.some((brand) => normalizeBrandKey(brand) === typedKey)

  function pick(brand) {
    onChange(brand)
    setOpen(false)
  }

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        value={value ?? ''}
        onChange={(e) => {
          onChange(uppercase ? e.target.value.toUpperCase() : e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'Enter' && open) setOpen(false)
        }}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
      />

      {open && rect && options.length > 0 && typeof document !== 'undefined' && createPortal(
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          style={{
            position: 'fixed',
            left: rect.left,
            width: rect.width,
            top: rect.top,
            bottom: rect.bottom,
            maxHeight: rect.maxHeight,
          }}
          className="z-50 overflow-y-auto rounded-lg border bg-white shadow-lg text-sm"
        >
          {options.map((brand) => (
            <li key={brand}>
              <button
                type="button"
                role="option"
                aria-selected={normalizeBrandKey(brand) === typedKey}
                onClick={() => pick(brand)}
                className="w-full text-left px-3 py-2 hover:bg-blue-50 active:bg-blue-100"
              >
                {brand}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}

      {!open && suggestions.length > 0 && (
        <div className={`mt-1 text-amber-700 ${compact ? 'text-[11px]' : 'text-xs'}`}>
          Did you mean{' '}
          {suggestions.map((suggestion, index) => (
            <span key={suggestion}>
              {index > 0 && ' / '}
              <button
                type="button"
                onClick={() => pick(suggestion)}
                className="underline font-medium hover:text-amber-900"
              >
                {suggestion}
              </button>
            </span>
          ))}
          ?
        </div>
      )}

      {showNewHint && !open && isNew && suggestions.length === 0 && (
        <p className={`mt-1 text-blue-600 ${compact ? 'text-[11px]' : 'text-xs'}`}>
          New brand — will be created when saved.
        </p>
      )}
    </div>
  )
}
