'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { searchCommands } from '@/lib/commands'

export default function CommandPalette({ open, onClose }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const results = useMemo(() => searchCommands(query), [query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    // Focus after paint so the mobile keyboard opens reliably.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  const run = useCallback((command) => {
    if (!command) return
    onClose()
    router.push(command.href)
  }, [onClose, router])

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (results.length ? (index + 1) % results.length : 0))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (results.length ? (index - 1 + results.length) % results.length : 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(results[activeIndex])
    }
  }

  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  let lastGroup = null

  return (
    <div className="fixed inset-0 z-[100] no-print" role="dialog" aria-modal="true" aria-label="Command search">
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 w-full h-full bg-gray-900/50 backdrop-blur-[1px] cursor-default"
      />
      <div className="relative mx-auto mt-[8vh] w-[94vw] max-w-xl rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 border-b px-3">
          <span className="text-gray-400 text-lg">🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type what you want — add purchase, new bill, gst, search invoice…"
            className="flex-1 py-3.5 text-sm outline-none placeholder:text-gray-400"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-gray-700 px-2 py-1"
          >
            Esc
          </button>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto overscroll-contain py-1">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              Nothing matched “{query}”. Try “purchase”, “invoice”, “stock”, “gst” or “expense”.
            </div>
          ) : (
            results.map((command, index) => {
              const showGroup = command.group !== lastGroup
              lastGroup = command.group
              const isActive = index === activeIndex
              return (
                <div key={command.id}>
                  {showGroup && (
                    <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {command.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => run(command)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${
                      isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-lg shrink-0">{command.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm font-medium truncate ${isActive ? 'text-blue-800' : 'text-gray-900'}`}>
                        {command.label}
                      </span>
                      <span className="block text-xs text-gray-500 truncate">{command.hint}</span>
                    </span>
                    {isActive && <span className="text-[11px] text-blue-600 shrink-0">↵</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="hidden sm:flex items-center gap-3 border-t px-4 py-2 text-[11px] text-gray-400">
          <span><kbd className="!bg-gray-100 !text-gray-600">↑</kbd> <kbd className="!bg-gray-100 !text-gray-600">↓</kbd> navigate</span>
          <span><kbd className="!bg-gray-100 !text-gray-600">↵</kbd> open</span>
          <span className="ml-auto"><kbd className="!bg-gray-100 !text-gray-600">Ctrl</kbd> + <kbd className="!bg-gray-100 !text-gray-600">K</kbd> anytime</span>
        </div>
      </div>
    </div>
  )
}
