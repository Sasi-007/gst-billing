/**
 * Minimal ZIP writer (STORE method, no compression).
 *
 * A monthly extract produces a dozen-plus files and browsers only reliably
 * deliver one download per user gesture, so the pack is bundled into a single
 * archive. Compression is skipped deliberately: DEFLATE would need a bundled
 * library, and CSV packs for one shop-month stay small enough that storing is
 * a fair trade for zero dependencies.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const VERSION = 20
const UTF8_FLAG = 0x0800 // Tells readers filenames/comments are UTF-8.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP stores timestamps as packed DOS date/time, which starts at 1980. */
function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function toBytes(content) {
  if (content instanceof Uint8Array) return content
  return new TextEncoder().encode(String(content ?? ''))
}

class ByteWriter {
  constructor() {
    this.chunks = []
    this.length = 0
  }

  u16(value) {
    const buffer = new Uint8Array(2)
    new DataView(buffer.buffer).setUint16(0, value & 0xffff, true)
    return this.raw(buffer)
  }

  u32(value) {
    const buffer = new Uint8Array(4)
    new DataView(buffer.buffer).setUint32(0, value >>> 0, true)
    return this.raw(buffer)
  }

  raw(bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
    return this
  }

  toUint8Array() {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

/**
 * Builds a ZIP blob from `[{ name, content }]`, where content is a string or
 * Uint8Array. Entries with a blank name are skipped.
 */
export function createZipBlob(files, { modifiedAt = new Date() } = {}) {
  const stamp = toDosDateTime(modifiedAt)
  const body = new ByteWriter()
  const central = new ByteWriter()
  let entryCount = 0

  for (const file of files || []) {
    const name = String(file?.name || '').trim()
    if (!name) continue

    const nameBytes = toBytes(name)
    const data = toBytes(file.content)
    const checksum = crc32(data)
    const localOffset = body.length

    body.u32(LOCAL_SIG).u16(VERSION).u16(UTF8_FLAG).u16(0)
      .u16(stamp.time).u16(stamp.date)
      .u32(checksum).u32(data.length).u32(data.length)
      .u16(nameBytes.length).u16(0)
      .raw(nameBytes).raw(data)

    central.u32(CENTRAL_SIG).u16(VERSION).u16(VERSION).u16(UTF8_FLAG).u16(0)
      .u16(stamp.time).u16(stamp.date)
      .u32(checksum).u32(data.length).u32(data.length)
      .u16(nameBytes.length).u16(0).u16(0)
      .u16(0).u16(0).u32(0)
      .u32(localOffset)
      .raw(nameBytes)

    entryCount += 1
  }

  const eocd = new ByteWriter()
  eocd.u32(EOCD_SIG).u16(0).u16(0)
    .u16(entryCount).u16(entryCount)
    .u32(central.length).u32(body.length)
    .u16(0)

  const archive = new ByteWriter()
    .raw(body.toUint8Array())
    .raw(central.toUint8Array())
    .raw(eocd.toUint8Array())

  return new Blob([archive.toUint8Array()], { type: 'application/zip' })
}

/** Triggers a browser download for a blob. */
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
