'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

// Billing is the most "booking"-like flow here — if it crashes mid-save,
// the user's main concern is whether the bill already went through.
export default function BillingError({ error, reset }) {
  useEffect(() => {
    console.error('Billing page error:', error)
  }, [error])

  return (
    <ErrorState
      compact
      code="500"
      title="Billing page hit a snag"
      message="Our team has been notified. If you were creating a bill, check the history below — it may have already been saved."
      primaryLabel="View Invoice History"
      primaryHref="/billing?view=history"
      onReset={reset}
    />
  )
}
