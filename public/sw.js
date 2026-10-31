const VERSION = 'v4'
const SHELL_CACHE = `gst-shell-${VERSION}`
const RUNTIME_CACHE = `gst-runtime-${VERSION}`

const OFFLINE_URL = '/offline'
const PRECACHE_URLS = [OFFLINE_URL, '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.svg']

// Static routes warmed at install time so they can be opened while offline.
// Dynamic routes (/billing/[id], /inventory/[id], ...) are cached as they are visited.
const SHELL_ROUTES = [
  '/',
  '/banking',
  '/billing',
  '/billing/invoice-number-updater',
  '/categories',
  '/credits',
  '/customers',
  '/drawings',
  '/expenses',
  '/extracts',
  '/files',
  '/inventory',
  '/inventory/bulk-rates',
  '/inventory/quick-add',
  '/investments',
  '/login',
  '/onboarding',
  '/online',
  '/price-check',
  '/purchases',
  '/purchases/new',
  '/purchases/number-updater',
  '/quotation',
  '/reports',
  '/reports/invoice-pack',
  '/reports/stock-pack',
  '/settings',
  '/smart',
  '/superadmin',
  '/suppliers',
  '/summary',
]

const BUILD_ASSET_PATTERN = /\/_next\/static\/[^"'\\\s)>]+/g

async function warmCache(cache, urls) {
  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, { credentials: 'same-origin' })
        // A redirected response cannot be replayed for a navigation request.
        if (response.ok && !response.redirected) await cache.put(url, response)
      } catch (error) {
        // One unreachable route must not abort the whole install.
      }
    }),
  )
}

// Caching route HTML is not enough: each route also needs its JS/CSS chunks,
// otherwise an offline page load stalls on the loading placeholder.
async function warmRoutes(cache, urls) {
  const assets = new Set()

  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, { credentials: 'same-origin' })
        if (!response.ok || response.redirected) return

        const html = await response.clone().text()
        const matches = html.match(BUILD_ASSET_PATTERN) || []
        matches.forEach((asset) => assets.add(asset))

        await cache.put(url, response)
      } catch (error) {
        // One unreachable route must not abort the whole install.
      }
    }),
  )

  await warmCache(cache, Array.from(assets))
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE)
  await warmCache(cache, PRECACHE_URLS)
  await warmRoutes(cache, SHELL_ROUTES)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell()
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

// The browser can evict caches under storage pressure without the worker being
// reinstalled, which would silently break offline use. The page pings us while
// online so an emptied shell cache can be rebuilt.
self.addEventListener('message', (event) => {
  if (event.data !== 'ensure-shell-cache') return

  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      const cached = await cache.keys()
      if (cached.length === 0) await precacheShell()
    })(),
  )
})

async function saveResponse(request, response) {
  if (!response || !response.ok || response.redirected) return response
  const cache = await caches.open(RUNTIME_CACHE)
  await cache.put(request, response.clone())
  return response
}

function isRscRequest(url, request) {
  return url.searchParams.has('_rsc') || request.headers.get('RSC') === '1'
}

// The `_rsc` value changes between builds, so cache RSC payloads under a stable key.
function rscCacheKey(url) {
  const key = new URL(url.href)
  key.searchParams.delete('_rsc')
  key.hash = ''
  key.searchParams.set('__rsc', '1')
  return key.href
}

async function rscStrategy(request, url) {
  const key = rscCacheKey(url)
  try {
    const response = await fetch(request)
    if (response.ok && !response.redirected) {
      const cache = await caches.open(RUNTIME_CACHE)
      await cache.put(key, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(key)
    if (cached) return cached
    // Signalling a failure makes Next.js fall back to a full page navigation,
    // which the shell cache can serve from disk.
    return new Response('', { status: 503, statusText: 'Offline' })
  }
}

async function navigationStrategy(request, url) {
  try {
    const response = await fetch(request)
    if (response.ok && !response.redirected) {
      const cache = await caches.open(RUNTIME_CACHE)
      await cache.put(url.pathname, response.clone())
    }
    return response
  } catch (error) {
    const cached =
      (await caches.match(url.pathname)) ||
      (await caches.match(request, { ignoreSearch: true }))
    if (cached) return cached
    const offline = await caches.match(OFFLINE_URL)
    if (offline) return offline
    return Response.error()
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    return await saveResponse(request, response)
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  return await saveResponse(request, response)
}

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return
  if (!request.url.startsWith(self.location.origin)) return

  const url = new URL(request.url)

  if (url.pathname === '/sw.js') return

  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request, url))
    return
  }

  if (isRscRequest(url, request)) {
    event.respondWith(rscStrategy(request, url))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request))
    return
  }

  // Build output under /_next/static is content-hashed, so it is safe to serve from cache.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request))
    return
  }

  if (url.pathname.startsWith('/_next/')) {
    event.respondWith(networkFirst(request))
    return
  }

  event.respondWith(cacheFirst(request))
})
