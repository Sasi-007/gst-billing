'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '../lib/supabase'
import { purgeCachedShopData } from '../lib/offlineBilling'

const ShopContext = createContext(null)

const SHOPS_CACHE_KEY = 'cachedShops'
const USER_CACHE_KEY = 'cachedUser'

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

// supabase-js serialises auth work behind a navigator.locks lock. If that lock
// is never released (another tab, a restored bfcache page, an interrupted
// refresh) the auth promise neither resolves nor rejects, which would leave the
// app on "Loading workspace…" forever. Always race it against a timeout.
const AUTH_TIMEOUT_MS = 8000

function withTimeout(promise, ms = AUTH_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function readCachedUser() {
  if (typeof window === 'undefined') return null
  try {
    return JSON.parse(window.localStorage.getItem(USER_CACHE_KEY) || 'null')
  } catch (err) {
    return null
  }
}

function writeCachedUser(nextUser) {
  if (typeof window === 'undefined') return
  try {
    if (!nextUser) {
      window.localStorage.removeItem(USER_CACHE_KEY)
      return
    }
    // Only the identity bits the UI needs — never tokens.
    window.localStorage.setItem(
      USER_CACHE_KEY,
      JSON.stringify({ id: nextUser.id, email: nextUser.email }),
    )
  } catch (err) {
    console.warn('Failed to cache user for offline use:', err)
  }
}

function readCachedShops() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SHOPS_CACHE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    return []
  }
}

function writeCachedShops(shops) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SHOPS_CACHE_KEY, JSON.stringify(shops))
  } catch (err) {
    console.warn('Failed to cache shops for offline use:', err)
  }
}

export function ShopProvider({ children }) {
  const [shop, setShop] = useState(null)
  const [user, setUser] = useState(null)
  const [allShops, setAllShops] = useState([])
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState(true)

  const router = useRouter()
  const pathname = usePathname()

  // Prevent duplicate initial loading
  const initialised = useRef(false)
  const currentUserIdRef = useRef(null)

  useEffect(() => {
    let mounted = true

    async function initialise() {
      if (initialised.current) return
      initialised.current = true

      await loadSession()
    }

    initialise()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return

      // INITIAL_SESSION is already handled by loadSession()
      if (event === 'INITIAL_SESSION') return

      if (session?.user) {
        setUser(session.user)
        writeCachedUser(session.user)

        if (currentUserIdRef.current !== session.user.id) {
          currentUserIdRef.current = session.user.id
          // supabase-js invokes this callback while holding its auth lock, so
          // querying here would deadlock. Defer until the lock is released.
          setTimeout(() => {
            if (mounted) loadShops(session.user.id)
          }, 0)
        }
      } else {
        currentUserIdRef.current = null
        setUser(null)
        setShop(null)
        setAllShops([])
        setLoading(false)
      }
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track connectivity so auth redirects and shop data resume once we are back online.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const sync = () => setOnline(window.navigator.onLine)
    sync()

    const handleOnline = () => {
      setOnline(true)
      // With a verified user we only need fresh shop data; otherwise the
      // session itself was never confirmed, so re-run the full check.
      if (currentUserIdRef.current) {
        loadShops(currentUserIdRef.current)
      } else {
        loadSession()
      }
    }
    const handleOffline = () => setOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redirect based on authentication/shop state
  useEffect(() => {
    if (loading) return

    const isLoginPage = pathname.startsWith('/login')
    const isOnboardingPage = pathname.startsWith('/onboarding')
    const isStorePage = pathname.startsWith('/store')
    const isPublic = isLoginPage || isOnboardingPage || isStorePage

    const isApi = pathname.startsWith('/api')

    // Never redirect API routes
    if (isApi) return

    // Offline we cannot verify auth or refresh the shop list. If a shop was
    // cached from a previous session, keep the user on the page they already
    // have instead of bouncing them to login/onboarding we cannot complete.
    // Without a cached shop there is nothing to work on, so fall through and
    // let the normal redirect send them to the (cached) login page.
    if ((!online || isOffline()) && shop) return

    // Not logged in
    if (!user && !isPublic) {
      router.replace('/login')
      return
    }

    // Logged in but no shop yet — send to onboarding, even from /login
    // (only skip this if already on /onboarding or the public /store page)
    if (user && !shop && !isOnboardingPage && !isStorePage) {
      router.replace('/onboarding')
      return
    }

    // Logged in and has shop, but currently on login/onboarding
    if (user && shop && (isLoginPage || isOnboardingPage)) {
      router.replace('/')
    }
  }, [loading, user, shop, pathname, router, online])

  async function loadSession() {
    // Offline, skip straight to the cached workspace. getSession() may try to
    // refresh an expired token, and that request only fails after a long retry.
    if (isOffline() && readCachedShops().length > 0) {
      setUser(readCachedUser())
      applyShops(readCachedShops(), { fromCache: true })
      setLoading(false)
      return
    }

    try {
      const result = await withTimeout(supabase.auth.getSession())

      if (result?.__timedOut) {
        // The auth lock never released. Fall back to the cached workspace so the
        // app stays usable instead of hanging on "Loading workspace…".
        console.warn('Auth session check timed out — using cached workspace')
        const cachedShops = readCachedShops()
        const cachedUser = readCachedUser()
        if (cachedUser && cachedShops.length > 0) {
          currentUserIdRef.current = cachedUser.id || null
          setUser(cachedUser)
          applyShops(cachedShops, { fromCache: true })
        } else {
          currentUserIdRef.current = null
          setUser(null)
          setShop(null)
          setAllShops([])
        }
        setLoading(false)
        return
      }

      const session = result?.data?.session

      if (session?.user) {
        currentUserIdRef.current = session.user.id
        setUser(session.user)
        writeCachedUser(session.user)
        await loadShops(session.user.id)
      } else {
        currentUserIdRef.current = null

        // Offline the stored token may be unverifiable (e.g. expired and the
        // refresh call failed), but the cached user and shop still identify the
        // workspace so previously loaded pages keep working.
        const cachedShops = readCachedShops()
        if (isOffline() && cachedShops.length > 0) {
          setUser(readCachedUser())
          applyShops(cachedShops, { fromCache: true })
        } else {
          setUser(null)
          setShop(null)
          setAllShops([])
        }

        setLoading(false)
      }
    } catch (err) {
      // Network/auth failure — don't leave the app stuck on "Loading workspace…"
      console.error('Error loading session:', err)
      currentUserIdRef.current = null

      // Offline the session could not be verified, but the cached user and shop
      // keep already-loaded pages working until connectivity returns.
      if (isOffline()) {
        setUser(readCachedUser())
        applyShops(readCachedShops(), { fromCache: true })
      } else {
        setUser(null)
        setShop(null)
        setAllShops([])
      }

      setLoading(false)
    }
  }

  async function loadShops(userId) {
    setLoading(true)

    // Offline the request can only fail after a slow retry/backoff cycle, which
    // would leave the app on "Loading workspace…" for many seconds. Use the
    // cached shops straight away instead.
    if (isOffline()) {
      applyShops(readCachedShops(), { fromCache: true })
      setLoading(false)
      return
    }

    try {
      const result = await withTimeout(
        supabase
          .from('user_shops')
          .select('role, shops(*)')
          .eq('user_id', userId),
      )

      if (result?.__timedOut) {
        console.warn('Shop load timed out — using cached shops')
        applyShops(readCachedShops(), { fromCache: true })
        return
      }

      const { data, error } = result

      if (error) {
        console.error('Error loading shops:', error)
        applyShops(readCachedShops(), { fromCache: true })
        return
      }

      const shops = (data || [])
        .filter((row) => row.shops)
        .map((row) => ({
          ...row.shops,
          role: row.role,
        }))

      applyShops(shops)
    } catch (err) {
      // Network failure — fall back to the last known shops so the app stays
      // usable offline instead of redirecting to onboarding.
      console.error('Error loading shops:', err)
      applyShops(readCachedShops(), { fromCache: true })
    } finally {
      setLoading(false)
    }
  }

  function applyShops(shops, { fromCache = false } = {}) {
    setAllShops(shops)

    if (!fromCache) writeCachedShops(shops)

    if (shops.length > 0) {
      const lastId =
        typeof window !== 'undefined'
          ? localStorage.getItem('activeShopId')
          : null

      const active = shops.find((s) => s.id === lastId) || shops[0]

      setShop(active)

      // Make sure a valid shop is persisted
      if (typeof window !== 'undefined') {
        localStorage.setItem('activeShopId', active.id)
      }
      return
    }

    setShop(null)

    // Keep the cached shop id while offline so it survives until we can refresh.
    if (typeof window !== 'undefined' && !fromCache) {
      localStorage.removeItem('activeShopId')
    }
  }

  // Call after onboarding creates a new shop
  async function refreshShops() {
    const result = await withTimeout(supabase.auth.getSession())
    if (result?.__timedOut) return
    const session = result?.data?.session

    if (session?.user) {
      await loadShops(session.user.id)
    }
  }

  function switchShop(shopId) {
    const target = allShops.find((s) => s.id === shopId)

    if (!target) return

    setShop(target)

    if (typeof window !== 'undefined') {
      localStorage.setItem('activeShopId', shopId)
    }
  }

  async function signOut() {
    try {
      await supabase.auth.signOut()
    } catch (err) {
      // Offline the server call fails, but the local session must still be
      // cleared so the UI does not stay in a half signed-out state.
      console.warn('Sign out request failed, clearing local session anyway:', err)
    }

    if (typeof window !== 'undefined') {
      localStorage.removeItem('activeShopId')
      localStorage.removeItem(SHOPS_CACHE_KEY)
      localStorage.removeItem(USER_CACHE_KEY)

      // Signing out must leave no readable business data behind on the device.
      // sessionStorage holds page caches and in-progress drafts, and the
      // service worker's Cache Storage holds rendered pages and API responses
      // for every visited route — both survive sign-out otherwise.
      try { window.sessionStorage.clear() } catch (err) { /* storage unavailable */ }

      try {
        if (window.caches) {
          const keys = await window.caches.keys()
          await Promise.all(keys.map((key) => window.caches.delete(key)))
        }
      } catch (err) {
        console.warn('Failed to clear offline page cache on sign out:', err)
      }

      await purgeCachedShopData()
    }

    currentUserIdRef.current = null
    setUser(null)
    setShop(null)
    setAllShops([])

    router.replace('/login')
  }

  return (
    <ShopContext.Provider
      value={{
        shop,
        user,
        allShops,
        loading,
        setShop,
        switchShop,
        signOut,
        refreshShops,
      }}
    >
      {children}
    </ShopContext.Provider>
  )
}

export function useShop() {
  const ctx = useContext(ShopContext)

  if (!ctx) {
    throw new Error('useShop must be used inside ShopProvider')
  }

  return ctx
}
