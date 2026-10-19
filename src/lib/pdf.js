/**
 * Builds real PDF files in the browser.
 *
 * The app used to rely on the print dialog's "Save as PDF" destination, which
 * only exists on desktop: Android Chrome drops printing completely while the
 * PWA runs standalone, and iOS Safari offers no PDF destination at all. Here
 * the print markup is rasterised (see printImage.js) and wrapped in a
 * hand-written PDF so every platform gets the same file.
 *
 * The writer is deliberately dependency-free — the registry is unreachable in
 * this environment and a local writer keeps the installed PWA working offline.
 */

import {
  MM_TO_PX,
  collectPrintRoots,
  isIos,
  rasterisePrintNodes,
} from './printImage'

const PT_PER_MM = 72 / 25.4
const A4 = { width: 210, height: 297 }
const THERMAL_WIDTH_MM = 80

/** Paper geometry mirrors the named @page rules in globals.css. */
function pageGeometryFor(node) {
  if (node.querySelector('.thermal-receipt')) {
    return { widthMm: THERMAL_WIDTH_MM, heightMm: null, widthPx: null }
  }
  if (node.querySelector('.report-sheet')) {
    // Stock and supplier sheets print A4 landscape.
    return { widthMm: A4.height, heightMm: A4.width, widthPx: Math.round(A4.height * MM_TO_PX) }
  }
  return { widthMm: A4.width, heightMm: A4.height, widthPx: Math.round(A4.width * MM_TO_PX) }
}

/**
 * Mobile canvases are capped well below desktop (iOS tops out around 16M
 * pixels), so the sampling factor drops as the sheet gets taller.
 */
function scaleFor(rootCount) {
  const base = isIos() || /Android/i.test(navigator.userAgent || '') ? 2 : 3
  if (rootCount > 40) return Math.min(base, 2)
  return base
}

function latin1Bytes(text) {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

function base64Bytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function canvasToJpegBytes(canvas, quality) {
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  if (!dataUrl.startsWith('data:image/jpeg')) {
    throw new Error('This browser could not encode the page image')
  }
  return base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1))
}

/**
 * Assembles pages into a PDF blob. Each page is a JPEG drawn edge to edge,
 * which matches the zero-margin @page rules used for printing.
 */
function buildPdf(pages) {
  const chunks = []
  const offsets = []
  let length = 0

  const push = (data) => {
    const bytes = typeof data === 'string' ? latin1Bytes(data) : data
    chunks.push(bytes)
    length += bytes.length
  }
  const startObject = (number) => {
    offsets[number] = length
    push(`${number} 0 obj\n`)
  }

  // 1 = catalog, 2 = page tree, then three objects per page.
  const pageObjectNumber = (index) => 3 + index * 3
  const totalObjects = 2 + pages.length * 3

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  startObject(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  startObject(2)
  const kids = pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(' ')
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`)

  pages.forEach((page, index) => {
    const pageNumber = pageObjectNumber(index)
    const contentNumber = pageNumber + 1
    const imageNumber = pageNumber + 2
    const widthPt = (page.widthMm * PT_PER_MM).toFixed(2)
    const heightPt = (page.heightMm * PT_PER_MM).toFixed(2)

    startObject(pageNumber)
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] `
      + `/Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> `
      + `/Contents ${contentNumber} 0 R >>\nendobj\n`,
    )

    const content = `q\n${widthPt} 0 0 ${heightPt} 0 0 cm\n/Im0 Do\nQ\n`
    startObject(contentNumber)
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)

    startObject(imageNumber)
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode `
      + `/Length ${page.jpeg.length} >>\nstream\n`,
    )
    push(page.jpeg)
    push('\nendstream\nendobj\n')
  })

  const xrefOffset = length
  push(`xref\n0 ${totalObjects + 1}\n`)
  push('0000000000 65535 f \n')
  for (let number = 1; number <= totalObjects; number += 1) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`)
  }
  push(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  )

  return new Blob(chunks, { type: 'application/pdf' })
}

/** Cuts a tall sheet into paper-sized slices, padding the last one with white. */
function sliceCanvas(canvas, geometry, quality) {
  const pixelsPerMm = canvas.width / geometry.widthMm
  const pages = []

  // Thermal receipts use one continuous page, exactly like `size: 80mm auto`.
  if (!geometry.heightMm) {
    pages.push({
      jpeg: canvasToJpegBytes(canvas, quality),
      widthMm: geometry.widthMm,
      heightMm: canvas.height / pixelsPerMm,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
    })
    return pages
  }

  const sliceHeight = Math.max(1, Math.round(geometry.heightMm * pixelsPerMm))
  // A couple of stray pixels from rounding must not spill onto a blank page.
  const tolerance = Math.max(2, Math.round(pixelsPerMm))
  const slice = document.createElement('canvas')
  slice.width = canvas.width
  slice.height = sliceHeight
  const ctx = slice.getContext('2d')

  for (let top = 0; top < canvas.height; top += sliceHeight) {
    if (canvas.height - top <= tolerance && top > 0) break
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, slice.width, slice.height)
    ctx.drawImage(canvas, 0, top, canvas.width, Math.min(sliceHeight, canvas.height - top),
      0, 0, canvas.width, Math.min(sliceHeight, canvas.height - top))
    pages.push({
      jpeg: canvasToJpegBytes(slice, quality),
      widthMm: geometry.widthMm,
      heightMm: geometry.heightMm,
      pixelWidth: slice.width,
      pixelHeight: slice.height,
    })
  }

  slice.width = 0
  slice.height = 0
  return pages
}

/** Frees the backing store so long packs do not exhaust mobile canvas memory. */
function releaseCanvas(canvas) {
  canvas.width = 0
  canvas.height = 0
}

/**
 * Renders the on-page print markup to a PDF blob.
 * Returns null when there is nothing to print.
 */
export async function renderPrintAreaToPdf({ quality = 0.92, onProgress } = {}) {
  const roots = collectPrintRoots()
  if (!roots.length) return null

  const pages = []
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]
    const geometry = pageGeometryFor(root)
    const canvas = await rasterisePrintNodes([root], {
      scale: scaleFor(roots.length),
      widthPx: geometry.widthPx,
    })
    if (canvas) {
      pages.push(...sliceCanvas(canvas, geometry, quality))
      releaseCanvas(canvas)
    }
    if (typeof onProgress === 'function') onProgress(index + 1, roots.length)
    // Yield so the UI can repaint between sheets of a large pack.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  if (!pages.length) return null
  return buildPdf(pages)
}

function withPdfExtension(fileName) {
  const name = fileName || `export-${new Date().toISOString().slice(0, 10)}`
  return name.replace(/\.(png|pdf)$/i, '') + '.pdf'
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

/**
 * iOS ignores the `download` attribute, so the PDF is handed to the viewer
 * instead, where the share sheet can save it to Files.
 */
function openBlob(blob) {
  const url = URL.createObjectURL(blob)
  const opened = window.open(url, '_blank')
  if (!opened) {
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

/**
 * Builds the PDF and hands it to the platform: the share sheet on mobile,
 * a download everywhere else.
 */
export async function exportPrintAreaAsPdf({ fileName, title, quality, onProgress } = {}) {
  const blob = await renderPrintAreaToPdf({ quality, onProgress })
  if (!blob) return { status: 'empty' }

  const name = withPdfExtension(fileName)
  const file = new File([blob], name, { type: 'application/pdf' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title || 'Export' })
      return { status: 'shared' }
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'cancelled' }
    }
  }

  if (isIos()) {
    openBlob(blob)
    return { status: 'opened' }
  }

  saveBlob(blob, name)
  return { status: 'downloaded' }
}
