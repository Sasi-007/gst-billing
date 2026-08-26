export default function manifest() {
  return {
    name: 'GST Billing',
    short_name: 'GST Billing',
    description: 'Keyboard-first GST billing for grocery stores',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#0f172a',
    icons: [
      {
        src: '/icon.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
  }
}
