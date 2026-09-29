'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { usePageLoading } from '@/context/PageLoadingContext'
import { recordPageVisit } from '@/lib/pageVisits'
import { useShop } from '@/context/ShopContext'

const NAV = [
  { href: '/',          icon: '📊', label: 'Dashboard',  key: 'h' },
  { href: '/billing',   icon: '🧾', label: 'New Bill',   key: 'b' },
  { href: '/billing?view=history', icon: '🗂️', label: 'Invoice History', key: 'j' },
  { href: '/billing/invoice-number-updater', icon: '🔢', label: 'Invoice Numbers', key: null },
  { href: '/quotation', icon: '📄', label: 'Quotation',  key: 'q' },
  { href: '/customers', icon: '👥', label: 'Customers',  key: 'c' },
  { href: '/credits',   icon: '📒', label: 'Credit Book',key: 'u' },
  { href: '/inventory', icon: '📦', label: 'Inventory',  key: 'i' },
  { href: '/price-check', icon: '💰', label: 'Price Check', key: null },
  { href: '/online',    icon: '🌐', label: 'Online Store', key: 'o' },
  { href: '/categories', icon: '🏷️', label: 'Categories', key: null },
  { href: '/purchases', icon: '🛒', label: 'Purchases',  key: 'p' },
  { href: '/suppliers', icon: '🏪', label: 'Suppliers',  key: 's' },
  { href: '/expenses',  icon: '💸', label: 'Expenses',   key: 'x' },
  { href: '/investments', icon: '🏦', label: 'Investments', key: 'n' },
  { href: '/drawings',  icon: '↗️', label: 'Drawings',   key: 'g' },
  { href: '/banking',   icon: '🏛️', label: 'Banking',    key: 'k' },
  { href: '/summary',   icon: '🧮', label: 'Summary',    key: 'm' },
  { href: '/reports',   icon: '📈', label: 'Reports',    key: 't' },
  { href: '/settings',  icon: '⚙️', label: 'Settings',   key: null },
  { href: '/superadmin',icon: '🛡️', label: 'Admin',       key: null },
]

const NAV_SECTIONS = [
  {
    title: 'Main',
    items: NAV.slice(0, 12),
  },
  {
    title: 'Finance',
    items: NAV.slice(12, 19),
  },
  {
    title: 'System',
    items: NAV.slice(19),
  },
]

// Kept to 5 fixed items so the bar never scrolls horizontally — horizontal
// swipes inside a fixed bar trigger iOS back/forward and app-switch gestures
// in standalone PWA mode. Everything else lives in the slide-over menu.
const MOBILE_NAV = [
  { href: '/',          icon: '📊', label: 'Home'     },
  { href: '/billing',   icon: '🧾', label: 'Bill'     },
  { href: '/price-check', icon: '💰', label: 'Price'  },
  { href: '/inventory', icon: '📦', label: 'Stock'    },
]

export default function Sidebar({ mode = 'expanded', onSetMode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router   = useRouter()
  const { isPageLoading } = usePageLoading()
  const { shop, user, allShops, loading, switchShop, signOut } = useShop()
  const [showShops, setShowShops] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const isCollapsed = mode === 'collapsed'
  const isHidden = mode === 'hidden'

  useEffect(() => {
    function onKey(e) {
      if (!e.ctrlKey) return
      const match = NAV.find(n => n.key && n.key === e.key.toLowerCase())
      if (match) {
        e.preventDefault()
        router.push(match.href)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router])

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname, searchParams])

  useEffect(() => {
    recordPageVisit(pathname, searchParams?.toString() || '')
  }, [pathname, searchParams])

  useEffect(() => {
    if (!menuOpen) return
    function onEsc(e) { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onEsc)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onEsc)
      document.body.style.overflow = previousOverflow
    }
  }, [menuOpen])

  const isPublicPage = ['/login', '/onboarding'].some(p => pathname.startsWith(p))
  // AppShell handles public pages — sidebar never renders there
  if (isPublicPage || loading || !user || isHidden) return null

  function prepareNavigation(href) {
    router.prefetch(href)
  }

  function isNavActive(href) {
    const view = searchParams.get('view')
    if (href === '/billing') return pathname === '/billing' && view !== 'history'
    if (href === '/billing?view=history') return pathname === '/billing' && view === 'history'
    return pathname === href
  }

  return (
    <>
      {/* ── Desktop sidebar ────────────────────────────────────── */}
      <aside className={`hidden lg:flex ${isCollapsed ? 'w-16' : 'w-52'} bg-gray-900 text-white flex-col flex-shrink-0 h-screen no-print transition-[width] duration-200`}>

        <div className="px-4 py-3 border-b border-gray-700">
          <div className="flex items-start justify-between gap-2">
            <div
              className="group relative min-w-0"
              title={isCollapsed ? `${shop?.name || 'GST Billing'}${shop?.city ? ` - ${shop.city}` : ''}` : undefined}
            >
              <div className={`text-sm font-bold text-white truncate ${isCollapsed ? 'hidden' : ''}`}>{shop?.name || 'GST Billing'}</div>
              <div className={`text-xs text-gray-400 truncate ${isCollapsed ? 'hidden' : ''}`}>{shop?.city || 'Grocery Store'}</div>
              {isCollapsed && <div className="text-lg text-center">🧾</div>}
              {isCollapsed && (
                <div className="pointer-events-none absolute left-full top-1/2 z-20 ml-3 hidden -translate-y-1/2 whitespace-nowrap rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-left shadow-lg group-hover:block">
                  <div className="text-sm font-semibold text-white">{shop?.name || 'GST Billing'}</div>
                  <div className="text-xs text-gray-400">{shop?.city || 'Grocery Store'}</div>
                </div>
              )}
            </div>
            <div className={`flex items-center gap-1 ${isCollapsed ? 'flex-col' : ''}`}>
              <button
                type="button"
                onClick={() => onSetMode?.(isCollapsed ? 'expanded' : 'collapsed')}
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 hover:text-white"
                title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                {isCollapsed ? '→' : '←'}
              </button>
              {!isCollapsed && (
                <button
                  type="button"
                  onClick={() => onSetMode?.('hidden')}
                  className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 hover:text-white"
                  title="Hide sidebar"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          <div className={`${isCollapsed ? 'mt-2' : 'mt-3'}`}>
            <div className="h-1 overflow-hidden rounded-full bg-gray-800">
              <div
                className={`h-full rounded-full bg-blue-500 transition-all duration-300 ${
                  isPageLoading ? 'w-2/3 animate-pulse opacity-100' : 'w-0 opacity-0'
                }`}
              />
            </div>
          </div>
        </div>

        {/* Shop switcher for multi-brand */}
        {allShops.length > 1 && !isCollapsed && (
          <div className="px-2 py-1 border-b border-gray-700">
            <button onClick={() => setShowShops(v => !v)}
              className="w-full text-left px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-800 rounded flex justify-between">
              <span>Switch shop</span><span>{showShops ? '▲' : '▼'}</span>
            </button>
            {showShops && (
              <div className="bg-gray-800 rounded mt-1">
                {allShops.map(s => (
                  <button key={s.id} onClick={() => { switchShop(s.id); setShowShops(false) }}
                    className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 ${
                      s.id === shop?.id ? 'text-blue-400 font-medium' : 'text-gray-300'
                    }`}>
                    {s.id === shop?.id ? '✓ ' : ''}{s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <nav className="flex-1 py-3 px-2 overflow-y-auto sidebar-scrollbar">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className={isCollapsed ? '' : 'mb-3'}>
              {!isCollapsed && (
                <div className="px-3 pb-1 text-[10px] uppercase tracking-widest text-gray-500">
                  {section.title}
                </div>
              )}
              <div className="space-y-1">
                {section.items.map(n => (
                  <Link key={n.href} href={n.href}
                    onClick={() => prepareNavigation(n.href)}
                    onMouseEnter={() => router.prefetch(n.href)}
                    onFocus={() => router.prefetch(n.href)}
                    title={isCollapsed ? n.label : undefined}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isCollapsed ? 'justify-center px-2' : ''
                    } ${
                      isNavActive(n.href)
                        ? 'bg-blue-600 text-white font-medium shadow-sm'
                        : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                    }`}>
                    <span className="text-base leading-none">{n.icon}</span>
                    {!isCollapsed && <span className="flex-1 truncate">{n.label}</span>}
                    {!isCollapsed && n.key && <span className="text-xs text-gray-600">^{n.key.toUpperCase()}</span>}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-2 py-2 border-t border-gray-700 space-y-1">
          {!isCollapsed && <div className="px-3 text-xs text-gray-600">Use Ctrl+letter shortcuts (avoid Ctrl+C / Ctrl+V / Ctrl+R)</div>}
          <button onClick={signOut}
            title={isCollapsed ? 'Sign out' : undefined}
            className={`w-full ${isCollapsed ? 'flex items-center justify-center px-2' : 'text-left px-3'} py-1.5 text-xs text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg`}>
            {isCollapsed ? '↩' : '↩ Sign out'}
          </button>
        </div>
      </aside>

      {/* ── Mobile / tablet top bar ────────────────────────────── */}
      <header className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between gap-2 bg-gray-900 px-3 py-2 text-white no-print"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{shop?.name || 'GST Billing'}</div>
          <div className="truncate text-[11px] text-gray-400">{shop?.city || 'Grocery Store'}</div>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-100 hover:bg-gray-700"
        >
          <span>☰</span>
          <span>Menu</span>
        </button>
      </header>

      {/* ── Mobile / tablet slide-over menu ────────────────────── */}
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-50 no-print" style={{ touchAction: 'none' }}>
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute right-0 top-0 flex h-full w-[85%] max-w-sm flex-col overscroll-contain bg-gray-900 text-white shadow-xl"
            style={{ touchAction: 'pan-y' }}>
            <div className="flex items-start justify-between gap-2 border-b border-gray-700 px-4 py-3"
              style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{shop?.name || 'GST Billing'}</div>
                <div className="truncate text-xs text-gray-400">{user?.email || shop?.city || ''}</div>
              </div>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-200 hover:bg-gray-700"
              >
                ✕
              </button>
            </div>

            {allShops.length > 1 && (
              <div className="border-b border-gray-700 px-2 py-2">
                <button onClick={() => setShowShops(v => !v)}
                  className="flex w-full justify-between rounded px-2 py-1.5 text-left text-xs text-gray-400 hover:bg-gray-800 hover:text-white">
                  <span>Switch shop</span><span>{showShops ? '▲' : '▼'}</span>
                </button>
                {showShops && (
                  <div className="mt-1 rounded bg-gray-800">
                    {allShops.map(s => (
                      <button key={s.id} onClick={() => { switchShop(s.id); setShowShops(false); setMenuOpen(false) }}
                        className={`block w-full px-3 py-2 text-left text-xs hover:bg-gray-700 ${
                          s.id === shop?.id ? 'font-medium text-blue-400' : 'text-gray-300'
                        }`}>
                        {s.id === shop?.id ? '✓ ' : ''}{s.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <nav className="flex-1 overflow-y-auto px-2 py-3 sidebar-scrollbar">
              {NAV_SECTIONS.map(section => (
                <div key={section.title} className="mb-3">
                  <div className="px-3 pb-1 text-[10px] uppercase tracking-widest text-gray-500">{section.title}</div>
                  <div className="space-y-1">
                    {section.items.map(n => (
                      <Link key={n.href} href={n.href}
                        onClick={() => { prepareNavigation(n.href); setMenuOpen(false) }}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                          isNavActive(n.href)
                            ? 'bg-blue-600 font-medium text-white'
                            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                        }`}>
                        <span className="text-base leading-none">{n.icon}</span>
                        <span className="flex-1 truncate">{n.label}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </nav>

            <div className="border-t border-gray-700 px-2 py-3"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              <button onClick={() => { setMenuOpen(false); signOut() }}
                className="w-full rounded-lg px-3 py-2.5 text-left text-sm text-red-400 hover:bg-gray-800">
                ↩ Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile bottom nav bar ──────────────────────────────── */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-gray-900 border-t border-gray-700
                      flex items-stretch overflow-hidden overscroll-contain no-print"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', touchAction: 'manipulation' }}>
        {MOBILE_NAV.map(n => (
          <Link key={n.href} href={n.href}
            onClick={() => prepareNavigation(n.href)}
            className={`flex-1 basis-0 min-w-0 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors ${
              pathname === n.href ? 'text-blue-400' : 'text-gray-500'
            }`}>
            <span className="text-xl leading-none">{n.icon}</span>
            <span className="text-[10px] truncate">{n.label}</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          className={`flex-1 basis-0 min-w-0 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors ${
            menuOpen ? 'text-blue-400' : 'text-gray-500'
          }`}>
          <span className="text-xl leading-none">☰</span>
          <span className="text-[10px] truncate">More</span>
        </button>
      </nav>
    </>
  )
}
