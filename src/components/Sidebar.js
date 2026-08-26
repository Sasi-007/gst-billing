'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { usePageLoading } from '@/context/PageLoadingContext'
import { useShop } from '@/context/ShopContext'

const NAV = [
  { href: '/',          icon: '📊', label: 'Dashboard',  key: 'h' },
  { href: '/billing',   icon: '🧾', label: 'New Bill',   key: 'b' },
  { href: '/quotation', icon: '📄', label: 'Quotation',  key: 'q' },
  { href: '/credits',   icon: '📒', label: 'Credit Book',key: 'u' },
  { href: '/inventory', icon: '📦', label: 'Inventory',  key: 'i' },
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
    items: NAV.slice(0, 7),
  },
  {
    title: 'Finance',
    items: NAV.slice(7, 14),
  },
  {
    title: 'System',
    items: NAV.slice(14),
  },
]

const MOBILE_NAV = [
  { href: '/',          icon: '📊', label: 'Home'     },
  { href: '/billing',   icon: '🧾', label: 'Bill'     },
  { href: '/credits',   icon: '📒', label: 'Credit'   },
  { href: '/inventory', icon: '📦', label: 'Stock'    },
  { href: '/categories', icon: '🏷️', label: 'Cat'     },
  { href: '/summary',   icon: '🧮', label: 'Summary'  },
  { href: '/expenses',  icon: '💸', label: 'Expense'  },
  { href: '/investments', icon: '🏦', label: 'Invest' },
  { href: '/drawings',  icon: '↗️', label: 'Draw'     },
  { href: '/banking',   icon: '🏛️', label: 'Bank'     },
  { href: '/purchases', icon: '🛒', label: 'Purchase' },
  { href: '/settings',  icon: '⚙️', label: 'More'     },
]

export default function Sidebar({ mode = 'expanded', onSetMode }) {
  const pathname = usePathname()
  const router   = useRouter()
  const { isPageLoading } = usePageLoading()
  const { shop, user, allShops, loading, switchShop, signOut } = useShop()
  const [showShops, setShowShops] = useState(false)
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

  const isPublicPage = ['/login', '/onboarding'].some(p => pathname.startsWith(p))
  // AppShell handles public pages — sidebar never renders there
  if (isPublicPage || loading || !user || isHidden) return null

  function prepareNavigation(href) {
    router.prefetch(href)
  }

  return (
    <>
      {/* ── Desktop sidebar ────────────────────────────────────── */}
      <aside className={`hidden md:flex ${isCollapsed ? 'w-16' : 'w-52'} bg-gray-900 text-white flex-col flex-shrink-0 h-screen no-print transition-[width] duration-200`}>

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
                      pathname === n.href
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

      {/* ── Mobile bottom nav bar ──────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-gray-900 border-t border-gray-700
                      flex items-stretch overflow-x-auto no-print" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {MOBILE_NAV.map(n => (
          <Link key={n.href} href={n.href}
            onClick={() => prepareNavigation(n.href)}
            className={`min-w-[72px] flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors ${
              pathname === n.href ? 'text-blue-400' : 'text-gray-500'
            }`}>
            <span className="text-xl leading-none">{n.icon}</span>
            <span className="text-[10px]">{n.label}</span>
          </Link>
        ))}
      </nav>
    </>
  )
}
