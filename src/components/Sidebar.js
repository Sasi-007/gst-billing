'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useShop } from '../context/ShopContext'

const NAV = [
  { href: '/',          icon: '📊', label: 'Dashboard',  key: 'h' },
  { href: '/billing',   icon: '🧾', label: 'New Bill',   key: 'b' },
  { href: '/quotation', icon: '📄', label: 'Quotation',  key: 'q' },
  { href: '/inventory', icon: '📦', label: 'Inventory',  key: 'i' },
  { href: '/purchases', icon: '🛒', label: 'Purchases',  key: 'p' },
  { href: '/suppliers', icon: '🏪', label: 'Suppliers',  key: 's' },
  { href: '/reports',   icon: '📈', label: 'Reports',    key: 'r' },
  { href: '/settings',  icon: '⚙️', label: 'Settings',   key: null },
]

const MOBILE_NAV = [
  { href: '/',          icon: '📊', label: 'Home'     },
  { href: '/billing',   icon: '🧾', label: 'Bill'     },
  { href: '/inventory', icon: '📦', label: 'Stock'    },
  { href: '/purchases', icon: '🛒', label: 'Purchase' },
  { href: '/settings',  icon: '⚙️', label: 'More'     },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const { shop, allShops, switchShop, signOut } = useShop()
  const [showShops, setShowShops] = useState(false)

  useEffect(() => {
    function onKey(e) {
      if (!e.ctrlKey) return
      const match = NAV.find(n => n.key && n.key === e.key.toLowerCase())
      if (match) { e.preventDefault(); router.push(match.href) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router])

  const isPublicPage = ['/login', '/onboarding'].some(p => pathname.startsWith(p))
  if (isPublicPage) return null

  return (
    <>
      {/* ── Desktop sidebar ────────────────────────────────────── */}
      <aside className="hidden md:flex w-44 bg-gray-900 text-white flex-col flex-shrink-0 h-screen no-print">

        <div className="px-4 py-3 border-b border-gray-700">
          <div className="text-sm font-bold text-white truncate">{shop?.name || 'GST Billing'}</div>
          <div className="text-xs text-gray-400 truncate">{shop?.city || 'Grocery Store'}</div>
        </div>

        {/* Shop switcher for multi-brand */}
        {allShops.length > 1 && (
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

        <nav className="flex-1 py-2 px-2 overflow-y-auto">
          {NAV.map(n => (
            <Link key={n.href} href={n.href}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-0.5 text-sm transition-colors ${
                pathname === n.href
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}>
              <span className="text-base leading-none">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {n.key && <span className="text-xs text-gray-600">^{n.key.toUpperCase()}</span>}
            </Link>
          ))}
        </nav>

        <div className="px-2 py-2 border-t border-gray-700 space-y-1">
          <div className="px-3 text-xs text-gray-600">Ctrl+letter to navigate</div>
          <button onClick={signOut}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg">
            ↩ Sign out
          </button>
        </div>
      </aside>

      {/* ── Mobile bottom nav bar ──────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-gray-900 border-t border-gray-700
                      flex items-stretch no-print" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {MOBILE_NAV.map(n => (
          <Link key={n.href} href={n.href}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors ${
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
