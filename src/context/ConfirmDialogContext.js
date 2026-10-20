'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/**
 * App-styled replacement for window.confirm / window.prompt / window.alert.
 *
 * The native dialogs cannot be themed, show the "localhost:3000 says" origin
 * line, and are suppressed entirely by some installed-PWA shells — which would
 * silently skip a destructive confirmation. These render in-app instead and
 * resolve a promise, so callers keep the familiar
 * `if (!(await confirm(...))) return` shape.
 */
const ConfirmDialogContext = createContext(null)

const TONES = {
  danger: {
    icon: '⚠',
    iconClass: 'bg-red-100 text-red-600',
    confirmClass: 'bg-red-600 hover:bg-red-700 disabled:bg-gray-300',
  },
  warning: {
    icon: '!',
    iconClass: 'bg-amber-100 text-amber-700',
    confirmClass: 'bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300',
  },
  info: {
    icon: 'i',
    iconClass: 'bg-blue-100 text-blue-600',
    confirmClass: 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300',
  },
}

function Dialog({ request, onResolve }) {
  const {
    title,
    message,
    details,
    detailsTone,
    confirmLabel,
    cancelLabel,
    tone,
    requireText,
    alertOnly,
  } = request

  const [typed, setTyped] = useState('')
  const inputRef = useRef(null)
  const confirmRef = useRef(null)
  const toneStyle = TONES[tone] || TONES.danger
  // Keywords like RESET are matched loosely, but a shop name must be typed as
  // written — otherwise two shops differing only in case would be interchangeable.
  const keywordPhrase = !!requireText && requireText === String(requireText).toUpperCase()
  const satisfied = !requireText || (keywordPhrase
    ? typed.trim().toUpperCase() === String(requireText).toUpperCase()
    : typed.trim() === String(requireText))

  useEffect(() => {
    const target = requireText ? inputRef.current : confirmRef.current
    target?.focus()
  }, [requireText])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onResolve(alertOnly ? true : false)
      }
      if (event.key === 'Enter' && satisfied && !requireText) {
        event.preventDefault()
        onResolve(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [alertOnly, onResolve, requireText, satisfied])

  // Paragraphs keep the line breaks that the old \n\n-joined strings relied on.
  const paragraphs = String(message || '').split('\n').filter((line) => line.trim())

  return (
    <div
      className="no-print fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-3 sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onResolve(alertOnly ? true : false)
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-start gap-3 px-4 pt-4">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg font-bold ${toneStyle.iconClass}`}>
            {toneStyle.icon}
          </div>
          <h2 className="min-w-0 flex-1 pt-1 text-base font-semibold text-gray-900">{title}</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:pl-16">
          {paragraphs.map((line, index) => (
            <p key={index} className="mb-1.5 text-sm text-gray-600 last:mb-0">{line}</p>
          ))}

          {details && (
            <div
              className={`mt-2 whitespace-pre-line rounded-lg px-3 py-2 text-xs ${
                detailsTone === 'ok'
                  ? 'bg-emerald-50 text-emerald-900'
                  : 'bg-amber-50 text-amber-900'
              }`}
            >
              {details}
            </div>
          )}

          {requireText && (
            <label className="mt-3 block">
              <span className="text-xs font-medium text-gray-700">
                Type <strong className="font-mono">{requireText}</strong> to confirm
              </span>
              <input
                ref={inputRef}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && satisfied) {
                    event.preventDefault()
                    onResolve(true)
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm focus:border-red-400 focus:outline-none ${keywordPhrase ? 'uppercase' : ''}`}
                placeholder={requireText}
              />
            </label>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
          {!alertOnly && (
            <button
              type="button"
              onClick={() => onResolve(false)}
              className="rounded-lg border bg-white px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:py-2"
            >
              {cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onResolve(true)}
            disabled={!satisfied}
            className={`rounded-lg px-3 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed sm:py-2 ${toneStyle.confirmClass}`}
          >
            {confirmLabel || (alertOnly ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialogProvider({ children }) {
  const [request, setRequest] = useState(null)
  const resolverRef = useRef(null)

  const ask = useCallback((options) => {
    const config = typeof options === 'string' ? { message: options } : (options || {})
    return new Promise((resolve) => {
      // A second dialog would strand the first promise, so settle it first.
      if (resolverRef.current) resolverRef.current(false)
      resolverRef.current = resolve
      setRequest({
        title: config.title || 'Please confirm',
        message: config.message || '',
        details: config.details || '',
        detailsTone: config.detailsTone || '',
        confirmLabel: config.confirmLabel || '',
        cancelLabel: config.cancelLabel || '',
        tone: config.tone || 'danger',
        requireText: config.requireText || '',
        alertOnly: !!config.alertOnly,
      })
    })
  }, [])

  const notify = useCallback((options) => {
    const config = typeof options === 'string' ? { message: options } : (options || {})
    return ask({
      tone: 'info',
      title: 'Notice',
      confirmLabel: 'OK',
      ...config,
      alertOnly: true,
    })
  }, [ask])

  const handleResolve = useCallback((result) => {
    const resolver = resolverRef.current
    resolverRef.current = null
    setRequest(null)
    if (resolver) resolver(result)
  }, [])

  const value = useMemo(() => ({ confirm: ask, alert: notify }), [ask, notify])

  return (
    <ConfirmDialogContext.Provider value={value}>
      {children}
      {request && <Dialog request={request} onResolve={handleResolve} />}
    </ConfirmDialogContext.Provider>
  )
}

export function useConfirm() {
  const context = useContext(ConfirmDialogContext)
  if (!context) {
    throw new Error('useConfirm must be used inside ConfirmDialogProvider')
  }
  return context
}
