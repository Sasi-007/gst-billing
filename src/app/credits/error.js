'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

export default function CreditsError({ error, reset }) {
  useEffect(() => {
    console.error('Credits page error:', error)
  }, [error])

  return (
    <ErrorState
      compact
      code="500"
      title="Credit Book hit a snag"
      message="Our team has been notified. Your existing credit entries are safe."
      primaryLabel="View Credit Book"
      primaryHref="/credits"
      onReset={reset}
    />
  )
}
