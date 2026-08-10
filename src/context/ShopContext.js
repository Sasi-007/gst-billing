'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '../lib/supabase'

const ShopContext = createContext(null)

const PUBLIC_PATHS = ['/login', '/onboarding']

export function ShopProvider({ children }) {
  const [shop,     setShop]     = useState(null)
  const [user,     setUser]     = useState(null)
  const [allShops, setAllShops] = useState([])
  const [loading,  setLoading]  = useState(true)
  const router   = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    loadSession()

    // Listen for auth state changes (login / logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user)
        loadShops(session.user.id)
      } else {
        setUser(null)
        setShop(null)
        setAllShops([])
        setLoading(false)
      }
    })
    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redirect based on auth state
  useEffect(() => {
    if (loading) return
    const isPublic = PUBLIC_PATHS.some(p => pathname.startsWith(p))

    if (!user && !isPublic) {
      router.replace('/login')
      return
    }
    if (user && !shop && !pathname.startsWith('/onboarding') && !isPublic) {
      router.replace('/onboarding')
      return
    }
    if (user && shop && isPublic) {
      router.replace('/')
    }
  }, [loading, user, shop, pathname, router])

  async function loadSession() {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) {
      setUser(session.user)
      await loadShops(session.user.id)
    } else {
      setLoading(false)
    }
  }

  async function loadShops(userId) {
    const { data } = await supabase
      .from('user_shops')
      .select('role, shops(*)')
      .eq('user_id', userId)

    const shops = (data || []).map(r => ({ ...r.shops, role: r.role }))
    setAllShops(shops)

    if (shops.length > 0) {
      // Restore last active shop from localStorage
      const lastId = typeof window !== 'undefined' && localStorage.getItem('activeShopId')
      const active = shops.find(s => s.id === lastId) || shops[0]
      setShop(active)
    }
    setLoading(false)
  }

  function switchShop(shopId) {
    const target = allShops.find(s => s.id === shopId)
    if (target) {
      setShop(target)
      if (typeof window !== 'undefined') localStorage.setItem('activeShopId', shopId)
    }
  }

  async function signOut() {
    await supabase.auth.signOut()
    if (typeof window !== 'undefined') localStorage.removeItem('activeShopId')
    router.replace('/login')
  }

  return (
    <ShopContext.Provider value={{ shop, user, allShops, loading, setShop, switchShop, signOut }}>
      {children}
    </ShopContext.Provider>
  )
}

export function useShop() {
  const ctx = useContext(ShopContext)
  if (!ctx) throw new Error('useShop must be used inside ShopProvider')
  return ctx
}
