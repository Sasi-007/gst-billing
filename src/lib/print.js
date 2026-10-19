import { flushSync } from 'react-dom'
import { isPrintDialogBlocked } from './printImage'
import { exportPrintAreaAsPdf } from './pdf'

/**
 * Renders the print markup and opens the print dialog in the same task as the
 * originating click. Browsers only allow window.print() while the user
 * activation from the click is still alive; deferring the call with a timer
 * drops that activation and makes some browsers show a
 * "This web page is trying to print" confirmation first.
 *
 * Android Chrome refuses to print at all while the PWA runs standalone, and
 * iOS standalone exposes no print affordance, so on those platforms a real PDF
 * is generated instead.
 */
export function printWithContent(renderPrintContent, options = {}) {
  if (typeof window === 'undefined') return

  if (typeof renderPrintContent === 'function') {
    flushSync(renderPrintContent)
  }

  if (isPrintDialogBlocked()) {
    exportPdfFallback(options)
    return
  }

  const pendingImages = Array.from(
    document.querySelectorAll('.print-only img, .thermal-receipt img, .invoice img')
  ).filter((img) => !img.complete)

  if (pendingImages.length === 0) {
    window.print()
    return
  }

  // A logo that is not cached yet would print blank, so wait for it. This
  // loses the user activation, which is unavoidable in that case.
  Promise.all(
    pendingImages.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true })
          img.addEventListener('error', resolve, { once: true })
        })
    )
  ).then(() => window.print())
}

/**
 * Renders the print markup and exports it as a real PDF on every platform.
 * Use this for "Export PDF" actions; `printWithContent` remains the path for
 * sending paper or receipts to a physical printer.
 */
export function exportPdfWithContent(renderPrintContent, options = {}) {
  if (typeof window === 'undefined') return Promise.resolve({ status: 'empty' })

  if (typeof renderPrintContent === 'function') {
    flushSync(renderPrintContent)
  }

  return runPdfExport(options)
}

function notifier(onStatus) {
  return typeof onStatus === 'function'
    ? onStatus
    : (message) => { if (message) window.alert(message) }
}

function runPdfExport({ fileName, title, onStatus, onProgress } = {}) {
  const notify = notifier(onStatus)

  return exportPrintAreaAsPdf({
    fileName: fileName || `export-${new Date().toISOString().slice(0, 10)}.pdf`,
    title: title || 'Export',
    onProgress,
  })
    .then((result) => {
      if (result.status === 'empty') notify('Nothing to export yet.')
      return result
    })
    .catch((error) => {
      notify(`Could not create the PDF: ${error.message}`)
      return { status: 'failed', error }
    })
}

function exportPdfFallback(options = {}) {
  const notify = notifier(options.onStatus)

  runPdfExport(options).then((result) => {
    if (result.status === 'downloaded' || result.status === 'opened') {
      notify('The installed app cannot open a print dialog, so the document was saved as a PDF you can print or share.')
    }
    // `afterprint` never fires on this path, so callers still need the signal
    // that let them clear the print markup and reset their form.
    if (typeof options.onFallbackComplete === 'function') options.onFallbackComplete(result)
  })
}
