/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV !== 'production'

// Supabase is the only origin the browser talks to directly (REST, auth,
// storage over https and realtime over wss). Deriving it from the public env
// var keeps the policy correct across local/staging/production projects.
function supabaseOrigins() {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return []
  try {
    const { origin, host } = new URL(raw)
    return [origin, `wss://${host}`]
  } catch {
    return []
  }
}

// The Supabase session lives in localStorage, so any script that runs on this
// origin can read it. A CSP is what stops an injected or third-party script
// from being loaded and shipping that token off-site.
function contentSecurityPolicy() {
  const connect = ["'self'", ...supabaseOrigins()]
  if (isDev) connect.push('ws://localhost:*', 'http://localhost:*')

  return [
    "default-src 'self'",
    // Next.js injects inline bootstrap/flight scripts; dev adds eval for HMR.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    // Generated PDFs and CSVs are opened as blob: documents.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Shop and customer ids appear in URLs — never leak them to external sites.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

const nextConfig = {
  poweredByHeader: false,
  async headers() {
    const headers = [{ source: '/:path*', headers: securityHeaders }]

    if (!isDev) {
      headers[0].headers.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      })
    }

    // robots.txt is only advisory. This header is the enforceable signal that
    // keeps the private back-office out of search and AI indexes. The public
    // storefront under /store/:slug is deliberately excluded.
    headers.push({
      source: '/:path((?!store(?:/.*)?$).*)',
      headers: [
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
      ],
    })

    return headers
  },
}

export default nextConfig
