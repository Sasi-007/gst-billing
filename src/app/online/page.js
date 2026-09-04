'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useShop } from '@/context/ShopContext'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { supabase } from '@/lib/supabase'
import { loadOnlineStoreSummary } from '@/lib/onlineStore'

export default function OnlineStoreAdminPage() {
  const { shop, loading: shopLoading } = useShop()
  const [settings, setSettings] = useState(null)
  const [products, setProducts] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const storeUrl = useMemo(() => {
    if (!settings?.store_slug) return ''
    return `/store/${settings.store_slug}`
  }, [settings?.store_slug])

  useEffect(() => {
    if (!shop?.id) return

    async function load() {
      setLoading(true)
      setError('')
      try {
        const summary = await loadOnlineStoreSummary(shop.id)
        setSettings(summary.settings)
        setProducts(summary.products)
        setOrders(summary.orders)
      } catch (err) {
        setError(err?.message || 'Failed to load online store module. Run the online store migration first.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [shop?.id])

  async function createDefaultSettings() {
    if (!shop?.id) return

    setSaving(true)
    setError('')

    const slugBase = (shop.slug || shop.name || 'store')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')

    const payload = {
      shop_id: shop.id,
      store_name: shop.name,
      store_slug: slugBase || shop.id,
      headline: 'Order groceries online from your nearby store',
      is_online: false,
    }

    const { data, error: saveError } = await supabase
      .from('online_store_settings')
      .insert(payload)
      .select('*')
      .single()

    if (saveError) {
      setError(saveError.message)
    } else {
      setSettings(data)
    }

    setSaving(false)
  }

  async function toggleStoreOnline() {
    if (!settings?.shop_id) return
    setSaving(true)
    setError('')

    const nextOnline = !settings.is_online
    const { data, error: updateError } = await supabase
      .from('online_store_settings')
      .update({ is_online: nextOnline, updated_at: new Date().toISOString() })
      .eq('shop_id', settings.shop_id)
      .select('*')
      .single()

    if (updateError) {
      setError(updateError.message)
    } else {
      setSettings(data)
    }

    setSaving(false)
  }

  async function toggleProductOnline(product) {
    setError('')
    const nextValue = !product.sell_online
    setProducts((current) =>
      current.map((item) => item.id === product.id ? { ...item, sell_online: nextValue } : item)
    )

    const { error: updateError } = await supabase
      .from('products')
      .update({ sell_online: nextValue, updated_at: new Date().toISOString() })
      .eq('id', product.id)
      .eq('shop_id', shop.id)

    if (updateError) {
      setError(updateError.message)
      setProducts((current) =>
        current.map((item) => item.id === product.id ? { ...item, sell_online: product.sell_online } : item)
      )
    }
  }

  async function convertOrderToBill(orderId) {
    setSaving(true)
    setError('')

    const { error: convertError } = await supabase.rpc('convert_online_order_to_bill', {
      p_online_order_id: orderId,
    })

    if (convertError) {
      setError(convertError.message)
    } else if (shop?.id) {
      const summary = await loadOnlineStoreSummary(shop.id)
      setOrders(summary.orders)
    }

    setSaving(false)
  }

  if (shopLoading || loading) {
    return (
      <div className="p-4">
        <LoadingPlaceholder label="Loading online store" rows={4} fullPage />
      </div>
    )
  }

  if (!shop?.ecommerce_enabled) {
    return (
      <div className="p-4 max-w-3xl mx-auto">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h1 className="text-lg font-bold text-amber-900">Online Store is not enabled</h1>
          <p className="mt-2 text-sm text-amber-800">
            This shop is currently billing-only. Ask the superadmin to enable the Online module for this shop.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Online Store</h1>
          <p className="text-sm text-gray-500">Optional ecommerce layer on top of GST billing inventory.</p>
        </div>
        {storeUrl && (
          <Link href={storeUrl} className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Open storefront
          </Link>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {!settings ? (
        <div className="rounded-xl border bg-white p-5">
          <h2 className="font-semibold text-gray-900">Enable ecommerce for this shop</h2>
          <p className="mt-2 text-sm text-gray-600">
            Billing-only shops do not need this. Enable it only when the shop wants an online presence.
          </p>
          <button
            type="button"
            onClick={createDefaultSettings}
            disabled={saving}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? 'Creating...' : 'Create online store settings'}
          </button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <section className="rounded-xl border bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900">{settings.store_name || shop?.name}</h2>
                <p className="mt-1 text-sm text-gray-500">Slug: {settings.store_slug}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${settings.is_online ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                {settings.is_online ? 'Online' : 'Offline'}
              </span>
            </div>
            <p className="mt-4 text-sm text-gray-600">
              Keep offline while adding products. Customers can view the store only after you publish it.
            </p>
            <button
              type="button"
              onClick={toggleStoreOnline}
              disabled={saving}
              className="mt-4 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {settings.is_online ? 'Take store offline' : 'Publish store'}
            </button>
          </section>

          <section className="rounded-xl border bg-white p-5">
            <h2 className="font-semibold text-gray-900">Recent online orders</h2>
            <div className="mt-3 divide-y">
              {orders.length === 0 ? (
                <p className="py-3 text-sm text-gray-500">No online orders yet.</p>
              ) : orders.map((order) => (
                <div key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium">{order.order_no}</p>
                    <p className="text-xs text-gray-500">{new Date(order.created_at).toLocaleString('en-IN')}</p>
                  </div>
                  <span className="font-medium">{order.status}</span>
                  <span>₹{Number(order.total || 0).toFixed(2)}</span>
                  <button
                    type="button"
                    onClick={() => convertOrderToBill(order.id)}
                    disabled={saving || Boolean(order.converted_bill_id)}
                    className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    {order.converted_bill_id ? 'Billed' : 'Convert to bill'}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border bg-white p-5 lg:col-span-2">
            <h2 className="font-semibold text-gray-900">Choose products for online sale</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {products.map((product) => (
                <label key={product.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div>
                    <p className="font-medium text-gray-900">{product.online_name || product.name}</p>
                    {product.local_name && <p className="text-xs text-gray-500">{product.local_name}</p>}
                    <p className="text-sm text-gray-500">₹{Number(product.selling_price || 0).toFixed(2)} • Stock {product.stock_qty}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={Boolean(product.sell_online)}
                    onChange={() => toggleProductOnline(product)}
                    className="h-5 w-5"
                  />
                </label>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
