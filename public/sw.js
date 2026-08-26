const VERSION = 'v2'
const SHELL_CACHE = `gst-shell-${VERSION}`
const RUNTIME_CACHE = `gst-runtime-${VERSION}`
const PRECACHE_URLS = ['/offline', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      await cache.addAll(PRECACHE_URLS)
      self.skipWaiting()
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

async function saveResponse(request, response) {
  if (!response || response.status !== 200) return response
  const cache = await caches.open(RUNTIME_CACHE)
  await cache.put(request, response.clone())
  return response
}

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request)
    return await saveResponse(request, response)
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl)
      if (fallback) return fallback
    }
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
  if (request.url.endsWith('/sw.js')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/offline'))
    return
  }

  if (request.url.includes('/api/')) {
    event.respondWith(networkFirst(request))
    return
  }

  if (request.url.includes('/_next/')) {
    event.respondWith(networkFirst(request))
    return
  }

  event.respondWith(cacheFirst(request))
})
