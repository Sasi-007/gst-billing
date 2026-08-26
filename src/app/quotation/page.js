'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Quotation is billing page with type pre-selected; redirect with flag
export default function QuotationPage() {
  const router = useRouter()
  useEffect(() => {
    // Pass type via sessionStorage so billing page can pick it up
    sessionStorage.setItem('defaultBillType', 'quotation')
    router.replace('/billing')
  }, [router])
  return null
}
