'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useShop } from '@/context/ShopContext'

const STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Delhi','Jammu & Kashmir','Ladakh','Chandigarh','Puducherry',
]

export default function SettingsPage() {
  const { shop, setShop } = useShop()
  const [form,   setForm]   = useState({
    name:'', address:'', city:'', state:'Tamil Nadu', state_code:'33',
    pincode:'', phone:'', email:'', gstin:'', footer_text:'Thank you for your business!',
    bill_prefix:'INV', purchase_prefix:'PUR', logo_url:'',
    use_global_name_suggestions:true,
    print_template:'standard',
  })
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState('')
  const [warning, setWarning] = useState('')

  // Load current shop data into form
  useEffect(() => {
    if (shop?.id) {
      setForm(f => ({ ...f, ...shop }))
    }
  }, [shop?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function save(e) {
    e.preventDefault()
    if (!shop?.id) return
    setSaving(true)
    setError('')
    setWarning('')
    const payload = {
      name:             form.name,
      address:          form.address          || null,
      city:             form.city             || null,
      state:            form.state,
      state_code:       form.state_code       || null,
      pincode:          form.pincode          || null,
      phone:            form.phone            || null,
      email:            form.email            || null,
      gstin:            form.gstin            || null,
      footer_text:      form.footer_text      || null,
      bill_prefix:      form.bill_prefix      || 'INV',
      purchase_prefix:  form.purchase_prefix  || 'PUR',
      logo_url:         form.logo_url         || null,
      print_template:   form.print_template || 'standard',
      updated_at:       new Date().toISOString(),
    }
    const { data: updated, error: updateErr } = await supabase
      .from('shops').update(payload).eq('id', shop.id).select().single()
    if (updateErr) {
      setError(updateErr.message)
      setSaving(false)
      return
    }
    let updatedShop = updated ? { ...shop, ...updated } : shop
    const { data: suggestionSettings, error: suggestionErr } = await supabase
      .from('shops')
      .update({ use_global_name_suggestions: form.use_global_name_suggestions !== false })
      .eq('id', shop.id)
      .select('use_global_name_suggestions')
      .single()
    if (suggestionErr) {
      const message = suggestionErr.message || ''
      if (message.includes('use_global_name_suggestions')) {
        setWarning('Print settings were saved. Product name suggestion preference was not saved because the dictionary preference migration is not yet run.')
      } else {
        setError(message)
        setSaving(false)
        return
      }
    } else if (suggestionSettings) {
      updatedShop = { ...updatedShop, ...suggestionSettings }
    }
    if (updated) setShop(updatedShop)  // reflect in context immediately
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    setSaving(false)
  }

  const f = (label, key, props = {}) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input value={form[key] ?? ''} onChange={e => set(key, e.target.value)}
        className="w-full border rounded-lg px-3 py-2 text-sm" {...props} />
    </div>
  )

  return (
    <div className="p-4 max-w-2xl">
      <h1 className="text-xl font-bold mb-4">Settings</h1>

      {saved && (
        <div className="mb-3 p-3 bg-green-50 text-green-700 text-sm rounded-lg">✓ Settings saved</div>
      )}
      {error && (
        <div className="mb-3 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>
      )}
      {warning && (
        <div className="mb-3 p-3 bg-amber-50 text-amber-700 text-sm rounded-lg">{warning}</div>
      )}

      <form onSubmit={save} className="space-y-4">

        {/* Shop Info */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="font-semibold mb-3">Shop Information</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">Shop Name *</label>
              <input required value={form.name} onChange={e => set('name', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm font-medium" />
            </div>
            <div className="col-span-2">{f('Address', 'address')}</div>
            {f('City', 'city')}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">State</label>
              <select value={form.state} onChange={e => set('state', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm">
                {STATES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            {f('Pincode', 'pincode', { maxLength: 6 })}
            {f('Phone', 'phone', { type: 'tel' })}
            {f('Email', 'email', { type: 'email' })}
          </div>
        </div>

        {/* GST Info */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="font-semibold mb-3">GST & Tax Information</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">GSTIN</label>
              <input value={form.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                placeholder="22AAAAA0000A1Z5" maxLength={15} />
              <p className="text-xs text-gray-400 mt-0.5">15-character GSTIN from GST portal</p>
            </div>
            {f('State Code', 'state_code', { maxLength: 2, className: 'w-full border rounded-lg px-3 py-2 text-sm' })}
          </div>
        </div>

        {/* Bill Settings */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="font-semibold mb-3">Bill Numbering</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              {f('Invoice Prefix', 'bill_prefix', { placeholder:'INV' })}
              <p className="text-xs text-gray-400 mt-0.5">Bills will be numbered INV-0001, INV-0002…</p>
            </div>
            <div>
              {f('Purchase Prefix', 'purchase_prefix', { placeholder:'PUR' })}
              <p className="text-xs text-gray-400 mt-0.5">Purchases: PUR-0001…</p>
            </div>
          </div>
        </div>

        {/* Print Settings */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="font-semibold mb-3">Print / Invoice</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Print Template</label>
              <select value={form.print_template || 'standard'} onChange={e => set('print_template', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="standard">Standard GST invoice</option>
                <option value="thermal_80mm">Thermal grocery receipt - 80mm</option>
              </select>
            </div>
            {f('Footer Text', 'footer_text', { placeholder:'Thank you for your business!' })}
            {f('Logo URL (optional)', 'logo_url', { placeholder:'https://…' })}
          </div>
        </div>

        {/* Product Name Suggestions */}
        <div className="bg-white rounded-xl border p-5">
          <h2 className="font-semibold mb-3">Product Name Suggestions</h2>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.use_global_name_suggestions !== false}
              onChange={e => set('use_global_name_suggestions', e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="font-medium text-gray-800">Use central Tamil/local dictionary</span>
              <span className="block text-xs text-gray-500 mt-1">
                Turn off if this shop wants only its own saved Tamil names and aliases.
              </span>
            </span>
          </label>
        </div>

        <button type="submit" disabled={saving}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </form>
    </div>
  )
}
