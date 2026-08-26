import './globals.css'
import { ShopProvider } from '@/context/ShopContext'
import { PageLoadingProvider } from '@/context/PageLoadingContext'
import AppShell from '@/components/AppShell'
import PwaBootstrap from '@/components/PwaBootstrap'

export const metadata = {
  title: 'GST Billing',
  description: 'Keyboard-first GST billing for grocery stores',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.svg',
  },
}

export const viewport = {
  themeColor: '#0f172a',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 antialiased">
        <ShopProvider>
          <PageLoadingProvider>
            <PwaBootstrap />
            <AppShell>{children}</AppShell>
          </PageLoadingProvider>
        </ShopProvider>
      </body>
    </html>
  )
}
