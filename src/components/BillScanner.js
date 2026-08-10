'use client'

import { useState, useRef, useCallback } from 'react'

const ACCEPTED = 'image/jpeg,image/jpg,image/png,image/webp'
const MAX_MB   = 5

/**
 * Upload a vendor invoice image → AI extracts line items → call onApply(result).
 * All errors are surfaced in the UI; onApply is only called with valid data.
 */
export default function BillScanner({ onApply }) {
  const [file,     setFile]     = useState(null)
  const [preview,  setPreview]  = useState(null)
  const [scanning, setScanning] = useState(false)
  const [result,   setResult]   = useState(null)
  const [error,    setError]    = useState(null)
  const [applied,  setApplied]  = useState(false)
  const inputRef = useRef(null)

  // ── File selection ───────────────────────────────────────────
  function handleFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    reset(false)

    if (!['image/jpeg','image/jpg','image/png','image/webp'].includes(f.type)) {
      setError('Only JPG, PNG, or WEBP images are supported.')
      return
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`File is too large. Maximum is ${MAX_MB} MB.`)
      return
    }

    setFile(f)
    const reader = new FileReader()
    reader.onload = ev => setPreview(ev.target.result)
    reader.readAsDataURL(f)
  }

  // ── Drag & drop ──────────────────────────────────────────────
  function handleDrop(e) {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    if (f) {
      // Simulate change event
      const dt = new DataTransfer()
      dt.items.add(f)
      inputRef.current.files = dt.files
      handleFile({ target: { files: dt.files } })
    }
  }

  // ── AI scan ──────────────────────────────────────────────────
  async function scan() {
    if (!file || scanning) return
    setScanning(true)
    setError(null)

    try {
      const body = new FormData()
      body.append('file', file)

      const res = await fetch('/api/scan-bill', { method: 'POST', body })
      const json = await res.json()

      if (!res.ok) {
        setError(json.error || 'Scan failed. Please try again.')
        return
      }
      if (!Array.isArray(json.items) || json.items.length === 0) {
        setError('No line items detected. Try a clearer photo of the invoice.')
        return
      }

      setResult(json)
    } catch {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setScanning(false)
    }
  }

  // ── Apply to form ────────────────────────────────────────────
  function apply() {
    if (!result) return
    onApply(result)
    setApplied(true)
  }

  // ── Reset ────────────────────────────────────────────────────
  const reset = useCallback((clearFile = true) => {
    if (clearFile) {
      setFile(null)
      setPreview(null)
      if (inputRef.current) inputRef.current.value = ''
    }
    setResult(null)
    setError(null)
    setApplied(false)
  }, [])

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">🤖</span>
          <div>
            <p className="font-semibold text-sm text-gray-800">AI Bill Scanner</p>
            <p className="text-xs text-gray-500">Upload vendor invoice → auto-fill purchase items</p>
          </div>
        </div>
        {(file || result) && (
          <button onClick={() => reset(true)} className="text-xs text-gray-400 hover:text-gray-700 leading-none">
            ✕ Clear
          </button>
        )}
      </div>

      {/* Drop zone (shown before file selected) */}
      {!file && (
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="border-2 border-dashed border-amber-300 rounded-lg py-6 text-center cursor-pointer
                     hover:bg-amber-100 transition-colors select-none"
        >
          <input ref={inputRef} type="file" accept={ACCEPTED} onChange={handleFile} className="hidden" />
          <div className="text-3xl mb-1">📎</div>
          <p className="text-sm font-medium text-gray-700">Click or drag invoice image here</p>
          <p className="text-xs text-gray-400 mt-1">JPG · PNG · WEBP &nbsp;|&nbsp; Max {MAX_MB} MB</p>
        </div>
      )}

      {/* File selected — show preview + scan button */}
      {file && !result && (
        <div className="flex gap-3 items-start">
          {preview && (
            <img src={preview} alt="Invoice preview"
              className="w-20 h-24 object-cover rounded border border-gray-200 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
            <p className="text-xs text-gray-400 mt-0.5">{(file.size / 1024).toFixed(0)} KB</p>
            <button
              onClick={scan}
              disabled={scanning}
              className="mt-2 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium
                         hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
            >
              {scanning
                ? <><span className="animate-spin inline-block">⏳</span> Analysing…</>
                : <>🔍 Scan &amp; Extract Items</>}
            </button>
            {scanning && (
              <p className="text-xs text-gray-400 mt-1">This may take up to 30 seconds…</p>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex gap-2">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      {/* Extracted results — review before applying */}
      {result && !applied && (
        <div className="mt-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-green-600 font-semibold text-sm">✓ {result.items.length} item{result.items.length !== 1 ? 's' : ''} extracted</span>
          </div>

          {/* Metadata chips */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {result.supplier_name   && <Chip label="Supplier" value={result.supplier_name} />}
            {result.supplier_gstin  && <Chip label="GSTIN"    value={result.supplier_gstin} />}
            {result.invoice_number  && <Chip label="Inv#"     value={result.invoice_number} />}
            {result.invoice_date    && <Chip label="Date"     value={result.invoice_date} />}
            {result.total_amount    && <Chip label="Total"    value={`₹${result.total_amount}`} />}
          </div>

          {/* Items preview table */}
          <div className="bg-white rounded-lg border max-h-44 overflow-y-auto text-xs mb-2">
            <table className="w-full">
              <thead className="sticky top-0 bg-gray-50">
                <tr className="border-b text-gray-500">
                  <th className="px-2 py-1.5 text-left">Product</th>
                  <th className="px-2 py-1.5 text-center">Qty</th>
                  <th className="px-2 py-1.5 text-right">Rate</th>
                  <th className="px-2 py-1.5 text-center">GST</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-2 py-1.5 max-w-[140px] truncate font-medium" title={item.name}>
                      {item.name}
                    </td>
                    <td className="px-2 py-1.5 text-center">{item.quantity} {item.unit}</td>
                    <td className="px-2 py-1.5 text-right">₹{item.rate}</td>
                    <td className="px-2 py-1.5 text-center">{item.gst_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500 mb-2">
            Review the extracted data above. Click <strong>Apply</strong> to fill the form — you can still edit everything before saving.
          </p>

          <div className="flex gap-2">
            <button onClick={apply}
              className="flex-1 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
              ✓ Apply to Form
            </button>
            <button onClick={() => { setResult(null); setError(null) }}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
              Re-scan
            </button>
          </div>
        </div>
      )}

      {/* Applied confirmation */}
      {applied && (
        <div className="mt-1 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          ✓ {result.items.length} item{result.items.length !== 1 ? 's' : ''} applied.
          &nbsp;Review and edit the form below before saving.
        </div>
      )}
    </div>
  )
}

function Chip({ label, value }) {
  return (
    <span className="bg-white border rounded-full px-2 py-0.5 text-xs text-gray-700">
      <span className="text-gray-400">{label}: </span>{value}
    </span>
  )
}
