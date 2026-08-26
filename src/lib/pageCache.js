const DEFAULT_MAX_AGE_MS = 60 * 1000

export function readPageCache(key, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!key || typeof window === 'undefined') return null

  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (!parsed?.savedAt || !('data' in parsed)) return null
    if (Date.now() - parsed.savedAt > maxAgeMs) return null

    return parsed.data
  } catch (error) {
    console.warn('Failed to read page cache:', error)
    return null
  }
}

export function writePageCache(key, data) {
  if (!key || typeof window === 'undefined') return

  try {
    window.sessionStorage.setItem(key, JSON.stringify({
      savedAt: Date.now(),
      data,
    }))
  } catch (error) {
    console.warn('Failed to write page cache:', error)
  }
}
