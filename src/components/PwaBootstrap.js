'use client'

import { useEffect, useRef, useState } from 'react'
import { useShop } from '@/context/ShopContext'
import { listPendingActions } from '@/lib/offlineBilling'

export default function PwaBootstrap() {
  const [isOnline, setIsOnline] = useState(true)
  const [pendingCount, setPendingCount] = useState(0)
  const syncBusyRef = useRef(false)
  const { shop } = useShop()

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (process.env.NODE_ENV !== 'production') {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations.forEach((registration) => registration.unregister())
        }).catch((error) => {
          console.warn('Failed to unregister service workers in dev', error)
        })
      }
      if ('caches' in window) {
        caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch((error) => {
          console.warn('Failed to clear caches in dev', error)
        })
      }
      return
    }

    const updateOnlineState = () => setIsOnline(window.navigator.onLine)
    updateOnlineState()

    const register = async () => {
      if (!('serviceWorker' in navigator)) return
      await navigator.serviceWorker.register('/sw.js')
    }

    register().catch((error) => {
      console.error('Service worker registration failed', error)
    })

    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)

    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  useEffect(() => {
    if (!shop?.id) {
      setPendingCount(0)
      return
    }

    let cancelled = false
    async function refreshPendingCount() {
      if (syncBusyRef.current) return
      syncBusyRef.current = true
      try {
        const queue = await listPendingActions(shop.id)
        if (!cancelled) setPendingCount(queue.length)
      } catch (error) {
        console.warn('Failed to read offline queue:', error)
      } finally {
        syncBusyRef.current = false
      }
    }

    refreshPendingCount()
    const interval = window.setInterval(refreshPendingCount, 5000)
    window.addEventListener('online', refreshPendingCount)
    window.addEventListener('offline-queue-changed', refreshPendingCount)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('online', refreshPendingCount)
      window.removeEventListener('offline-queue-changed', refreshPendingCount)
    }
  }, [shop?.id])

  if (isOnline && pendingCount === 0) return null

  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-center text-sm font-medium text-white shadow-lg max-w-[92vw] md:bottom-3">
      {!isOnline
        ? 'Offline mode active — saved work will sync when internet returns.'
        : `${pendingCount} queued change${pendingCount === 1 ? '' : 's'} waiting to sync`}
    </div>
  )
}
