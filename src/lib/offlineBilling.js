const DB_NAME = 'gst-billing-offline'
const DB_VERSION = 1
const DRAFTS_STORE = 'billing_drafts'
const PRODUCTS_STORE = 'product_snapshots'
const QUEUE_STORE = 'bill_queue'

function openDB() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.reject(new Error('IndexedDB is not available'))
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) db.createObjectStore(DRAFTS_STORE, { keyPath: 'shopId' })
      if (!db.objectStoreNames.contains(PRODUCTS_STORE)) db.createObjectStore(PRODUCTS_STORE, { keyPath: 'shopId' })
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Failed to open offline database'))
  })
}

async function withStore(storeName, mode, handler) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const result = handler(store)

    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error || new Error('Offline database transaction failed'))
    tx.onabort = () => reject(tx.error || new Error('Offline database transaction aborted'))
  })
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function notifyQueueChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('offline-queue-changed'))
}

export async function saveBillingDraft(shopId, draft) {
  if (!shopId) return
  await withStore(DRAFTS_STORE, 'readwrite', (store) => {
    store.put({
      shopId,
      ...clone(draft),
      savedAt: Date.now(),
    })
  })
}

export async function loadBillingDraft(shopId) {
  if (!shopId) return null
  const result = await withStore(DRAFTS_STORE, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(shopId)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error || new Error('Failed to load billing draft'))
  }))
  return result
}

export async function clearBillingDraft(shopId) {
  if (!shopId) return
  await withStore(DRAFTS_STORE, 'readwrite', (store) => store.delete(shopId))
}

export async function saveProductSnapshot(shopId, products) {
  if (!shopId) return
  await withStore(PRODUCTS_STORE, 'readwrite', (store) => {
    store.put({
      shopId,
      products: clone(products || []),
      savedAt: Date.now(),
    })
  })
}

export async function loadProductSnapshot(shopId) {
  if (!shopId) return []
  const result = await withStore(PRODUCTS_STORE, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(shopId)
    request.onsuccess = () => resolve(request.result?.products || [])
    request.onerror = () => reject(request.error || new Error('Failed to load product snapshot'))
  }))
  return result
}

export async function enqueuePendingBill(shopId, entry) {
  return enqueuePendingAction(shopId, { ...entry, type: 'bill' })
}

export async function enqueuePendingAction(shopId, entry) {
  if (!shopId) return null
  const id = entry?.id || `bill-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const record = {
    id,
    shopId,
    type: entry?.type || 'bill',
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...clone(entry),
  }
  await withStore(QUEUE_STORE, 'readwrite', (store) => store.put(record))
  notifyQueueChanged()
  return record
}

export async function listPendingBills(shopId) {
  return listPendingActions(shopId, 'bill')
}

export async function listPendingActions(shopId, type) {
  if (!shopId) return []
  return withStore(QUEUE_STORE, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(
      (request.result || []).filter((row) =>
        row.shopId === shopId &&
        row.status === 'pending' &&
        (!type || (row.type || 'bill') === type),
      ),
    )
    request.onerror = () => reject(request.error || new Error('Failed to list queued bills'))
  }))
}

export async function removePendingBill(id) {
  return removePendingAction(id)
}

export async function removePendingAction(id) {
  if (!id) return
  await withStore(QUEUE_STORE, 'readwrite', (store) => store.delete(id))
  notifyQueueChanged()
}

export async function updatePendingBill(id, updates) {
  return updatePendingAction(id, updates)
}

export async function updatePendingAction(id, updates) {
  if (!id) return
  await withStore(QUEUE_STORE, 'readwrite', (store) => new Promise((resolve, reject) => {
    const getRequest = store.get(id)
    getRequest.onsuccess = () => {
      const current = getRequest.result
      if (!current) {
        resolve(null)
        return
      }
      const next = { ...current, ...clone(updates), updatedAt: Date.now() }
      const putRequest = store.put(next)
      putRequest.onsuccess = () => {
        notifyQueueChanged()
        resolve(next)
      }
      putRequest.onerror = () => reject(putRequest.error || new Error('Failed to update queued bill'))
    }
    getRequest.onerror = () => reject(getRequest.error || new Error('Failed to update queued bill'))
  }))
}

export async function applyLocalStockDelta(shopId, lineItems) {
  if (!shopId) return
  const products = await loadProductSnapshot(shopId)
  if (products.length === 0) return

  const qtyMap = (lineItems || []).reduce((map, item) => {
    if (!item?.product_id) return map
    map[item.product_id] = (map[item.product_id] || 0) + (Number(item.quantity || 0) || 0)
    return map
  }, {})

  const nextProducts = products.map((product) => {
    const delta = qtyMap[product.id]
    if (!delta) return product
    return {
      ...product,
      stock_qty: Number(product.stock_qty || 0) - Number(delta || 0),
    }
  })

  await saveProductSnapshot(shopId, nextProducts)
}

export async function applyLocalStockDeltaMap(shopId, deltaMap) {
  if (!shopId) return
  const products = await loadProductSnapshot(shopId)
  if (products.length === 0) return

  const nextProducts = products.map((product) => {
    const delta = deltaMap?.[product.id]
    if (!delta) return product
    return {
      ...product,
      stock_qty: Number(product.stock_qty || 0) + Number(delta || 0),
    }
  })

  await saveProductSnapshot(shopId, nextProducts)
}

export function makeTempBillNo(prefix = 'OFF') {
  return `${prefix}-${Date.now()}`
}
