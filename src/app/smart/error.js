'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

export default function SmartCardError({ error, reset }) {
  useEffect(() => {
    console.error('Smart card page error:', error)
  }, [error])

  return (
    <ErrorState
      compact
      code="500"
      title="Card planner hit a snag"
      message="Your card, spends and payments are safe. Nothing has been changed."
      primaryLabel="Back to planner"
      primaryHref="/smart"
      onReset={reset}
    />
  )
}
