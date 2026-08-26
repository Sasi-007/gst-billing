export const metadata = {
  title: 'Offline mode',
}

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-16">
      <div className="w-full rounded-2xl border bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">GST Billing</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">You are offline</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          The app shell is available, and any saved bills will sync once internet comes back.
          If you already opened pages before, they may still load from cache.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Try Home
        </a>
      </div>
    </main>
  )
}
