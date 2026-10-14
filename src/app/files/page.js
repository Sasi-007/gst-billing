'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { loadLanguage } from '@uiw/codemirror-extensions-langs'
import LoadingPlaceholder from '@/components/LoadingPlaceholder'
import { useShop } from '@/context/ShopContext'
import { usePageLoadingState } from '@/context/PageLoadingContext'
import {
  createBinaryFile,
  createTextFile,
  deleteShopFile,
  fileExtension,
  formatFileSize,
  getDownloadUrl,
  getShopFile,
  isMissingShopFilesSchemaError,
  listShopFiles,
  readFileForUpload,
  renameShopFile,
  uniqueFileName,
  updateShopFileContent,
  MAX_BINARY_FILE_BYTES,
  SHOP_FILES_SQL_HINT,
} from '@/lib/files'

// Maps a file extension to a CodeMirror language extension. Falls back to
// plain text (no highlighting) for unknown/missing extensions.
function languageExtensionFor(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || ''
  try {
    const lang = loadLanguage(ext)
    return lang ? [lang] : []
  } catch {
    return []
  }
}

export default function FilesPage() {
  const { shop } = useShop()
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [schemaMissing, setSchemaMissing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)

  const [activeId, setActiveId] = useState('')
  const [activeFile, setActiveFile] = useState(null)
  const [content, setContent] = useState('')
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [editingId, setEditingId] = useState('')
  const [editingName, setEditingName] = useState('')
  const [busyId, setBusyId] = useState('')
  // Long code lines are unreadable on a narrow screen, so wrapping starts on
  // for small viewports. The toggle applies at any width.
  const [wrap, setWrap] = useState(false)

  const fileInputRef = useRef(null)
  // Line ending of the file currently open in the editor ('\n' or '\r\n').
  const eolRef = useRef('\n')
  usePageLoadingState('files-page', loading)

  const load = useCallback(async () => {
    if (!shop?.id) {
      setFiles([])
      setLoading(false)
      return
    }

    setLoading(true)
    const { data, error: loadErr } = await listShopFiles(shop.id)

    if (loadErr) {
      if (isMissingShopFilesSchemaError(loadErr)) {
        setSchemaMissing(true)
      } else {
        setError(loadErr.message || 'Failed to load files')
      }
      setFiles([])
      setLoading(false)
      return
    }

    setSchemaMissing(false)
    setError('')
    setFiles(data || [])
    setLoading(false)
  }, [shop?.id])

  useEffect(() => { load() }, [load])

  // Switching shops must not leave the previous shop's file open in the
  // editor, where saving it would fail against the newly selected shop.
  const shopIdRef = useRef(shop?.id)
  useEffect(() => {
    if (shopIdRef.current === shop?.id) return
    shopIdRef.current = shop?.id
    setActiveId('')
    setActiveFile(null)
    setContent('')
    setDirty(false)
    setEditingId('')
    setEditingName('')
    setError('')
    setNotice('')
  }, [shop?.id])

  // Default wrapping to on for phone-sized viewports (read once on mount so a
  // later manual toggle is not overridden).
  useEffect(() => {
    setWrap(window.matchMedia('(max-width: 639px)').matches)
  }, [])

  // Warn before a tab close / reload drops unsaved editor changes.
  useEffect(() => {
    if (!dirty) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const totalSize = useMemo(
    () => files.reduce((sum, f) => sum + (Number(f.size_bytes) || 0), 0),
    [files]
  )

  function triggerUpload() {
    fileInputRef.current?.click()
  }

  async function uploadFiles(selected) {
    if (!selected.length || !shop?.id) return

    setUploading(true)
    setError('')

    // One bad file must not silently skip the rest of the batch.
    const failures = []
    const renamed = []
    // Seeded from the current list, then extended as the batch proceeds so
    // two files named the same within one drop also get distinct names.
    const takenNames = new Set(files.map((f) => f.name))

    for (const file of selected) {
      try {
        const name = uniqueFileName(file.name, takenNames)
        if (name !== file.name) renamed.push(`${file.name} → ${name}`)
        takenNames.add(name)

        const { kind, content } = await readFileForUpload(file)
        const { error: insertErr } = kind === 'binary'
          ? await createBinaryFile(shop.id, file, name)
          : await createTextFile(shop.id, name, content)

        if (insertErr) {
          if (isMissingShopFilesSchemaError(insertErr)) {
            setSchemaMissing(true)
            break
          }
          failures.push(`${file.name}: ${insertErr.message || 'upload failed'}`)
          takenNames.delete(name)
        }
      } catch (err) {
        failures.push(`${file.name}: ${err?.message || 'could not be read'}`)
      }
    }

    if (failures.length) setError(failures.join(' · '))
    setNotice(renamed.length ? `Renamed to avoid duplicates: ${renamed.join(', ')}` : '')

    setUploading(false)
    load()
  }

  async function handleFilesSelected(e) {
    const selected = Array.from(e.target.files || [])
    e.target.value = '' // allow re-selecting the same file later
    await uploadFiles(selected)
  }

  function handleDragOver(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }

  function handleDragLeave(e) {
    // relatedTarget is null when the pointer leaves the window entirely.
    if (e.relatedTarget) return
    setDragging(false)
  }

  async function handleDrop(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    // Always prevent the browser's default "open the dropped file" behaviour,
    // including drops that land outside the page's content box.
    e.preventDefault()
    setDragging(false)
    await uploadFiles(Array.from(e.dataTransfer.files || []))
  }

  async function openFile(file) {
    if (!shop?.id) return
    // Switching files — or re-opening the current one, which reloads it from
    // the database — would otherwise discard edits without warning.
    if (dirty && !window.confirm(`Discard unsaved changes to "${activeFile?.name}"?`)) {
      return
    }
    setOpening(true)
    setError('')
    const { data, error: getErr } = await getShopFile(shop.id, file.id)
    setOpening(false)

    if (getErr) {
      setError(getErr.message || 'Failed to open file')
      return
    }

    setActiveId(data.id)
    setActiveFile(data)
    // CodeMirror reports its document with LF line breaks regardless of what
    // the file used, so remember the original ending and restore it on save.
    eolRef.current = (data.content || '').includes('\r\n') ? '\r\n' : '\n'
    setContent(data.content || '')
    setDirty(false)
  }

  function closeEditor({ force = false } = {}) {
    if (!force && dirty && !window.confirm('Discard unsaved changes?')) return
    setActiveId('')
    setActiveFile(null)
    setContent('')
    setDirty(false)
  }

  async function saveActiveFile() {
    if (!shop?.id || !activeId) return
    setSaving(true)
    setError('')
    const payload =
      eolRef.current === '\r\n' ? content.replace(/\r?\n/g, '\r\n') : content
    const { data, error: updateErr } = await updateShopFileContent(shop.id, activeId, payload)
    setSaving(false)

    if (updateErr) {
      setError(updateErr.message || 'Failed to save file')
      return
    }

    setDirty(false)
    setActiveFile((prev) => (prev ? { ...prev, ...data, content: payload } : prev))
    load()
  }

  function startEdit(file) {
    setEditingId(file.id)
    setEditingName(file.name || '')
  }

  async function saveRename(file) {
    const name = editingName.trim()
    if (!name || !shop?.id) return

    if (files.some((f) => f.id !== file.id && f.name === name)) {
      setError(`Another file is already named "${name}".`)
      return
    }

    // Changing the extension changes how the file is highlighted, and for a
    // binary it changes what the downloaded file claims to be — so confirm.
    const oldExt = fileExtension(file.name)
    const newExt = fileExtension(name)
    if (oldExt !== newExt) {
      const warning = file.kind === 'binary'
        ? `This is a ${oldExt ? `.${oldExt}` : 'binary'} file. Renaming it to ${newExt ? `.${newExt}` : 'no extension'} will not convert it, and the download may not open correctly. Continue?`
        : `Changing .${oldExt || '(none)'} to .${newExt || '(none)'} will change syntax highlighting. Continue?`
      if (!window.confirm(warning)) return
    }

    setBusyId(file.id)
    setError('')
    const { error: renameErr } = await renameShopFile(shop.id, file.id, name)
    setBusyId('')

    if (renameErr) {
      setError(renameErr.message || 'Failed to rename file')
      return
    }

    setEditingId('')
    setEditingName('')
    if (activeId === file.id) {
      setActiveFile((prev) => (prev ? { ...prev, name } : prev))
    }
    load()
  }

  async function downloadFile(file) {
    setBusyId(file.id)
    setError('')

    // Text lives in the database, so it is rebuilt client-side rather than
    // fetched from Storage.
    if (file.kind !== 'binary') {
      const { data, error: getErr } = await getShopFile(shop.id, file.id)
      setBusyId('')

      if (getErr) {
        setError(getErr.message || 'Failed to prepare download')
        return
      }

      const blob = new Blob([data.content ?? ''], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Revoking immediately can cancel the download before it starts.
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      return
    }

    const { data, error: urlErr } = await getDownloadUrl(file.storage_path)
    setBusyId('')

    if (urlErr || !data?.signedUrl) {
      setError(urlErr?.message || 'Failed to prepare download')
      return
    }

    window.open(data.signedUrl, '_blank', 'noopener')
  }

  async function removeFile(file) {
    if (!shop?.id) return
    if (!window.confirm(`Delete "${file.name}"? This cannot be undone.`)) return

    setBusyId(file.id)
    setError('')
    const { error: deleteErr } = await deleteShopFile(shop.id, file)
    setBusyId('')

    if (deleteErr) {
      setError(deleteErr.message || 'Failed to delete file')
      return
    }

    // The row is already gone, so there is nothing left to save or discard.
    if (activeId === file.id) closeEditor({ force: true })
    load()
  }

  const activeExtensions = useMemo(() => {
    const extensions = languageExtensionFor(activeFile?.name)
    if (wrap) extensions.push(EditorView.lineWrapping)
    return extensions
  }, [activeFile?.name, wrap])

  return (
    <div
      className="min-h-full p-4"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-blue-600/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-blue-500 bg-white mx-4 px-6 py-6 text-center shadow-lg sm:px-8">
            <div className="text-2xl">📁</div>
            <div className="mt-1 font-medium text-gray-900">Drop files to upload</div>
            <div className="text-sm text-gray-500">Text/code files stay editable · ZIPs upload as-is</div>
          </div>
        </div>
      )}
      <div className="max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold">Files</h1>
          <div className="text-sm text-gray-500">
            Text/code opens in the editor · ZIPs, images and other binaries are download-only ·
            {' '}max {formatFileSize(MAX_BINARY_FILE_BYTES)} per file
          </div>
        </div>
        <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0">
          <div className="text-sm text-gray-500 whitespace-nowrap">{files.length} file(s) · {formatFileSize(totalSize)}</div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
          />
          <button
            type="button"
            onClick={triggerUpload}
            disabled={uploading || !shop?.id}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium whitespace-nowrap hover:bg-blue-700 disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : '+ Upload File'}
          </button>
        </div>
      </div>

      {schemaMissing && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {SHOP_FILES_SQL_HINT}
        </div>
      )}

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {notice && <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">{notice}</div>}

      {loading ? (
        <LoadingPlaceholder label="Loading files" rows={5} fullPage />
      ) : files.length === 0 ? (
        <button
          type="button"
          onClick={triggerUpload}
          disabled={uploading || !shop?.id}
          className="w-full bg-white rounded-xl border-2 border-dashed p-8 text-center text-gray-400 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
        >
          <div className="text-2xl">📁</div>
          <div className="mt-1 font-medium">No files yet</div>
          <div className="text-sm">
            <span className="hidden sm:inline">Drag and drop files here, or click to browse</span>
            <span className="sm:hidden">Tap to browse files</span>
          </div>
        </button>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden mb-4">
          <div className="divide-y">
            {files.map((file) => (
              <div key={file.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2">
                {editingId === file.id ? (
                  <>
                    <input
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      className="flex-1 min-w-0 border rounded-lg px-3 py-2 text-sm"
                    />
                    <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => saveRename(file)}
                      disabled={busyId === file.id || !editingName.trim()}
                      className="flex-1 sm:flex-none px-3 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
                    >
                      {busyId === file.id ? '…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingId(''); setEditingName('') }}
                      className="flex-1 sm:flex-none px-3 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm"
                    >
                      Cancel
                    </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {file.name}
                        {file.kind === 'binary' && (
                          <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-500">
                            binary
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400">
                        {formatFileSize(file.size_bytes)} · updated {new Date(file.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:shrink-0">
                    {file.kind === 'binary' ? (
                      <button
                        type="button"
                        onClick={() => downloadFile(file)}
                        disabled={busyId === file.id}
                        className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200 disabled:opacity-50"
                      >
                        {busyId === file.id ? '…' : 'Download'}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => openFile(file)}
                          disabled={opening}
                          className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadFile(file)}
                          disabled={busyId === file.id}
                          className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200 disabled:opacity-50"
                        >
                          {busyId === file.id ? '…' : 'Download'}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => startEdit(file)}
                      className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFile(file)}
                      disabled={busyId === file.id}
                      className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm hover:bg-red-100 disabled:opacity-50"
                    >
                      {busyId === file.id ? '…' : 'Delete'}
                    </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeFile && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b px-4 py-3">
            <div className="font-medium text-gray-900 truncate">
              {activeFile.name}
              {dirty && <span className="ml-2 text-xs text-amber-600">(unsaved)</span>}
            </div>
            <div className="flex items-center gap-2 sm:shrink-0">
              <button
                type="button"
                onClick={() => setWrap(w => !w)}
                title="Toggle line wrapping"
                className={`flex-1 sm:flex-none px-3 py-2 rounded-lg text-sm ${wrap ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-700'}`}
              >
                Wrap
              </button>
              <button
                type="button"
                onClick={saveActiveFile}
                disabled={saving || !dirty}
                className="flex-1 sm:flex-none px-3 py-2 rounded-lg bg-blue-600 text-white text-sm disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => closeEditor()}
                className="flex-1 sm:flex-none px-3 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm"
              >
                Close
              </button>
            </div>
          </div>
          <CodeMirror
            value={content}
            height="60vh"
            extensions={activeExtensions}
            onChange={(value) => {
              setContent(value)
              setDirty(true)
            }}
          />
        </div>
      )}
      </div>
    </div>
  )
}
