const STORAGE_KEY = 'pageVisitStats:v1'
const MAX_TRACKED_PAGES = 40
const DEFAULT_LIMIT = 7

// Longest-prefix match wins, so /purchases/new resolves before /purchases.
export const PAGE_CATALOG = [
  { href: '/billing',                       icon: '🧾', label: 'New Bill',         cls: 'bg-blue-600 text-white' },
  { href: '/billing?view=history',          icon: '🗂️', label: 'Invoice History',  cls: 'bg-blue-500 text-white' },
  { href: '/billing/invoice-number-updater', icon: '🔢', label: 'Invoice Numbers', cls: 'bg-slate-600 text-white' },
  { href: '/quotation',                     icon: '📄', label: 'Quotation',        cls: 'bg-indigo-600 text-white' },
  { href: '/customers',                     icon: '👥', label: 'Customers',        cls: 'bg-pink-600 text-white' },
  { href: '/credits',                       icon: '📒', label: 'Credit Book',      cls: 'bg-cyan-600 text-white' },
  { href: '/inventory/new',                 icon: '📦', label: 'Add Product',      cls: 'bg-green-600 text-white' },
  { href: '/inventory',                     icon: '📋', label: 'View Inventory',   cls: 'bg-teal-600 text-white' },
  { href: '/price-check',                   icon: '💰', label: 'Price Check',      cls: 'bg-amber-600 text-white' },
  { href: '/online',                        icon: '🌐', label: 'Online Store',     cls: 'bg-sky-600 text-white' },
  { href: '/categories',                    icon: '🏷️', label: 'Categories',       cls: 'bg-lime-700 text-white' },
  { href: '/purchases/new',                 icon: '🛒', label: 'New Purchase',     cls: 'bg-purple-600 text-white' },
  { href: '/purchases',                     icon: '📥', label: 'Purchases',        cls: 'bg-purple-500 text-white' },
  { href: '/suppliers',                     icon: '🏪', label: 'Suppliers',        cls: 'bg-gray-700 text-white' },
  { href: '/expenses',                      icon: '💸', label: 'Expenses',         cls: 'bg-rose-600 text-white' },
  { href: '/investments',                   icon: '🏦', label: 'Investments',      cls: 'bg-emerald-700 text-white' },
  { href: '/drawings',                      icon: '↗️', label: 'Drawings',         cls: 'bg-orange-700 text-white' },
  { href: '/banking',                       icon: '🏛️', label: 'Banking',          cls: 'bg-blue-800 text-white' },
  { href: '/summary',                       icon: '🧮', label: 'Summary',          cls: 'bg-stone-600 text-white' },
  { href: '/reports/invoice-pack',          icon: '🗃️', label: 'Invoice Pack',     cls: 'bg-orange-500 text-white' },
  { href: '/reports',                       icon: '📈', label: 'Reports',          cls: 'bg-orange-600 text-white' },
  { href: '/settings',                      icon: '⚙️', label: 'Settings',         cls: 'bg-gray-600 text-white' },
  { href: '/superadmin',                    icon: '🛡️', label: 'Admin',            cls: 'bg-red-700 text-white' },
]

// Shown until the user has built up enough of their own history.
export const DEFAULT_QUICK_ACTIONS = [
  '/billing',
  '/purchases/new',
  '/inventory/new',
  '/credits',
  '/suppliers',
  '/reports',
  '/inventory',
]

const CATALOG_BY_HREF = PAGE_CATALOG.reduce((map, page) => {
  map[page.href] = page
  return map
}, {})

const MATCHERS = [...PAGE_CATALOG].sort((a, b) => b.href.length - a.href.length)

export function resolvePageHref(pathname, search = '') {
  if (!pathname) return null

  const view = new URLSearchParams(search || '').get('view')
  if (pathname === '/billing') {
    return view === 'history' ? '/billing?view=history' : '/billing'
  }

  const match = MATCHERS.find(page => {
    const base = page.href.split('?')[0]
    return pathname === base || pathname.startsWith(base + '/')
  })
  return match ? match.href : null
}

export function getPageMeta(href) {
  return CATALOG_BY_HREF[href] || null
}

function readStats() {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.warn('Failed to read page visit stats:', error)
    return {}
  }
}

function writeStats(stats) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats))
  } catch (error) {
    console.warn('Failed to write page visit stats:', error)
  }
}

export function recordPageVisit(pathname, search = '') {
  const href = resolvePageHref(pathname, search)
  if (!href) return

  const stats = readStats()
  const existing = stats[href] || { count: 0, last: 0 }
  stats[href] = { count: existing.count + 1, last: Date.now() }

  const entries = Object.entries(stats)
  if (entries.length > MAX_TRACKED_PAGES) {
    entries.sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
    writeStats(Object.fromEntries(entries.slice(0, MAX_TRACKED_PAGES)))
    return
  }

  writeStats(stats)
}

export function getFrequentPages(limit = DEFAULT_LIMIT) {
  const stats = readStats()

  const ranked = Object.entries(stats)
    .filter(([href]) => CATALOG_BY_HREF[href])
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0) || (b[1].last || 0) - (a[1].last || 0))
    .map(([href, stat]) => ({ ...CATALOG_BY_HREF[href], count: stat.count || 0 }))

  const pages = ranked.slice(0, limit)

  // Top up with defaults so the panel is never sparse.
  for (const href of DEFAULT_QUICK_ACTIONS) {
    if (pages.length >= limit) break
    if (pages.some(page => page.href === href)) continue
    if (CATALOG_BY_HREF[href]) pages.push({ ...CATALOG_BY_HREF[href], count: 0 })
  }

  return pages
}

export function clearPageVisits() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.warn('Failed to clear page visit stats:', error)
  }
}
