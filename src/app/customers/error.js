'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

export default function CustomersError({ error, reset }) {
  useEffect(() => {
    console.error('Customers page error:', error)
  }, [error])

  return (
    <ErrorState
      compact
      code="500"
      title="Customers page hit a snag"
      message="Our team has been notified. Your customer records are safe."
      primaryLabel="View Customers"
      primaryHref="/customers"
      onReset={reset}
    />
  )
}
