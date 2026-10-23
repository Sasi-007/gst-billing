import ErrorState from '@/components/ErrorState'

// Next.js renders this automatically for any unmatched route, and whenever
// a page explicitly calls notFound(). Distinct from error.js — this is a
// missing-page (404) case, not an app crash (500).
export const metadata = {
  title: '404 - Page Not Found | GST Billing',
}

export default function NotFound() {
  return (
    <ErrorState
      variant="notFound"
      code="404"
      showPath
      title="Looks like you've been misdirected"
      message="This page doesn't exist in GST Billing. You may have mistyped the address or followed an old link — your data is completely unaffected."
      primaryLabel="Take Me Back to Dashboard"
      primaryHref="/"
    />
  )
}
