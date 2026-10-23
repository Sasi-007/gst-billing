'use client'

import { useEffect } from 'react'
import ErrorState from '@/components/ErrorState'

export default function QuotationError({ error, reset }) {
  useEffect(() => {
    console.error('Quotation page error:', error)
  }, [error])

  return (
    <ErrorState
      compact
      code="500"
      title="Quotation page hit a snag"
      message="Our team has been notified. If you were creating a quotation, check the list below — it may have already been saved."
      primaryLabel="View Quotations"
      primaryHref="/quotation"
      onReset={reset}
    />
  )
}
