'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

// Decorative soft-blob backdrop behind every illustration — adds the
// polished "landing page" depth seen in typical error-page designs,
// without any external image assets.
function Backdrop({ color = '#dbeafe' }) {
  return (
    <svg viewBox="0 0 240 200" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <path
        d="M40 60c10-30 50-45 90-38s70 30 78 62-10 60-46 70-80 2-104-20-28-44-18-74z"
        fill={color}
      />
    </svg>
  )
}

// "Something went wrong" scene — person beside a snapped utility pole,
// mid-spark, one arm raised to flag the issue. Represents a crash/500.
function CrashIllustration() {
  return (
    <svg viewBox="0 0 240 200" className="relative h-36 w-auto sm:h-44 md:h-48" aria-hidden="true">
      <ellipse cx="120" cy="178" rx="86" ry="9" fill="#e2e8f0" />

      {/* left pole + dangling wire */}
      <rect x="54" y="48" width="7" height="100" rx="3.5" fill="#94a3b8" />
      <rect x="54" y="48" width="7" height="14" rx="3.5" fill="#64748b" />
      <path d="M61 70c14 8 22 20 24 34" stroke="#475569" strokeWidth="3.5" fill="none" strokeLinecap="round" />

      {/* right pole + dangling wire */}
      <rect x="179" y="48" width="7" height="100" rx="3.5" fill="#94a3b8" />
      <rect x="179" y="48" width="7" height="14" rx="3.5" fill="#64748b" />
      <path d="M179 70c-14 8-22 20-24 34" stroke="#475569" strokeWidth="3.5" fill="none" strokeLinecap="round" />

      {/* spark burst between the poles — flickers like a shorting wire */}
      <circle className="err-pulse-ring" cx="120" cy="92" r="20" fill="#fde68a" />
      <circle cx="120" cy="92" r="20" fill="#fef3c7" opacity="0.8" />
      <path
        className="err-flicker"
        d="M123 76l-11 20h10l-6 18 17-22h-11z"
        fill="#f59e0b"
      />

      {/* person */}
      <g transform="translate(88 120)">
        <ellipse cx="22" cy="60" rx="20" ry="5" fill="#cbd5e1" opacity="0.6" />
        {/* legs */}
        <path d="M14 36l-3 24h7l4-22z" fill="#1e293b" />
        <path d="M30 36l3 24h-7l-4-22z" fill="#1e293b" />
        {/* body */}
        <path d="M6 10c0-9 7-16 16-16s16 7 16 16l3 28a5 5 0 0 1-5 6H8a5 5 0 0 1-5-6z" fill="#2563eb" />
        {/* raised arm pointing up at the spark */}
        <path d="M30 6c6-3 11-9 13-17" stroke="#1e3a8a" strokeWidth="6" fill="none" strokeLinecap="round" />
        <circle cx="44" cy="-13" r="4.5" fill="#fbbf24" />
        {/* other arm */}
        <path d="M8 14c-4 3-7 8-7 14" stroke="#1e3a8a" strokeWidth="6" fill="none" strokeLinecap="round" />
        {/* head */}
        <circle cx="22" cy="-8" r="13" fill="#0f172a" />
      </g>
    </svg>
  )
}

// "Misdirected / page not found" scene — a traveller who's wandered off the
// path toward a swinging 404 signpost, with an animated trail showing the
// wrong turn. Visually distinct from the crash scene so users instantly
// recognise a navigation mistake rather than an app failure.
function NotFoundIllustration() {
  return (
    <svg viewBox="0 0 240 200" className="relative h-36 w-auto sm:h-44 md:h-48" aria-hidden="true">
      <ellipse cx="120" cy="178" rx="88" ry="9" fill="#e2e8f0" />

      {/* animated trail wandering off toward the signpost */}
      <path
        className="err-dash"
        d="M28 168q34 6 62-10t52-6"
        stroke="#94a3b8"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />

      {/* signpost: pole + crossbar, with a sign hanging from it */}
      <rect x="168" y="46" width="8" height="104" rx="4" fill="#94a3b8" />
      <rect x="110" y="46" width="66" height="8" rx="4" fill="#64748b" />

      {/* hanging sign — swings gently from the crossbar */}
      <g className="err-swing">
        <path d="M120 54v12M152 54v12" stroke="#64748b" strokeWidth="3" strokeLinecap="round" />
        <rect x="112" y="66" width="48" height="34" rx="8" fill="#2563eb" />
        <text
          x="136"
          y="90"
          textAnchor="middle"
          fontSize="19"
          fontWeight="700"
          fill="#ffffff"
          fontFamily="sans-serif"
        >
          404
        </text>
      </g>

      {/* bobbing question marks above the traveller */}
      <text className="err-bob" x="36" y="64" fontSize="26" fontWeight="700" fill="#f59e0b" fontFamily="sans-serif">
        ?
      </text>
      <text className="err-bob-delayed" x="74" y="50" fontSize="18" fontWeight="700" fill="#fbbf24" fontFamily="sans-serif">
        ?
      </text>

      {/* traveller, looking around for the right way */}
      <g transform="translate(40 104)">
        <ellipse cx="22" cy="66" rx="20" ry="5" fill="#cbd5e1" opacity="0.6" />
        <path d="M14 42l-3 24h7l4-22z" fill="#1e293b" />
        <path d="M30 42l3 24h-7l-4-22z" fill="#1e293b" />
        <path d="M6 16c0-9 7-16 16-16s16 7 16 16l3 26a5 5 0 0 1-5 6H8a5 5 0 0 1-5-6z" fill="#2563eb" />
        <circle cx="22" cy="-2" r="13" fill="#0f172a" />
        {/* hand shading the eyes, scanning for the right route */}
        <path d="M32 6c6 0 11-3 14-8" stroke="#1e3a8a" strokeWidth="6" fill="none" strokeLinecap="round" />
        {/* other arm resting */}
        <path d="M8 20c-4 3-7 8-7 14" stroke="#1e3a8a" strokeWidth="6" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}

const VARIANTS = {
  crash: { Illustration: CrashIllustration, blob: '#dbeafe' },
  notFound: { Illustration: NotFoundIllustration, blob: '#e0e7ff' },
}

/**
 * Shared status-page UI used by route `error.js` boundaries and `not-found.js`.
 * Keeps the app shell (sidebar/nav) mounted — only the page content area
 * renders this — and offers a CTA back to data the user already has.
 * Fully responsive: stacks and scales down on narrow/mobile viewports.
 */
export default function ErrorState({
  variant = 'crash',
  code,
  title = 'Something went wrong',
  message = "Our team has been notified and is already on it. Your existing data is safe — you can keep working from here.",
  primaryLabel = 'Go to Dashboard',
  primaryHref = '/',
  onReset,
  compact = false,
  showPath = false,
}) {
  const { Illustration, blob } = VARIANTS[variant] || VARIANTS.crash
  const pathname = usePathname()
  // Deferred to after mount: the prerendered /_not-found page has no real
  // pathname, so rendering it during SSR would cause a hydration mismatch.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // Only worth showing when the URL itself is the problem (a mistyped route).
  const attemptedPath = showPath && mounted && pathname && pathname !== '/' ? pathname : null

  return (
    <div className={`flex items-center justify-center px-4 sm:px-6 ${compact ? 'py-8 sm:py-10' : 'min-h-[70vh] py-12 sm:py-16'}`}>
      <div className="err-rise flex w-full max-w-[280px] flex-col items-center text-center sm:max-w-sm md:max-w-md">
        <div className="relative flex h-36 w-36 items-center justify-center sm:h-44 sm:w-44 md:h-48 md:w-48">
          <Backdrop color={blob} />
          <Illustration />
        </div>

        {code && (
          <span className="mt-5 inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold tracking-wide text-gray-500">
            ERROR {code}
          </span>
        )}

        <h2 className="mt-3 text-base font-semibold text-gray-900 sm:text-lg md:text-xl">{title}</h2>
        <p className="mt-2 text-xs text-gray-500 sm:text-sm md:text-base">{message}</p>

        {attemptedPath && (
          <code className="mt-3 inline-block max-w-full truncate rounded-md bg-gray-100 px-2.5 py-1 align-middle font-mono text-xs text-gray-600">
            {attemptedPath}
          </code>
        )}

        <div className="mt-6 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <a
            href={primaryHref}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            {primaryLabel}
          </a>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center justify-center rounded-lg border px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
