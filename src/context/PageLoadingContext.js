'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const PageLoadingContext = createContext(null)

export function PageLoadingProvider({ children }) {
  const [loadingMap, setLoadingMap] = useState({})

  const setPageLoading = useCallback((key, isLoading) => {
    if (!key) return

    setLoadingMap((current) => {
      const alreadyLoading = !!current[key]
      if (isLoading && alreadyLoading) return current
      if (!isLoading && !alreadyLoading) return current

      const next = { ...current }
      if (isLoading) next[key] = true
      else delete next[key]
      return next
    })
  }, [])

  const value = useMemo(() => ({
    isPageLoading: Object.keys(loadingMap).length > 0,
    setPageLoading,
  }), [loadingMap, setPageLoading])

  return (
    <PageLoadingContext.Provider value={value}>
      {children}
    </PageLoadingContext.Provider>
  )
}

export function usePageLoadingState(key, isLoading) {
  const setPageLoading = useContext(PageLoadingContext)?.setPageLoading

  useEffect(() => {
    if (!setPageLoading || !key) return
    setPageLoading(key, isLoading)
    return () => setPageLoading(key, false)
  }, [isLoading, key, setPageLoading])
}

export function usePageLoading() {
  const context = useContext(PageLoadingContext)
  if (!context) {
    throw new Error('usePageLoading must be used inside PageLoadingProvider')
  }
  return context
}
