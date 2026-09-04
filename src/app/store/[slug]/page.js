'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { loadPublicStore } from '@/lib/onlineStore'

export default function PublicStorePage({ params }) {
  const [settings, setSettings] = useState(null)
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await loadPublicStore(params.slug)
        setSettings(data.settings)
        setProducts(data.products)
      } catch (err) {
        setError(err?.message || 'Unable to load store')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [params.slug])

  if (loading) {
    return <div className="min-h-screen bg-gray-50 p-6 text-sm text-gray-600">Loading store...</div>
  }

  if (error) {
    return <div className="min-h-screen bg-gray-50 p-6 text-sm text-red-700">{error}</div>
  }

  if (!settings) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-xl rounded-xl border bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-gray-900">Store not available</h1>
          <p className="mt-2 text-sm text-gray-500">The shop may be offline or the link is incorrect.</p>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <section className="mx-auto max-w-6xl px-4 py-6">
        <div className="rounded-2xl bg-gray-900 p-6 text-white">
          <p className="text-sm uppercase tracking-widest text-blue-200">Online grocery store</p>
          <h1 className="mt-2 text-3xl font-bold">{settings.store_name || settings.shops?.name}</h1>
          <p className="mt-2 max-w-2xl text-gray-300">{settings.headline || 'Order groceries from your local shop.'}</p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm text-gray-200">
            {settings.accepts_cod && <span className="rounded-full bg-white/10 px-3 py-1">COD available</span>}
            {settings.accepts_upi && <span className="rounded-full bg-white/10 px-3 py-1">UPI available</span>}
            {settings.delivery_fee > 0 && <span className="rounded-full bg-white/10 px-3 py-1">Delivery ₹{settings.delivery_fee}</span>}
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <article key={product.id} className="rounded-xl border bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-gray-500">{product.categories?.name || 'Grocery'} • {product.unit}</p>
                  <h2 className="mt-1 font-semibold text-gray-900">{product.online_name || product.name}</h2>
                  {product.local_name && <p className="mt-0.5 text-sm text-gray-500">{product.local_name}</p>}
                </div>
                <span className="rounded-full bg-green-50 px-3 py-1 text-sm font-semibold text-green-700">
                  ₹{Number(product.selling_price || 0).toFixed(2)}
                </span>
              </div>
              {product.online_description && (
                <p className="mt-3 text-sm text-gray-500">{product.online_description}</p>
              )}
              <button
                type="button"
                disabled={Number(product.stock_qty || 0) <= 0}
                className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-gray-300"
              >
                {Number(product.stock_qty || 0) <= 0 ? 'Out of stock' : 'Add to cart'}
              </button>
            </article>
          ))}
        </div>

        {products.length === 0 && (
          <div className="mt-6 rounded-xl border bg-white p-6 text-center text-sm text-gray-500">
            No products are published online yet.
          </div>
        )}

        <div className="mt-8 text-center text-xs text-gray-400">
          <Link href="/">Powered by GST Billing</Link>
        </div>
      </section>
    </main>
  )
}
