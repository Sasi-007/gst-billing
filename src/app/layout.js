import { Inter } from 'next/font/google'
import './globals.css'
import { ShopProvider } from '@/context/ShopContext'
import AppShell from '@/components/AppShell'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'GST Billing',
  description: 'Keyboard-first GST billing for grocery stores',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-50`}>
        <ShopProvider>
          <AppShell>{children}</AppShell>
        </ShopProvider>
      </body>
    </html>
  )
}
