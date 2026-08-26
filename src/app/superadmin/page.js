'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useShop } from '@/context/ShopContext'

const SUPERADMIN_EMAILS = process.env.NEXT_PUBLIC_SUPERADMIN_EMAILS || ''

async function adminFetch(path, options = {}) {
  async function doFetch(token) {
    return fetch(path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })
  }

  const { data: { session } } = await supabase.auth.getSession()
  let token = session?.access_token
  if (!token) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
    if (refreshErr || !refreshed?.session?.access_token) {
      throw new Error('Not authenticated')
    }
    token = refreshed.session.access_token
  }

  let res = await doFetch(token)
  let json = await res.json()

  // Token may be expired; try one refresh + retry.
  if (!res.ok && String(json?.error || '').includes('Session expired')) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
    if (refreshErr || !refreshed?.session?.access_token) {
      throw new Error('Session expired. Please sign in again.')
    }
    token = refreshed.session.access_token
    res = await doFetch(token)
    json = await res.json()
  }

  if (!res.ok) throw new Error(json.error || 'Request failed')
  return json
}

export default function SuperadminPage() {
  const { user, loading: shopLoading } = useShop()
  const [tab,     setTab]     = useState('shops')
  const [shops,   setShops]   = useState([])
  const [users,   setUsers]   = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [authBlocked, setAuthBlocked] = useState(false)
  const [toast,   setToast]   = useState('')
  const [resettingShopId, setResettingShopId] = useState('')

  // New user form
  const [newEmail,    setNewEmail]    = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [creating,    setCreating]    = useState(false)

  const isSuperadmin = user && SUPERADMIN_EMAILS.split(',').map(e => e.trim()).includes(user.email)

  const loadData = useCallback(async () => {
    if (!isSuperadmin || authBlocked) return
    setLoading(true)
    setError('')
    try {
      if (tab === 'shops') {
        const data = await adminFetch('/api/admin?resource=shops')
        setShops(data.shops || [])
      } else {
        const data = await adminFetch('/api/admin?resource=users')
        setUsers(data.users || [])
      }
    } catch (err) {
      if (
        String(err.message || '').includes('Forbidden:') ||
        String(err.message || '').includes('TLS certificate issue')
      ) {
        setAuthBlocked(true)
      }
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [tab, isSuperadmin, authBlocked])

  useEffect(() => {
    if (!shopLoading) loadData()
  }, [loadData, shopLoading])

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  async function toggleShop(shopId, currentState) {
    try {
      await adminFetch('/api/admin', {
        method: 'POST',
        body: JSON.stringify({ action: 'toggle_shop', shop_id: shopId, is_active: !currentState }),
      })
      showToast(`Shop ${currentState ? 'disabled' : 'enabled'}`)
      loadData()
    } catch (err) { setError(err.message) }
  }

  async function createUser(e) {
    e.preventDefault()
    if (!newEmail || !newPassword) return
    setCreating(true)
    try {
      await adminFetch('/api/admin', {
        method: 'POST',
        body: JSON.stringify({ action: 'create_user', email: newEmail, password: newPassword }),
      })
      showToast(`User ${newEmail} created. They can now sign in and set up their shop.`)
      setNewEmail(''); setNewPassword('')
      loadData()
    } catch (err) { setError(err.message) }
    finally { setCreating(false) }
  }

  async function resetShopData(shop) {
    const typed = window.prompt(`Type RESET to clear all business data for "${shop.name}" and restart counters from 1 on next bill.`)
    if (typed !== 'RESET') {
      if (typed !== null) setError('Reset cancelled: you must type RESET exactly.')
      return
    }

    setError('')
    setResettingShopId(shop.id)
    try {
      await adminFetch('/api/admin', {
        method: 'POST',
        body: JSON.stringify({ action: 'reset_shop_data', shop_id: shop.id, confirmation: 'RESET' }),
      })
      showToast(`${shop.name} reset completed`)
      loadData()
    } catch (err) {
      setError(err.message)
    } finally {
      setResettingShopId('')
    }
  }

  // ── Access guard ─────────────────────────────────────────────────────────
  if (shopLoading) return (
    <div className="flex items-center justify-center h-full text-gray-400 py-16">Loading…</div>
  )

  if (!isSuperadmin) return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-sm">
        <div className="text-5xl mb-3">🔒</div>
        <h2 className="text-xl font-bold text-gray-800 mb-2">Access Denied</h2>
        <p className="text-sm text-gray-500 mb-4">
          Your account does not have superadmin privileges.
        </p>
        {!SUPERADMIN_EMAILS && (
          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
            Add <code>NEXT_PUBLIC_SUPERADMIN_EMAILS=your@email.com</code> to your{' '}
            <code>.env.local</code> to grant access.
          </p>
        )}
      </div>
    </div>
  )

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold">Superadmin Panel</h1>
          <p className="text-xs text-gray-500 mt-0.5">Logged in as <strong>{user.email}</strong></p>
        </div>
        <button onClick={() => { setAuthBlocked(false); loadData() }}
          className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
          ↻ Refresh
        </button>
      </div>

      {toast && (
        <div className="mb-3 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
          ✓ {toast}
        </div>
      )}
      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          ⚠ {error}
          {error.includes('Forbidden:') && (
            <p className="mt-1 text-xs">
              Try signing out and signing in again. If it persists, confirm this email is in{' '}
              <code>NEXT_PUBLIC_SUPERADMIN_EMAILS</code> and restart dev server.
            </p>
          )}
          {error.includes('Service role') && (
            <p className="mt-1 text-xs">
              Add <code>SUPABASE_SERVICE_ROLE_KEY</code> to your <code>.env.local</code>.
              Find it in Supabase → Settings → API → service_role key.
            </p>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {['shops','users','new-user'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
              tab === t ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
            }`}>
            {t === 'new-user' ? '+ Create User' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Shops tab ─────────────────────────────────────────────────────── */}
      {tab === 'shops' && (
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Total Shops',  value: shops.length },
              { label: 'Active',       value: shops.filter(s => s.is_active).length },
              { label: 'Inactive',     value: shops.filter(s => !s.is_active).length },
              { label: 'Total Bills',  value: shops.reduce((sum, s) => sum + (s.bill_counter || 0), 0) },
            ].map(c => (
              <div key={c.label} className="bg-white border rounded-xl p-3">
                <div className="text-xs text-gray-500">{c.label}</div>
                <div className="text-2xl font-bold mt-0.5">{c.value}</div>
              </div>
            ))}
          </div>

          {loading ? (
            <div className="text-center text-gray-400 py-8">Loading…</div>
          ) : (
            <div className="bg-white rounded-xl border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                    {['Shop Name','Owner','City','GSTIN','Bills','Plan','Status',''].map(h => (
                      <th key={h} className="px-3 py-2 text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shops.map(s => (
                    <tr key={s.id} className={`border-b hover:bg-gray-50 ${!s.is_active ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2 font-medium">{s.name}</td>
                      <td className="px-3 py-2 text-gray-500 text-xs">{s.owner_email || '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{s.city || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.gstin || '—'}</td>
                      <td className="px-3 py-2 text-center">{s.bill_counter || 0}</td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          s.plan === 'pro' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                        }`}>{s.plan}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          s.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                        }`}>{s.is_active ? 'Active' : 'Disabled'}</span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => toggleShop(s.id, s.is_active)}
                            className={`text-xs hover:underline ${s.is_active ? 'text-red-500' : 'text-green-600'}`}
                          >
                            {s.is_active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => resetShopData(s)}
                            disabled={resettingShopId === s.id}
                            className="text-xs text-red-700 hover:underline disabled:opacity-50"
                            title="Clear this company's data only and reset counters"
                          >
                            {resettingShopId === s.id ? 'Resetting…' : 'Reset FY Data'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3 py-2 text-xs text-gray-400">{shops.length} shops total</div>
            </div>
          )}
          <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Reset FY Data clears only the selected company data (sales, purchases, products, categories, suppliers, credits, finance, bank entries) and resets counters. It does not delete users or other companies.
          </div>
        </div>
      )}

      {/* ── Users tab ──────────────────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="bg-white rounded-xl border overflow-x-auto">
          {loading ? (
            <div className="text-center text-gray-400 py-8">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs text-gray-500 border-b">
                  {['Email','Joined','Shops & Role'].map(h => (
                    <th key={h} className="px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">{u.email}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs">
                      {new Date(u.created_at).toLocaleDateString('en-IN')}
                    </td>
                    <td className="px-3 py-2">
                      {u.shops.length === 0 ? (
                        <span className="text-xs text-gray-400 italic">No shop</span>
                      ) : u.shops.map((s, i) => (
                        <span key={i} className="inline-flex items-center gap-1 mr-2 text-xs">
                          <span className="font-medium">{s.shop}</span>
                          <span className="bg-gray-100 px-1 rounded">{s.role}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="px-3 py-2 text-xs text-gray-400">{users.length} users total</div>
        </div>
      )}

      {/* ── Create User tab ─────────────────────────────────────────────────── */}
      {tab === 'new-user' && (
        <div className="max-w-md">
          <div className="bg-white rounded-xl border p-5">
            <h2 className="font-semibold mb-1">Create New User Account</h2>
            <p className="text-xs text-gray-500 mb-4">
              Creates a Supabase auth account. The user can then sign in and complete their shop onboarding.
            </p>

            <form onSubmit={createUser} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
                <input type="email" required value={newEmail} onChange={e => setNewEmail(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  placeholder="owner@theirshop.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Temporary Password *</label>
                <input type="text" required minLength={8} value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                  placeholder="Share this with the user" />
                <p className="text-xs text-gray-400 mt-0.5">Ask them to change it after first login.</p>
              </div>
              <button type="submit" disabled={creating}
                className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 text-sm">
                {creating ? 'Creating…' : 'Create User Account'}
              </button>
            </form>

            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
              <strong>After creating:</strong> Share the email + password with the shop owner.
              They sign in → complete the onboarding form → their shop is ready.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
