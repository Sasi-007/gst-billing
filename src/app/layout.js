import { Inter } from 'next/font/google'
import './globals.css'
import Sidebar from '../components/Sidebar'
import { ShopProvider } from '../context/ShopContext'

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
          {/* Desktop: sidebar + main  |  Mobile: full-width + bottom nav */}
          <div className="flex h-screen overflow-hidden no-print">
            <Sidebar />
            {/* pb-16 reserves space for mobile bottom nav */}
            <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
              {children}
            </main>
          </div>
        </ShopProvider>
      </body>
    </html>
  )
}
