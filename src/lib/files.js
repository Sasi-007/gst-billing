import { supabase } from '@/lib/supabase'

export const SHOP_FILES_SQL_HINT = 'Run supabase/updates_2026_10_13_shop_files.sql and updates_2026_10_13_shop_files_binary.sql once to enable the Files feature.'
export const SHOP_FILES_BUCKET = 'shop-files'

// Supabase free-tier cap for a single Storage upload.
export const MAX_BINARY_FILE_BYTES = 50 * 1024 * 1024

const FILE_COLUMNS = 'id,name,kind,storage_path,size_bytes,created_at,updated_at'

export function isMissingShopFilesSchemaError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    (message.includes('shop_files') && message.includes('does not exist')) ||
    (message.includes('kind') && message.includes('does not exist')) ||
    (message.includes('storage_path') && message.includes('does not exist')) ||
    message.includes('could not find the table')
  )
}

// Formats known to be binary. Checked before any byte sniffing so an archive
// or image that happens to start with text-looking bytes is never mistaken
// for editable text.
const BINARY_EXTENSIONS = new Set([
  '7z', 'avi', 'bin', 'bmp', 'bz2', 'class', 'dat', 'dll', 'dmg', 'doc', 'docx',
  'exe', 'flac', 'gif', 'gz', 'heic', 'ico', 'jar', 'jpeg', 'jpg', 'mov', 'mp3',
  'mp4', 'mkv', 'odp', 'ods', 'odt', 'ogg', 'pdf', 'png', 'ppt', 'pptx', 'psd',
  'rar', 'so', 'sqlite', 'tar', 'tgz', 'tif', 'tiff', 'ttf', 'wasm', 'wav',
  'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'zip',
])

// Text files are validated by decoding them in full, so cap the size we are
// willing to pull into memory and keep in a Postgres TEXT column. Anything
// larger is stored in Storage as an opaque download instead.
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024

export function fileExtension(name) {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

// Byte-order marks tell us the real encoding; without one we assume UTF-8.
// BOM-less UTF-16 is full of NUL bytes and so is treated as binary.
function encodingFromBom(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return 'utf-8'
}

/**
 * Decides whether a file can be stored as editable text, and returns its
 * decoded content when it can.
 *
 * A Postgres TEXT column cannot hold NUL bytes, and `File.text()` silently
 * replaces undecodable bytes with U+FFFD — which would corrupt a binary. So
 * the whole file is decoded strictly: anything that is not valid text in its
 * detected encoding is classified as binary and routed to Storage instead.
 */
export async function readFileForUpload(file) {
  if (BINARY_EXTENSIONS.has(fileExtension(file.name))) {
    return { kind: 'binary', content: null }
  }

  if (file.size > MAX_TEXT_FILE_BYTES) {
    return { kind: 'binary', content: null }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    const text = new TextDecoder(encodingFromBom(bytes), { fatal: true }).decode(bytes)
    // A decodable file can still carry NUL characters, which TEXT rejects.
    if (text.includes('\u0000')) return { kind: 'binary', content: null }
    // Strip the BOM so it does not show up as a stray glyph in the editor.
    return { kind: 'text', content: text.replace(/^\uFEFF/, '') }
  } catch {
    return { kind: 'binary', content: null }
  }
}

// Returns a name that does not collide with `existingNames`, turning
// "report.txt" into "report (1).txt" rather than silently creating a duplicate.
export function uniqueFileName(name, existingNames) {
  const taken = new Set(existingNames)
  if (!taken.has(name)) return name

  const ext = fileExtension(name)
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name
  const suffix = ext ? `.${ext}` : ''

  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${suffix}`
    if (!taken.has(candidate)) return candidate
  }

  return `${stem} (${Date.now()})${suffix}`
}

export async function listShopFiles(shopId) {
  return supabase
    .from('shop_files')
    .select(FILE_COLUMNS)
    .eq('shop_id', shopId)
    .order('updated_at', { ascending: false })
}

export async function getShopFile(shopId, fileId) {
  return supabase
    .from('shop_files')
    .select(`${FILE_COLUMNS},content`)
    .eq('shop_id', shopId)
    .eq('id', fileId)
    .single()
}

export async function createTextFile(shopId, name, content) {
  return supabase
    .from('shop_files')
    .insert({
      shop_id: shopId,
      name,
      kind: 'text',
      content,
      size_bytes: new Blob([content]).size,
    })
    .select(FILE_COLUMNS)
    .single()
}

// Supabase Storage object keys must be ASCII and reject many punctuation
// characters, so the key is sanitised. The original filename is preserved
// untouched in shop_files.name, which is what the UI displays.
function toStorageKey(name) {
  const safe = String(name)
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.]+/, '')
    .slice(-100)
  return safe || 'file'
}

export async function createBinaryFile(shopId, file, displayName = file.name) {
  if (file.size > MAX_BINARY_FILE_BYTES) {
    return {
      data: null,
      error: {
        message: `"${displayName}" is ${formatFileSize(file.size)}. Uploads are limited to ${formatFileSize(MAX_BINARY_FILE_BYTES)}.`,
      },
    }
  }

  const storagePath = `${shopId}/${crypto.randomUUID()}-${toStorageKey(displayName)}`

  const { error: uploadErr } = await supabase.storage
    .from(SHOP_FILES_BUCKET)
    .upload(storagePath, file, { contentType: file.type || 'application/octet-stream' })

  if (uploadErr) return { data: null, error: uploadErr }

  const result = await supabase
    .from('shop_files')
    .insert({
      shop_id: shopId,
      name: displayName,
      kind: 'binary',
      content: '',
      storage_path: storagePath,
      size_bytes: file.size,
    })
    .select(FILE_COLUMNS)
    .single()

  // Don't leave an orphaned object behind if the row insert fails.
  if (result.error) {
    await supabase.storage.from(SHOP_FILES_BUCKET).remove([storagePath])
  }

  return result
}

export async function getDownloadUrl(storagePath) {
  return supabase.storage
    .from(SHOP_FILES_BUCKET)
    .createSignedUrl(storagePath, 60, { download: true })
}

export async function updateShopFileContent(shopId, fileId, content) {
  return supabase
    .from('shop_files')
    .update({
      content,
      size_bytes: new Blob([content]).size,
    })
    .eq('shop_id', shopId)
    .eq('id', fileId)
    .eq('kind', 'text')
    .select(FILE_COLUMNS)
    .single()
}

export async function renameShopFile(shopId, fileId, name) {
  return supabase
    .from('shop_files')
    .update({ name })
    .eq('shop_id', shopId)
    .eq('id', fileId)
    .select(FILE_COLUMNS)
    .single()
}

export async function deleteShopFile(shopId, file) {
  if (file.kind === 'binary' && file.storage_path) {
    await supabase.storage.from(SHOP_FILES_BUCKET).remove([file.storage_path])
  }

  return supabase
    .from('shop_files')
    .delete()
    .eq('shop_id', shopId)
    .eq('id', file.id)
}

export function formatFileSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
