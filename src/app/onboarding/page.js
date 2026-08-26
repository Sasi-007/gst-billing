'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useShop } from '@/context/ShopContext'

const STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa',
  'Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala',
  'Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland',
  'Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura',
  'Uttar Pradesh','Uttarakhand','West Bengal',
  'Delhi','Jammu & Kashmir','Ladakh','Chandigarh','Puducherry',
]

const DEFAULT_CATEGORIES = [
  'Staples','Dairy','Beverages','Snacks',
  'Personal Care','Household','Frozen','Bakery','Others',
]

export default function OnboardingPage() {
  const [step,   setStep]   = useState(1)   // 1 = shop info, 2 = done
  const [form,   setForm]   = useState({
    name:'', gstin:'', phone:'', address:'',
    city:'', state:'Tamil Nadu', pincode:'',
    bill_prefix:'INV', purchase_prefix:'PUR',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const router = useRouter()
  const { refreshShops } = useShop()

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function create(e) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Shop name is required.'); return }
    setSaving(true)
    setError('')

    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser()
      if (authErr || !user) throw new Error('Session expired. Please sign in again.')

      // Use the RPC that creates shop + user_shops + default categories atomically
      const { data: shopId, error: rpcErr } = await supabase.rpc('create_shop_with_defaults', {
        p_name:    form.name.trim(),
        p_gstin:   form.gstin.trim()   || null,
        p_phone:   form.phone.trim()   || null,
        p_address: form.address.trim() || null,
        p_city:    form.city.trim()    || null,
        p_state:   form.state,
        p_pincode: form.pincode.trim() || null,
      })

      if (rpcErr) throw rpcErr

      // Update bill prefixes (not in RPC)
      await supabase.from('shops').update({
        bill_prefix:     form.bill_prefix.trim()     || 'INV',
        purchase_prefix: form.purchase_prefix.trim() || 'PUR',
      }).eq('id', shopId)

      setStep(2)
      // Reload shop context so the new shop becomes active, then navigate
      await refreshShops()
      setTimeout(() => router.replace('/'), 800)
    } catch (err) {
      setError(err.message || 'Could not create shop. Please try again.')
      setSaving(false)
    }
  }

  if (step === 2) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border p-8 text-center max-w-sm w-full">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="text-xl font-bold text-gray-900">{form.name} is ready!</h2>
          <p className="text-sm text-gray-500 mt-2">Taking you to your dashboard…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg border p-8 w-full max-w-md">

        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-5xl mb-2">🏪</div>
          <h1 className="text-xl font-bold text-gray-900">Set Up Your Shop</h1>
          <p className="text-sm text-gray-500 mt-1">This takes less than a minute</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
            {error}
          </div>
        )}

        <form onSubmit={create} className="space-y-3">

          {/* Shop Name */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Shop / Business Name <span className="text-red-500">*</span>
            </label>
            <input autoFocus required
              value={form.name} onChange={e => set('name', e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="e.g. Sri Lakshmi Stores" />
          </div>

          {/* GSTIN */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">GSTIN</label>
            <input value={form.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())}
              className="w-full border rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="22AAAAA0000A1Z5" maxLength={15} />
          </div>

          {/* Phone */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Phone</label>
            <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="+91 98765 43210" />
          </div>

          {/* Address */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Address</label>
            <input value={form.address} onChange={e => set('address', e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="Street / Area" />
          </div>

          {/* City + Pincode */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">City</label>
              <input value={form.city} onChange={e => set('city', e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Pincode</label>
              <input value={form.pincode} onChange={e => set('pincode', e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
                maxLength={6} />
            </div>
          </div>

          {/* State */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">State</label>
            <select value={form.state} onChange={e => set('state', e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none">
              {STATES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>

          {/* Bill Numbering */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Invoice Prefix</label>
              <input value={form.bill_prefix} onChange={e => set('bill_prefix', e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="INV" maxLength={6} />
              <p className="text-xs text-gray-400 mt-0.5">e.g. INV-0001</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Purchase Prefix</label>
              <input value={form.purchase_prefix} onChange={e => set('purchase_prefix', e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="PUR" maxLength={6} />
              <p className="text-xs text-gray-400 mt-0.5">e.g. PUR-0001</p>
            </div>
          </div>

          <button type="submit" disabled={saving || !form.name.trim()}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700
                       disabled:opacity-50 transition-colors text-sm mt-2">
            {saving ? 'Creating your shop…' : 'Create Shop & Continue →'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-4">
          Default categories (Staples, Dairy, Snacks…) are created automatically.
        </p>
      </div>
    </div>
  )
}
