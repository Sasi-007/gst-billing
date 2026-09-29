'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '../lib/supabase'

const ShopContext = createContext(null)

export function ShopProvider({ children }) {
  const [shop, setShop] = useState(null)
  const [user, setUser] = useState(null)
  const [allShops, setAllShops] = useState([])
  const [loading, setLoading] = useState(true)

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

        if (currentUserIdRef.current !== session.user.id) {
          currentUserIdRef.current = session.user.id
          loadShops(session.user.id)
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
  }, [loading, user, shop, pathname, router])

  async function loadSession() {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (session?.user) {
      currentUserIdRef.current = session.user.id
      setUser(session.user)
      await loadShops(session.user.id)
    } else {
      currentUserIdRef.current = null
      setUser(null)
      setShop(null)
      setAllShops([])
      setLoading(false)
    }
  }

  async function loadShops(userId) {
    setLoading(true)

    const { data, error } = await supabase
      .from('user_shops')
      .select('role, shops(*)')
      .eq('user_id', userId)

    if (error) {
      console.error('Error loading shops:', error)
      setAllShops([])
      setShop(null)
      setLoading(false)
      return
    }

    const shops = (data || [])
      .filter((row) => row.shops)
      .map((row) => ({
        ...row.shops,
        role: row.role,
      }))

    setAllShops(shops)

    if (shops.length > 0) {
      const lastId =
        typeof window !== 'undefined'
          ? localStorage.getItem('activeShopId')
          : null

      const active =
        shops.find((s) => s.id === lastId) || shops[0]

      setShop(active)

      // Make sure a valid shop is persisted
      if (typeof window !== 'undefined') {
        localStorage.setItem('activeShopId', active.id)
      }
    } else {
      setShop(null)

      if (typeof window !== 'undefined') {
        localStorage.removeItem('activeShopId')
      }
    }

    setLoading(false)
  }

  // Call after onboarding creates a new shop
  async function refreshShops() {
    const {
      data: { session },
    } = await supabase.auth.getSession()

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
    await supabase.auth.signOut()

    if (typeof window !== 'undefined') {
      localStorage.removeItem('activeShopId')
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
