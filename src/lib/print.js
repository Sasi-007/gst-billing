import { flushSync } from 'react-dom'
import { isPrintDialogBlocked, sharePrintAreaAsImage } from './printImage'

/**
 * Renders the print markup and opens the print dialog in the same task as the
 * originating click. Browsers only allow window.print() while the user
 * activation from the click is still alive; deferring the call with a timer
 * drops that activation and makes some browsers show a
 * "This web page is trying to print" confirmation first.
 *
 * Android Chrome refuses to print at all while the PWA runs standalone, so on
 * that platform the receipt is shared/saved as an image instead.
 */
export function printWithContent(renderPrintContent, options = {}) {
  if (typeof window === 'undefined') return

  if (typeof renderPrintContent === 'function') {
    flushSync(renderPrintContent)
  }

  if (isPrintDialogBlocked()) {
    shareAsImageFallback(options)
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

function shareAsImageFallback({ fileName, title, onStatus } = {}) {
  const notify = typeof onStatus === 'function'
    ? onStatus
    : (message) => { if (message) window.alert(message) }

  sharePrintAreaAsImage({
    fileName: fileName || `receipt-${new Date().toISOString().slice(0, 10)}.png`,
    title: title || 'Receipt',
  })
    .then((result) => {
      if (result.status === 'downloaded') {
        notify('The installed app cannot open a print dialog. The receipt was saved as an image you can print or send to your printer app.')
      } else if (result.status === 'empty') {
        notify('Nothing to print yet.')
      }
    })
    .catch((error) => {
      notify(`Could not prepare the receipt image: ${error.message}`)
    })
}
