'use client'

import { useShop } from '@/context/ShopContext'
import Sidebar from './Sidebar'
import { usePathname } from 'next/navigation'

const PUBLIC_PATHS = ['/login', '/onboarding']

export default function AppShell({ children }) {
  const { loading } = useShop()
  const pathname    = usePathname()
  const isPublic    = PUBLIC_PATHS.some(p => pathname.startsWith(p))

  // Full-screen spinner during auth init — prevents content flash before redirect
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-3">🧾</div>
          <p className="text-sm text-gray-400 animate-pulse">Loading…</p>
        </div>
      </div>
    )
  }

  // Login / Onboarding — full-screen, no sidebar, no bottom nav
  if (isPublic) {
    return <>{children}</>
  }

  // Authenticated app pages
  return (
    <div className="flex h-screen overflow-hidden no-print">
      <Sidebar />
      {/* pb-16 = space for mobile bottom nav bar */}
      <main className="flex-1 overflow-y-auto pb-16 md:pb-0 min-w-0">
        {children}
      </main>
    </div>
  )
}
