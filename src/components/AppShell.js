'use client'

import { useEffect, useState } from 'react'
import { useShop } from '@/context/ShopContext'
import LoadingPlaceholder from './LoadingPlaceholder'
import Sidebar from './Sidebar'
import { usePathname } from 'next/navigation'

const PUBLIC_PATHS = ['/login', '/onboarding', '/store']
const DEFAULT_SIDEBAR_MODE = 'expanded'

export default function AppShell({ children }) {
  const { loading } = useShop()
  const pathname    = usePathname()
  const isPublic    = PUBLIC_PATHS.some(p => pathname.startsWith(p))
  const [sidebarMode, setSidebarMode] = useState(DEFAULT_SIDEBAR_MODE)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const savedMode = window.localStorage.getItem('sidebarMode')
    if (savedMode === 'expanded' || savedMode === 'collapsed' || savedMode === 'hidden') {
      setSidebarMode(savedMode)
      return
    }

    const legacyHidden = window.localStorage.getItem('sidebarHidden') === 'true'
    setSidebarMode(legacyHidden ? 'hidden' : DEFAULT_SIDEBAR_MODE)
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.body.classList.toggle('app-shell-locked', !isPublic && !loading)
    return () => document.body.classList.remove('app-shell-locked')
  }, [isPublic, loading])

  function updateSidebarMode(nextMode) {
    setSidebarMode(nextMode)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('sidebarMode', nextMode)
      window.localStorage.removeItem('sidebarHidden')
    }
  }

  // Full-screen spinner during auth init — prevents content flash before redirect
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 px-4 py-10">
        <LoadingPlaceholder label="Loading workspace" rows={4} fullPage />
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
      <Sidebar
        mode={sidebarMode}
        onSetMode={updateSidebarMode}
      />
      {/* pb-16 = space for mobile bottom nav bar */}
      <main className="relative flex-1 overflow-y-auto overscroll-contain pb-16 lg:pb-0 pt-[calc(56px+env(safe-area-inset-top))] lg:pt-0 min-w-0">
        {sidebarMode === 'hidden' && (
          <button
            type="button"
            onClick={() => updateSidebarMode('expanded')}
            className="hidden lg:inline-flex fixed left-3 top-3 z-30 items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <span>☰</span>
            <span>Show Menu</span>
          </button>
        )}
        {children}
      </main>
    </div>
  )
}
