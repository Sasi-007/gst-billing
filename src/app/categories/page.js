'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'

export default function CategoriesPage() {
  const { shop } = useShop()
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editingName, setEditingName] = useState('')
  const [busyId, setBusyId] = useState('')
  usePageLoadingState('categories-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setCategories([])
      setLoading(false)
      return
    }

    setLoading(true)
    const { data, error: loadErr } = await supabase
      .from('categories')
      .select('id,name,shop_id')
      .eq('shop_id', shop.id)
      .order('name')

    if (loadErr) {
      setError(loadErr.message || 'Failed to load categories')
      setCategories([])
      setLoading(false)
      return
    }

    setCategories(data || [])
    setError('')
    setLoading(false)
  }, [shop?.id])

  useEffect(() => { load() }, [load])

  const categoryCount = useMemo(() => categories.length, [categories])

  async function addCategory() {
    const name = newName.trim()
    if (!name || !shop?.id) return
    setSaving(true)
    setError('')
    const { error: insertErr } = await supabase.from('categories').insert({ name, shop_id: shop.id })
    setSaving(false)
    if (insertErr) {
      setError(insertErr.message || 'Failed to add category')
      return
    }
    setNewName('')
    load()
  }

  function startEdit(category) {
    setEditingId(category.id)
    setEditingName(category.name || '')
  }

  async function saveEdit(category) {
    const name = editingName.trim()
    if (!name || !shop?.id) return
    setBusyId(category.id)
    setError('')
    const { error: updateErr } = await supabase
      .from('categories')
      .update({ name })
      .eq('id', category.id)
      .eq('shop_id', shop.id)
    setBusyId('')
    if (updateErr) {
      setError(updateErr.message || 'Failed to update category')
      return
    }
    setEditingId('')
    setEditingName('')
    load()
  }

  async function deleteCategory(category) {
    if (!shop?.id) return
    setError('')

    const { count, error: usageErr } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shop.id)
      .eq('category_id', category.id)

    if (usageErr) {
      setError(usageErr.message || 'Failed to check category usage')
      return
    }
    if ((count || 0) > 0) {
      setError(`Move ${count} product(s) off "${category.name}" before deleting it.`)
      return
    }

    setBusyId(category.id)
    const { error: deleteErr } = await supabase
      .from('categories')
      .delete()
      .eq('id', category.id)
      .eq('shop_id', shop.id)
    setBusyId('')

    if (deleteErr) {
      setError(deleteErr.message || 'Failed to delete category')
      return
    }

    load()
  }

  return (
    <div className="p-4 max-w-3xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-sm text-gray-500">
            <Link href="/inventory" className="hover:underline">← Back to Inventory</Link>
          </div>
          <h1 className="text-xl font-bold">Categories</h1>
        </div>
        <div className="text-sm text-gray-500">{categoryCount} total</div>
      </div>

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="bg-white rounded-xl border p-4 mb-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addCategory())}
            placeholder="New category name"
            className="flex-1 border rounded-lg px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={addCategory}
            disabled={saving || !newName.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add Category'}
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingPlaceholder label="Loading categories" rows={5} fullPage />
      ) : categories.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center text-gray-400">No categories yet</div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="divide-y">
            {categories.map((category) => (
              <div key={category.id} className="p-3 flex items-center gap-2">
                {editingId === category.id ? (
                  <>
                    <input
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      className="flex-1 border rounded-lg px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => saveEdit(category)}
                      disabled={busyId === category.id || !editingName.trim()}
                      className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
                    >
                      {busyId === category.id ? '…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingId(''); setEditingName('') }}
                      className="px-3 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">{category.name}</div>
                      <div className="text-xs text-gray-400">ID: {category.id}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(category)}
                      className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteCategory(category)}
                      disabled={busyId === category.id}
                      className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm hover:bg-red-100 disabled:opacity-50"
                    >
                      {busyId === category.id ? '…' : 'Delete'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
