/**
 * Registry backing the global command bar. Each entry carries plenty of
 * synonyms so shop staff can type what they mean ("add purchase", "new bill",
 * "estimate", "gst") instead of remembering page names.
 */

export const COMMANDS = [
  // ── Create ──────────────────────────────────────────────────
  {
    id: 'new-invoice',
    label: 'New Invoice / Bill',
    hint: 'Start billing a customer',
    href: '/billing',
    icon: '🧾',
    group: 'Create',
    keywords: ['add invoice', 'new invoice', 'create invoice', 'add bill', 'new bill', 'create bill', 'billing', 'sale', 'sell', 'pos', 'counter', 'invoice'],
  },
  {
    id: 'new-estimate',
    label: 'New Estimate / Quotation',
    hint: 'Create a quotation for a customer',
    href: '/quotation',
    icon: '📄',
    group: 'Create',
    keywords: ['add estimate', 'new estimate', 'create estimate', 'estimate', 'quotation', 'quote', 'add quotation', 'new quote', 'proforma'],
  },
  {
    id: 'new-purchase',
    label: 'Add Purchase Bill',
    hint: 'Record stock bought from a supplier',
    href: '/purchases/new',
    icon: '🛒',
    group: 'Create',
    keywords: ['add purchase', 'new purchase', 'create purchase', 'purchase entry', 'purchase bill', 'buy', 'inward', 'grn', 'stock in', 'supplier bill'],
  },
  {
    id: 'new-product',
    label: 'Add Product to Inventory',
    hint: 'Create a new inventory item',
    href: '/inventory/new',
    icon: '📦',
    group: 'Create',
    keywords: ['add inventory', 'add product', 'new product', 'create product', 'add item', 'new item', 'add stock item', 'new sku', 'product master'],
  },
  {
    id: 'new-customer',
    label: 'Add Customer',
    hint: 'Create a customer record',
    href: '/customers',
    icon: '👥',
    group: 'Create',
    keywords: ['add customer', 'new customer', 'create customer', 'party', 'buyer', 'client'],
  },
  {
    id: 'new-supplier',
    label: 'Add Supplier',
    hint: 'Create a supplier record',
    href: '/suppliers',
    icon: '🏪',
    group: 'Create',
    keywords: ['add supplier', 'new supplier', 'create supplier', 'vendor', 'add vendor', 'distributor'],
  },
  {
    id: 'new-expense',
    label: 'Add Expense',
    hint: 'Record a shop expense',
    href: '/expenses',
    icon: '💸',
    group: 'Create',
    keywords: ['add expense', 'new expense', 'spending', 'cost', 'bill payment', 'rent', 'salary'],
  },
  {
    id: 'new-category',
    label: 'Add Category',
    hint: 'Manage product categories',
    href: '/categories',
    icon: '🏷️',
    group: 'Create',
    keywords: ['add category', 'new category', 'categories', 'group', 'department'],
  },

  // ── Find ────────────────────────────────────────────────────
  {
    id: 'search-invoice',
    label: 'Search Invoices / Invoice History',
    hint: 'Find a past bill by number or customer',
    href: '/billing?view=history',
    icon: '🗂️',
    group: 'Find',
    keywords: ['search invoice', 'find invoice', 'invoice history', 'bill history', 'past bills', 'old bill', 'previous invoice', 'reprint', 'duplicate bill', 'sales history'],
  },
  {
    id: 'search-purchase',
    label: 'Search Purchases',
    hint: 'Find a purchase bill',
    href: '/purchases',
    icon: '🛒',
    group: 'Find',
    keywords: ['search purchase', 'find purchase', 'purchase history', 'purchase list', 'supplier bills', 'inward history'],
  },
  {
    id: 'search-product',
    label: 'Search Inventory / Stock',
    hint: 'Look up products and stock levels',
    href: '/inventory',
    icon: '📦',
    group: 'Find',
    keywords: ['search product', 'find product', 'search inventory', 'stock', 'stock list', 'items', 'products', 'search item', 'inventory'],
  },
  {
    id: 'price-check',
    label: 'Price Check',
    hint: 'Scan or search for a selling price',
    href: '/price-check',
    icon: '💰',
    group: 'Find',
    keywords: ['price check', 'price', 'rate', 'mrp', 'scan price', 'barcode check', 'check rate'],
  },
  {
    id: 'search-customer',
    label: 'Search Customers',
    hint: 'Find a customer',
    href: '/customers',
    icon: '👥',
    group: 'Find',
    keywords: ['search customer', 'find customer', 'customer list', 'customers'],
  },
  {
    id: 'search-supplier',
    label: 'Search Suppliers',
    hint: 'Find a supplier and their purchase summary',
    href: '/suppliers',
    icon: '🏪',
    group: 'Find',
    keywords: ['search supplier', 'find supplier', 'supplier list', 'supplier', 'suppliers', 'vendor', 'vendors', 'supplier summary', 'supplier wise purchase', 'party wise'],
  },

  // ── Reports ─────────────────────────────────────────────────
  {
    id: 'gst-summary',
    label: 'GST Summary',
    hint: 'Output vs input GST by rate',
    href: '/reports?tab=gst',
    icon: '🧾',
    group: 'Reports',
    keywords: ['gst', 'gst summary', 'gst report', 'tax report', 'tax summary', 'output tax', 'input tax', 'itc', 'gstr', 'gst filing'],
  },
  {
    id: 'gst-auditor',
    label: 'GST Auditor Report',
    hint: 'Detailed GST workings for your auditor',
    href: '/reports?tab=auditor',
    icon: '📋',
    group: 'Reports',
    keywords: ['gst auditor', 'auditor', 'audit', 'gst audit', 'ca report', 'tax audit', 'gstr1', 'gstr 3b'],
  },
  {
    id: 'sales-report',
    label: 'Sales Report',
    hint: 'Sales totals for a date range',
    href: '/reports?tab=sales',
    icon: '📈',
    group: 'Reports',
    keywords: ['sales report', 'sales', 'revenue', 'turnover', 'daily sales', 'monthly sales'],
  },
  {
    id: 'purchase-report',
    label: 'Purchase Report',
    hint: 'Purchase totals for a date range',
    href: '/reports?tab=purchases',
    icon: '📊',
    group: 'Reports',
    keywords: ['purchase report', 'purchase summary', 'buying report', 'inward report'],
  },
  {
    id: 'stock-check',
    label: 'Stock Check / Reconciliation',
    hint: 'Compare recorded stock against movement',
    href: '/reports?tab=stockcheck',
    icon: '🧮',
    group: 'Reports',
    keywords: ['stock check', 'stock reconciliation', 'stock audit', 'physical stock', 'stock verify', 'shortage'],
  },
  {
    id: 'top-products',
    label: 'Top Products',
    hint: 'Best selling items',
    href: '/reports?tab=topproducts',
    icon: '🏆',
    group: 'Reports',
    keywords: ['top products', 'best selling', 'fast moving', 'top items', 'popular'],
  },
  {
    id: 'credit-report',
    label: 'Credit Report',
    hint: 'Outstanding customer credit',
    href: '/reports?tab=credits',
    icon: '📒',
    group: 'Reports',
    keywords: ['credit report', 'outstanding report', 'receivables', 'due report'],
  },
  {
    id: 'invoice-pack',
    label: 'Invoice Pack (bulk print)',
    hint: 'Print many invoices at once',
    href: '/reports/invoice-pack',
    icon: '🖨️',
    group: 'Reports',
    keywords: ['invoice pack', 'bulk print', 'print invoices', 'batch print', 'print many bills'],
  },
  {
    id: 'summary',
    label: 'Business Summary',
    hint: 'Profit, cash and overall position',
    href: '/summary',
    icon: '🧮',
    group: 'Reports',
    keywords: ['summary', 'profit', 'p&l', 'profit and loss', 'overview', 'business summary', 'net profit'],
  },

  // ── Money ───────────────────────────────────────────────────
  {
    id: 'credit-book',
    label: 'Credit Book',
    hint: 'Customer credit and settlements',
    href: '/credits',
    icon: '📒',
    group: 'Money',
    keywords: ['credit', 'credit book', 'udhar', 'khata', 'due', 'outstanding', 'pending payment', 'receivable'],
  },
  {
    id: 'banking',
    label: 'Banking',
    hint: 'Bank accounts and ledger',
    href: '/banking',
    icon: '🏛️',
    group: 'Money',
    keywords: ['bank', 'banking', 'account', 'ledger', 'cash book', 'deposit', 'withdraw'],
  },
  {
    id: 'expenses',
    label: 'Expenses',
    hint: 'All recorded expenses',
    href: '/expenses',
    icon: '💸',
    group: 'Money',
    keywords: ['expenses', 'expense list', 'spending', 'outgoing'],
  },
  {
    id: 'investments',
    label: 'Investments',
    hint: 'Capital put into the business',
    href: '/investments',
    icon: '🏦',
    group: 'Money',
    keywords: ['investment', 'investments', 'capital', 'funding', 'owner capital'],
  },
  {
    id: 'drawings',
    label: 'Drawings',
    hint: 'Money taken out by the owner',
    href: '/drawings',
    icon: '↗️',
    group: 'Money',
    keywords: ['drawings', 'withdrawal', 'owner drawings', 'personal use'],
  },

  // ── Manage ──────────────────────────────────────────────────
  {
    id: 'dashboard',
    label: 'Dashboard',
    hint: 'Today at a glance',
    href: '/',
    icon: '📊',
    group: 'Manage',
    keywords: ['dashboard', 'home', 'start', 'overview', 'today'],
  },
  {
    id: 'online-store',
    label: 'Online Store',
    hint: 'Manage your public storefront',
    href: '/online',
    icon: '🌐',
    group: 'Manage',
    keywords: ['online store', 'online', 'ecommerce', 'storefront', 'web store', 'catalogue'],
  },
  {
    id: 'invoice-numbers',
    label: 'Invoice Numbering',
    hint: 'Fix or change invoice number series',
    href: '/billing/invoice-number-updater',
    icon: '🔢',
    group: 'Manage',
    keywords: ['invoice number', 'bill number', 'numbering', 'series', 'prefix', 'renumber'],
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'Shop details, GSTIN, printing',
    href: '/settings',
    icon: '⚙️',
    group: 'Manage',
    keywords: ['settings', 'preferences', 'configuration', 'shop details', 'gstin', 'logo', 'print settings', 'profile'],
  },
]

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Scores a command against the query. Higher is better, 0 means no match.
 * Matching is token based so "purchase add" finds "Add Purchase Bill" too.
 */
function scoreCommand(command, query) {
  const haystacks = [normalize(command.label), ...command.keywords.map(normalize)]
  const tokens = query.split(' ').filter(Boolean)
  if (!tokens.length) return 0

  let best = 0
  for (const haystack of haystacks) {
    if (haystack === query) { best = Math.max(best, 1000); continue }
    if (haystack.startsWith(query)) { best = Math.max(best, 800); continue }
    if (haystack.includes(query)) { best = Math.max(best, 600); continue }

    // Every token must appear somewhere for a partial match to count.
    const everyToken = tokens.every((token) => haystack.includes(token))
    if (everyToken) {
      const starts = tokens.filter((token) => haystack.startsWith(token)).length
      best = Math.max(best, 300 + starts * 20)
    }
  }

  if (best) return best

  // Last resort: match tokens across the whole keyword set, so a query like
  // "purchase report" still resolves when the words live in different entries.
  const combined = haystacks.join(' ')
  if (tokens.every((token) => combined.includes(token))) return 150
  return 0
}

export function searchCommands(rawQuery, limit = 12) {
  const query = normalize(rawQuery)
  if (!query) {
    return COMMANDS.filter((command) => ['new-invoice', 'new-purchase', 'new-product', 'search-invoice', 'gst-summary', 'price-check', 'credit-book', 'search-supplier'].includes(command.id))
  }

  return COMMANDS
    .map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .slice(0, limit)
    .map((entry) => entry.command)
}
