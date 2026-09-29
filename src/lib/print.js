import { flushSync } from "react-dom";

export function printWithContent(renderPrintContent) {
    if (typeof window === 'undefined') return

    if (typeof renderPrintContent === 'function') {
        flushSync(renderPrintContent)
    }

    const pendingImages = Array.from(
        document.querySelectorAll('.print-only img, .thermal-receipt img, .invoice img')
    ).filter((img) => !img.complete)

    if(pendingImages.length === 0) {
        window.print()
        return
    }

    Promise.all(
        pendingImages.map(
            (img) =>
                new Promise((resolve) => {
                    img.addEventListener('load', resolve, {once:true})
                    img.addEventListener('error', resolve, {once:true})
                })
        )
    ).then(() => window.print())
}