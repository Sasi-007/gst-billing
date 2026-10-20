'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useShop } from '@/context/ShopContext'
import { useConfirm } from '@/context/ConfirmDialogContext'

const STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Delhi','Jammu & Kashmir','Ladakh','Chandigarh','Puducherry',
]

export default function SettingsPage() {
  const { shop, setShop, allShops } = useShop()
  const { confirm } = useConfirm()
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
  const [resettingInvoiceCounter, setResettingInvoiceCounter] = useState(false)
  const [invoiceCounterNotice, setInvoiceCounterNotice] = useState('')
  const [resettingPurchaseCounter, setResettingPurchaseCounter] = useState(false)
  const [purchaseCounterNotice, setPurchaseCounterNotice] = useState('')
  const [wiping, setWiping] = useState(false)
  const [wipeProgress, setWipeProgress] = useState('')
  const [wipeNotice, setWipeNotice] = useState('')

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
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')
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

  async function updateShopCounter(payload) {
    const { data: updated, error: updateErr } = await supabase
      .from('shops')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', shop.id)
      .select()
      .single()

    if (updateErr) throw updateErr
    if (updated) setShop({ ...shop, ...updated })
  }

  async function resetInvoiceCounter() {
    if (!shop?.id) return
    const ok = await confirm({
      title: 'Reset invoice numbering?',
      message: 'The next invoice will start again from INV-0001.',
      details: 'This is allowed only when the shop has no invoices at all. If any exist, the reset is refused and nothing changes.',
      tone: 'warning',
      confirmLabel: 'Reset counter',
    })
    if (!ok) return

    setResettingInvoiceCounter(true)
    setError('')
    setWarning('')
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')

    const { count, error: lookupErr } = await supabase
      .from('bills')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shop.id)
      .eq('bill_type', 'invoice')

    if (lookupErr) {
      setError(lookupErr.message)
      setResettingInvoiceCounter(false)
      return
    }

    if (Number(count || 0) > 0) {
      setInvoiceCounterNotice(`Not reset: this shop still has ${count} invoice${count === 1 ? '' : 's'} in the database, possibly outside the current date filter. Use force reset only for demo/testing if duplicates are acceptable.`)
      setResettingInvoiceCounter(false)
      return
    }

    try {
      await updateShopCounter({ bill_counter: 0 })
      setSaved(true)
      setInvoiceCounterNotice('Invoice counter reset. Next invoice will be INV-0001.')
      setTimeout(() => setSaved(false), 3000)
    } catch (updateErr) {
      setError(updateErr.message)
    } finally {
      setResettingInvoiceCounter(false)
    }
  }

  async function forceResetInvoiceCounter() {
    if (!shop?.id) return
    const ok = await confirm({
      title: 'Force reset invoice numbering?',
      message: 'This skips the safety check and forces the next invoice number to INV-0001.',
      details: 'If older invoices already use these numbers, you will end up with duplicate invoice numbers. Use this only for demo or testing data.',
      requireText: 'RESET',
      confirmLabel: 'Force reset',
    })
    if (!ok) return

    setResettingInvoiceCounter(true)
    setError('')
    setWarning('')
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')

    try {
      await updateShopCounter({ bill_counter: 0 })
      setSaved(true)
      setInvoiceCounterNotice('Invoice counter force-reset. Next invoice will try INV-0001.')
      setTimeout(() => setSaved(false), 3000)
    } catch (updateErr) {
      setError(updateErr.message)
    } finally {
      setResettingInvoiceCounter(false)
    }
  }

  async function resetPurchaseCounter() {
    if (!shop?.id) return
    const ok = await confirm({
      title: 'Reset purchase numbering?',
      message: 'The next purchase bill will start again from PUR-0001.',
      details: 'This is allowed only when the shop has no purchase bills at all. If any exist, the reset is refused and nothing changes.',
      tone: 'warning',
      confirmLabel: 'Reset counter',
    })
    if (!ok) return

    setResettingPurchaseCounter(true)
    setError('')
    setWarning('')
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')

    const { count, error: lookupErr } = await supabase
      .from('purchase_bills')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shop.id)

    if (lookupErr) {
      setError(lookupErr.message)
      setResettingPurchaseCounter(false)
      return
    }

    if (Number(count || 0) > 0) {
      setPurchaseCounterNotice(`Not reset: this shop still has ${count} purchase bill${count === 1 ? '' : 's'} in the database, possibly outside the current date filter. Use force reset only for demo/testing if duplicates are acceptable.`)
      setResettingPurchaseCounter(false)
      return
    }

    try {
      await updateShopCounter({ purchase_counter: 0 })
      setSaved(true)
      setPurchaseCounterNotice('Purchase counter reset. Next purchase will be PUR-0001.')
      setTimeout(() => setSaved(false), 3000)
    } catch (updateErr) {
      setError(updateErr.message)
    } finally {
      setResettingPurchaseCounter(false)
    }
  }

  async function forceResetPurchaseCounter() {
    if (!shop?.id) return
    const ok = await confirm({
      title: 'Force reset purchase numbering?',
      message: 'This skips the safety check and forces the next purchase number to PUR-0001.',
      details: 'If older purchases already use these numbers, you will end up with duplicate purchase numbers. Use this only for demo or testing data.',
      requireText: 'RESET',
      confirmLabel: 'Force reset',
    })
    if (!ok) return

    setResettingPurchaseCounter(true)
    setError('')
    setWarning('')
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')

    try {
      await updateShopCounter({ purchase_counter: 0 })
      setSaved(true)
      setPurchaseCounterNotice('Purchase counter force-reset. Next purchase will try PUR-0001.')
      setTimeout(() => setSaved(false), 3000)
    } catch (updateErr) {
      setError(updateErr.message)
    } finally {
      setResettingPurchaseCounter(false)
      return
    }
  }

  async function syncPurchaseCounter() {
    if (!shop?.id) return

    setResettingPurchaseCounter(true)
    setError('')
    setWarning('')
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')

    try {
      const prefix = form.purchase_prefix || shop.purchase_prefix || 'PUR'
      const { data, error: lookupErr } = await supabase
        .from('purchase_bills')
        .select('bill_no')
        .eq('shop_id', shop.id)
      if (lookupErr) throw lookupErr

      // Only numbers using the current prefix drive the counter; anything else
      // (old prefixes, offline temp numbers) would push it to a wrong value.
      const pattern = new RegExp(`^${prefix}-(\\d+)$`, 'i')
      const highest = (data || []).reduce((max, row) => {
        const match = pattern.exec(String(row.bill_no || '').trim())
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)

      await updateShopCounter({ purchase_counter: highest })
      setSaved(true)
      setPurchaseCounterNotice(
        highest > 0
          ? `Counter synced to ${highest}. Next purchase will be ${prefix}-${String(highest + 1).padStart(4, '0')}.`
          : `No purchases found using the prefix "${prefix}". Counter set to 0, so the next purchase will be ${prefix}-0001.`,
      )
      setTimeout(() => setSaved(false), 3000)
    } catch (syncErr) {
      setError(syncErr.message)
    } finally {
      setResettingPurchaseCounter(false)
    }
  }

  // Child rows are removed before their parents so foreign keys never block the
  // delete. Mirrors the superadmin reset_shop_data order.
  const WIPE_TABLES = [
    ['bank_transactions', 'Bank transactions'],
    ['owner_drawings', 'Drawings'],
    ['investments', 'Investments'],
    ['expenses', 'Expenses'],
    ['credit_entries', 'Credit entries'],
    ['credit_accounts', 'Credit accounts'],
    ['bill_items', 'Invoice items'],
    ['bills', 'Invoices'],
    ['purchase_bill_items', 'Purchase items'],
    ['purchase_bills', 'Purchases'],
    ['products', 'Products'],
    ['categories', 'Categories'],
    ['suppliers', 'Suppliers'],
    ['customers', 'Customers'],
    ['bank_accounts', 'Bank accounts'],
  ]

  async function deleteAllShopData() {
    if (!shop?.id) return

    // Pinned up front: if the active shop changes mid-run (shop switcher, a
    // context refresh) every delete must still target the shop that was confirmed.
    const targetShopId = shop.id
    const targetShopName = String(shop.name || '').trim()

    const otherShopCount = Math.max(0, (allShops?.length || 1) - 1)
    // Typing the shop name (not a generic phrase) makes it impossible to wipe the
    // wrong shop by muscle memory when several shops share one login.
    const ok = await confirm({
      title: `Delete ALL business data for "${targetShopName}"?`,
      message: 'This permanently removes invoices, purchases, products, categories, suppliers, customers, expenses, investments, drawings, credit book entries and bank records for this shop only.\n'
        + (otherShopCount > 0
          ? `Your other ${otherShopCount} shop${otherShopCount > 1 ? 's are' : ' is'} NOT affected.\n`
          : '')
        + 'Your shop profile, settings and login are kept.',
      details: 'There is no undo. Nothing is deleted until you type the shop name below exactly.',
      requireText: targetShopName,
      confirmLabel: 'Delete all data',
    })
    if (!ok) return

    setWiping(true)
    setError('')
    setWarning('')
    setWipeNotice('')
    setInvoiceCounterNotice('')
    setPurchaseCounterNotice('')

    try {
      for (const [table, label] of WIPE_TABLES) {
        if (!targetShopId) throw new Error('Aborted: no shop selected.')
        setWipeProgress(`Deleting ${label}…`)
        const { error: deleteErr } = await supabase.from(table).delete().eq('shop_id', targetShopId)
        // A table missing from this deployment should not abort the whole wipe.
        if (deleteErr && !/does not exist|schema cache/i.test(deleteErr.message)) {
          throw new Error(`Failed clearing ${label}: ${deleteErr.message}`)
        }
      }

      setWipeProgress('Resetting counters…')
      const { data: updated, error: counterErr } = await supabase
        .from('shops')
        .update({ bill_counter: 0, purchase_counter: 0, updated_at: new Date().toISOString() })
        .eq('id', targetShopId)
        .select()
        .single()
      if (counterErr) throw counterErr
      if (updated && updated.id === shop?.id) setShop({ ...shop, ...updated })

      try { window.sessionStorage.clear() } catch { /* storage unavailable */ }

      setWipeNotice(`All business data deleted for "${targetShopName}". Counters reset — the next invoice and purchase will start from 0001.`)
    } catch (wipeErr) {
      setError(wipeErr.message)
    } finally {
      setWipeProgress('')
      setWiping(false)
    }
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
              <button
                type="button"
                onClick={resetInvoiceCounter}
                disabled={resettingInvoiceCounter}
                className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
              >
                {resettingInvoiceCounter ? 'Resetting…' : 'Reset Invoice Number'}
              </button>
              <p className="text-xs text-gray-400 mt-1">
                Current counter: {Number(shop?.bill_counter || 0)}. Reset is blocked if any invoice exists.
              </p>
              {invoiceCounterNotice && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {invoiceCounterNotice}
                </div>
              )}
              <button
                type="button"
                onClick={forceResetInvoiceCounter}
                disabled={resettingInvoiceCounter}
                className="mt-2 text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
              >
                Force reset for demo/testing
              </button>
            </div>
            <div>
              {f('Purchase Prefix', 'purchase_prefix', { placeholder:'PUR' })}
              <p className="text-xs text-gray-400 mt-0.5">Purchases: PUR-0001…</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={syncPurchaseCounter}
                  disabled={resettingPurchaseCounter}
                  className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                >
                  {resettingPurchaseCounter ? 'Working…' : 'Sync to highest existing number'}
                </button>
                <button
                  type="button"
                  onClick={resetPurchaseCounter}
                  disabled={resettingPurchaseCounter}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                >
                  {resettingPurchaseCounter ? 'Resetting…' : 'Reset Purchase Number'}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Current counter: {Number(shop?.purchase_counter || 0)}. Sync reads your existing purchase numbers and
                continues from the highest one — use it after renumbering. Reset is blocked if any purchase bill exists.
              </p>
              {purchaseCounterNotice && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {purchaseCounterNotice}
                </div>
              )}
              <button
                type="button"
                onClick={forceResetPurchaseCounter}
                disabled={resettingPurchaseCounter}
                className="mt-2 text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
              >
                Force reset for demo/testing
              </button>
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

      {/* Danger Zone — outside the form so it can never be triggered by Enter */}
      <div className="mt-6 rounded-xl border-2 border-red-200 bg-red-50 p-5">
        <h2 className="font-semibold text-red-800">⚠ Danger Zone</h2>
        <div className="mt-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm">
          <span className="text-gray-500">This will delete data for:</span>{' '}
          <span className="font-bold text-red-700">{shop?.name || '—'}</span>
          {shop?.city && <span className="text-gray-500"> · {shop.city}</span>}
          {(allShops?.length || 0) > 1 && (
            <span className="mt-1 block text-xs text-gray-500">
              Your other {allShops.length - 1} shop{allShops.length - 1 > 1 ? 's are' : ' is'} not affected.
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-red-700">
          Deletes every invoice, purchase, product, category, supplier, customer, expense, investment,
          drawing, credit entry and bank record for this shop. The shop profile, settings and login are
          kept, and both numbering counters restart from 0001.
        </p>
        <p className="mt-1 text-xs font-medium text-red-700">
          Intended for test accounts. This cannot be undone — export anything you need first.
        </p>

        {wipeProgress && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-red-700">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-red-200 border-t-red-600" />
            {wipeProgress}
          </div>
        )}

        {wipeNotice && (
          <div className="mt-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-800">
            {wipeNotice}
          </div>
        )}

        <button
          type="button"
          onClick={deleteAllShopData}
          disabled={wiping}
          className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {wiping ? 'Deleting…' : 'Delete All Data'}
        </button>
      </div>
    </div>
  )
}
