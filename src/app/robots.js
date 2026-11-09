// The back-office (billing, customers, reports, settings, superadmin) is
// private business data and must never be crawled or indexed. Only the public
// storefront under /store/:slug is open to search engines.
//
// robots.txt is advisory only — the enforceable `X-Robots-Tag: noindex` header
// in next.config.mjs is what actually keeps these routes out of indexes.
export default function robots() {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/store/'],
        disallow: '/',
      },
    ],
  }
}
