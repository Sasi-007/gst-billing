'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

export default function PurchasesError({ error, reset }) {
  useEffect(() => {
    console.error('Purchases page error:', error)
  }, [error])

  return (
    <ErrorState
      compact
      code="500"
      title="Purchases page hit a snag"
      message="Our team has been notified. If you were recording a purchase, check the list below — it may have already been saved."
      primaryLabel="View Purchases"
      primaryHref="/purchases"
      onReset={reset}
    />
  )
}
