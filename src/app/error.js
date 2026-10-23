'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

// Root-level crash boundary — catches errors from the dashboard (app/page.js)
// and any nested route that doesn't have its own error.js. The sidebar/shell
// in layout.js stays mounted; only this content area is replaced.
export default function RootError({ error, reset }) {
  useEffect(() => {
    console.error('App error boundary:', error)
  }, [error])

  return (
    <ErrorState
      code="500"
      title="Something went wrong"
      message="Our team has been notified and is already on it. Your bills, customers, and other data are safe — you can keep working from the dashboard."
      primaryLabel="Go to Dashboard"
      primaryHref="/"
      onReset={reset}
    />
  )
}
