/**
 * Rasterises the on-page print markup to a canvas, which the PDF writer in
 * pdf.js turns into paper-sized pages.
 *
 * Installed PWAs cannot open a print dialog on either mobile platform:
 * Android Chrome removes printing entirely in standalone display mode, and
 * iOS Safari's standalone shell exposes no print affordance either, so
 * `window.print()` is a silent no-op on both. Rendering the markup ourselves
 * is what lets those platforms produce a file at all.
 */

export const MM_TO_PX = 96 / 25.4

function isAndroid() {
  return /Android/i.test(navigator.userAgent || '')
}

export function isIos() {
  const ua = navigator.userAgent || ''
  // iPadOS 13+ reports a desktop Mac UA, so fall back to the touch-point probe.
  return /iPad|iPhone|iPod/i.test(ua)
    || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1)
}

export function isStandaloneDisplay() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.matchMedia?.('(display-mode: fullscreen)').matches === true
    || window.matchMedia?.('(display-mode: minimal-ui)').matches === true
    || window.navigator?.standalone === true
  )
}

/** True when window.print() cannot open a print dialog on this platform. */
export function isPrintDialogBlocked() {
  if (typeof window === 'undefined') return false
  return (isAndroid() || isIos()) && isStandaloneDisplay()
}

/** Collects the rules nested inside `@media print` so they can be replayed. */
function extractPrintCss() {
  const chunks = []

  for (const sheet of Array.from(document.styleSheets)) {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      continue // Cross-origin sheet; nothing we can read.
    }
    if (!rules) continue

    for (const rule of Array.from(rules)) {
      const isPrintMedia = rule.type === CSSRule.MEDIA_RULE
        && /(^|,|\s)print(\s|,|$)/i.test(rule.conditionText || rule.media?.mediaText || '')
      if (!isPrintMedia) continue

      for (const inner of Array.from(rule.cssRules || [])) {
        // @page only affects paper output and is meaningless for an image.
        if (inner.type === CSSRule.PAGE_RULE) continue
        chunks.push(inner.cssText)
      }
    }
  }

  return chunks.join('\n')
}

async function toDataUrl(src) {
  const response = await fetch(src, { mode: 'cors', credentials: 'omit' })
  if (!response.ok) throw new Error(`Image request failed (${response.status})`)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read image'))
    reader.readAsDataURL(blob)
  })
}

/** Canvas rasterisation taints on remote images, so inline them up front. */
async function inlineImages(root) {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute('src') || ''
    if (!src || src.startsWith('data:')) return
    try {
      img.setAttribute('src', await toDataUrl(src))
    } catch {
      img.remove() // A missing logo is better than a failed receipt.
    }
  }))
}

function waitForIframeImages(doc) {
  const pending = Array.from(doc.images).filter((img) => !img.complete)
  if (!pending.length) return Promise.resolve()
  return Promise.all(pending.map((img) => new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true })
    img.addEventListener('error', resolve, { once: true })
  })))
}

export function collectPrintRoots() {
  return Array.from(document.querySelectorAll('.print-only'))
    .filter((node) => node.innerHTML.trim())
}

/**
 * Rasterises the given print nodes into a single canvas.
 *
 * `widthPx` forces the layout width (the PDF writer pins it to the paper size);
 * when omitted the node is measured at its natural width, except for thermal
 * receipts which are sized in mm and therefore pinned to 80mm.
 *
 * Returns null when there is nothing to draw.
 */
export async function rasterisePrintNodes(nodes, { scale = 3, widthPx = null } = {}) {
  const roots = Array.isArray(nodes) ? nodes : [nodes]
  if (!roots.length) return null

  const stage = document.createElement('div')
  for (const root of roots) stage.appendChild(root.cloneNode(true))
  await inlineImages(stage)

  const printCss = extractPrintCss()
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx || 794}px;height:10px;border:0;visibility:hidden;`
  document.body.appendChild(iframe)

  try {
    const doc = iframe.contentDocument
    doc.open()
    doc.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>',
    )
    doc.close()

    const style = doc.createElement('style')
    style.textContent = `
      html,body{margin:0;padding:0;background:#fff;}
      .print-only{display:block !important;}
      .no-print{display:none !important;}
      ${printCss}
    `
    doc.head.appendChild(style)

    const holder = doc.createElement('div')
    holder.style.cssText = 'display:inline-block;background:#fff;'
    holder.innerHTML = stage.innerHTML
    doc.body.appendChild(holder)

    await waitForIframeImages(doc)
    if (doc.fonts?.ready) await doc.fonts.ready

    // Thermal receipts are sized in mm; fall back to a sane pixel width.
    const measured = holder.getBoundingClientRect()
    const thermal = holder.querySelector('.thermal-receipt')
    const width = Math.ceil(widthPx || (thermal ? 80 * MM_TO_PX : (measured.width || 794)))
    holder.style.width = `${width}px`
    const height = Math.ceil(holder.getBoundingClientRect().height || measured.height || 1123)

    const serializer = new XMLSerializer()
    const styleXml = serializer.serializeToString(style)
    const bodyXml = serializer.serializeToString(holder)

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<foreignObject x="0" y="0" width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml">${styleXml}${bodyXml}</div>`
      + `</foreignObject></svg>`

    const image = new Image()
    image.decoding = 'sync'
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('Could not rasterise the receipt'))
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.drawImage(image, 0, 0)

    return canvas
  } finally {
    iframe.remove()
  }
}
