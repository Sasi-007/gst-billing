'use client'

export default function LoadingPlaceholder({
  label = 'Loading',
  rows = 3,
  fullPage = false,
}) {
  return (
    <div className={`${fullPage ? 'min-h-[240px]' : ''} flex items-center justify-center`}>
      <div className="w-full max-w-2xl rounded-xl border bg-white p-6">
        <div className="mb-4">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
            <div className="h-full w-2/5 rounded-full bg-blue-600 animate-pulse" />
          </div>
          <div className="mt-2 text-center text-sm text-gray-400">{label}…</div>
        </div>
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, index) => (
            <div key={index} className="space-y-2">
              <div className={`h-3 rounded bg-gray-100 animate-pulse ${index % 2 === 0 ? 'w-3/4' : 'w-1/2'}`} />
              <div className="h-10 rounded-lg bg-gray-100 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
