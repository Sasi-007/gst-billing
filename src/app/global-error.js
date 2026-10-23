'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

// Last-resort boundary — only triggers if the root layout itself throws
// (e.g. ShopProvider init failure), so it must render its own html/body.
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('Global app error:', error)
  }, [error])

  return (
    <html lang="en">
      <body className="bg-gray-50 antialiased">
        <ErrorState
          code="500"
          title="App failed to load"
          message="Our team has been notified and is already on it. Please try again in a moment."
          primaryLabel="Reload App"
          primaryHref="/"
          onReset={reset}
        />
      </body>
    </html>
  )
}
