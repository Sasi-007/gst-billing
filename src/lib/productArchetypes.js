/**
 * Purchase archetypes — how many units of a given kind of product a real
 * customer actually walks out with.
 *
 * A counter bill looks fake when every line carries the same quantity, or when
 * quantities ignore what the item is: nobody buys 10 bags of atta, nobody buys
 * a single ₹1 toffee, and nobody buys 30 packets of chips. Each archetype
 * therefore carries a realistic [min, max] purchase range plus a hard ceiling
 * that even a large bill may not exceed.
 *
 * Classification order (first confident hit wins):
 *   1. product name / brand keywords   — most specific, works without setup
 *   2. the shop's category name        — only if the keywords found nothing
 *   3. unit of measure                 — loose/weighed goods
 *   4. price band                      — last-resort fallback
 */

// min  — fewest units that still looks like a deliberate purchase
// max  — typical upper end of a normal basket
// ceil — absolute limit, used when a large target stretches quantities
export const ARCHETYPES = {
  staple_bulk:   { min: 1, max: 2,  ceil: 3 },
  edible_oil:    { min: 1, max: 2,  ceil: 3 },
  dairy:         { min: 1, max: 3,  ceil: 5 },
  bakery:        { min: 1, max: 2,  ceil: 3 },
  beverage_pack: { min: 1, max: 2,  ceil: 4 },
  spice_pack:    { min: 1, max: 3,  ceil: 5 },
  snack:         { min: 2, max: 5,  ceil: 10 },
  confectionery: { min: 4, max: 10, ceil: 25 },
  personal_care: { min: 1, max: 2,  ceil: 4 },
  household:     { min: 1, max: 2,  ceil: 4 },
  sachet:        { min: 3, max: 6,  ceil: 15 },
  weighed:       { min: 1, max: 3,  ceil: 5 },
  general:       { min: 1, max: 3,  ceil: 6 },
}

// Keyword groups per archetype, matched in order. Every term is word-anchored
// when the regex is built, so "TUR" can never match inside "NATURAL".
const NAME_KEYWORDS = [
  // Brand names that read like another category are matched first.
  ['confectionery', [
    'DAIRY MILK', 'MILKYBAR', 'KITKAT', 'KIT KAT', 'FIVE STAR', 'MUNCH', 'PERK',
    'GEMS', 'ECLAIR', 'ECLAIRS', 'TOFFEE', 'CANDY', 'LOLLIPOP', 'CHOCOLATE',
    'CHOCLATE', 'CHOCO', 'MINT', 'CHEWING GUM', 'BUBBLE GUM', 'MANGO BITE',
    'ALPENLIEBE', 'CENTER FRESH', 'POPPINS', 'RAVALGAON',
  ]],
  ['household', [
    'DETERGENT', 'SURF', 'SURF EXCEL', 'RIN', 'ARIEL', 'TIDE', 'WHEEL', 'NIRMA',
    'WASHING POWDER', 'WASHING BAR', 'UJALA', 'ROBIN BLUE', 'VIM', 'EXO', 'PRIL',
    'DISHWASH', 'DISH WASH', 'LIZOL', 'HARPIC', 'PHENYL', 'COLIN', 'DOMEX',
    'TOILET CLEANER', 'FLOOR CLEANER', 'ODONIL', 'AIR FRESHENER', 'MOSQUITO',
    'GOODKNIGHT', 'GOOD KNIGHT', 'ALLOUT', 'ALL OUT', 'AGARBATTI',
    'INCENSE', 'CAMPHOR', 'KARPOORAM', 'MATCH BOX', 'MATCHBOX', 'CANDLE',
    'GARBAGE BAG', 'DUSTBIN BAG', 'FOIL', 'BROOM', 'SCRUBBER', 'SCRUB PAD',
    'TISSUE', 'NAPKIN ROLL',
  ]],
  ['personal_care', [
    'TOOTHPASTE', 'TOOTH PASTE', 'COLGATE', 'CLOSEUP', 'CLOSE UP', 'PEPSODENT',
    'DABUR RED', 'TOOTHBRUSH', 'TOOTH BRUSH', 'TOOTH POWDER', 'SOAP', 'LIFEBUOY',
    'LUX', 'DOVE', 'MEDIMIX', 'HAMAM', 'MYSORE SANDAL', 'CINTHOL', 'SANTOOR',
    'PEARS', 'SHAMPOO', 'CLINIC PLUS', 'HEAD SHOULDERS', 'CHIK', 'CONDITIONER',
    'HAIR OIL', 'PARACHUTE', 'NAVARATNA', 'TALC', 'TALCUM', 'PONDS', 'NIVEA',
    'VASELINE', 'FAIR LOVELY', 'LOTION', 'FACE WASH', 'FACEWASH',
    'DEO', 'DEODORANT', 'PERFUME', 'RAZOR', 'SHAVING', 'GILLETTE', 'SANITARY',
    'WHISPER', 'STAYFREE', 'SOFY', 'DIAPER', 'PAMPERS', 'HANDWASH', 'HAND WASH',
    'SANITIZER', 'KAJAL', 'BINDI', 'KUMKUM', 'HAIR DYE', 'HENNA', 'MEHANDI',
  ]],
  ['edible_oil', [
    'OIL', 'REFINED OIL', 'SUNFLOWER OIL', 'GINGELLY OIL', 'SESAME OIL',
    'GROUNDNUT OIL', 'MUSTARD OIL', 'COCONUT OIL', 'PALM OIL', 'RICE BRAN OIL',
    'OLIVE OIL', 'VANASPATHI', 'VANASPATI', 'DALDA',
  ]],
  ['dairy', [
    'GHEE', 'BUTTER', 'PANEER', 'CHEESE', 'CURD', 'YOGHURT', 'YOGURT', 'DAHI',
    'MILK', 'AAVIN', 'AMUL', 'MILKMAID', 'CONDENSED MILK', 'LASSI',
    'BUTTERMILK', 'KOVA', 'KHOYA', 'ICE CREAM', 'ICECREAM',
  ]],
  ['beverage_pack', [
    '3ROSES', '3 ROSES', 'THREE ROSES', 'RED LABEL', 'TAJ MAHAL', 'TATA TEA',
    'BROOKE BOND', 'TEA', 'TEA DUST', 'CHAI', 'COFFEE', 'BRU', 'NESCAFE',
    'SUNRISE', 'BOOST', 'HORLICKS', 'COMPLAN', 'BOURNVITA', 'JUICE', 'COLA',
    'PEPSI', 'COKE', 'COCA COLA', 'SPRITE', 'FANTA', 'THUMS UP', 'FROOTI',
    'MAAZA', 'SLICE', 'APPY', 'SOFT DRINK', 'MINERAL WATER', 'WATER BOTTLE',
    'ENERGY DRINK', 'GLUCON', 'GLUCOSE D',
  ]],
  ['snack', [
    'CHIPS', 'KURKURE', 'LAYS', 'BINGO', 'MIXTURE', 'MURUKKU', 'MURUKU',
    'SEV', 'NAMKEEN', 'BHUJIA', 'SNACK', 'BISCUIT', 'BISKET', 'COOKIE',
    'COOKIES', 'MARIE', 'MARIE GOLD', 'GOOD DAY', 'BOURBON', 'HIDE SEEK',
    'KRACK JACK', 'PARLE', 'PARLE G', 'OREO', 'MONACO', 'TIGER', 'NICE TIME',
    'WAFER', 'POPCORN', 'CORN FLAKES', 'CORNFLAKES', 'BADAM', 'CASHEW',
    'KAJU', 'PEANUT', 'KADALAI', 'DRY FRUIT', 'DRYFRUITS', 'NUTS',
  ]],
  ['staple_bulk', [
    'ATTA', 'MAIDA', 'SOOJI', 'SUJI', 'RAVA', 'BESAN', 'FLOUR', 'MAAVU',
    'RICE', 'ARISI', 'SONA MASOORI', 'PONNI', 'IDLY RICE', 'IDLI RAVA',
    'BASMATI', 'BIRYANI RICE', 'DAL', 'DHALL', 'DHAL', 'PARUPPU', 'TOOR',
    'TUR', 'URAD', 'MOONG', 'CHANA', 'RAJMA', 'LENTIL',
    'SUGAR', 'JAGGERY', 'VELLAM', 'SALT', 'UPPU', 'POHA', 'AVAL',
    'VERMICELLI', 'SEMIYA', 'SABUDANA', 'JAVVARISI', 'OATS', 'SOYA CHUNK',
  ]],
  ['bakery', ['BREAD', 'BUN', 'PAV', 'RUSK', 'CAKE', 'PASTRY', 'CROISSANT', 'MUFFIN']],
  ['spice_pack', [
    'MASALA', 'SAMBAR POWDER', 'RASAM POWDER', 'RASAM', 'TURMERIC', 'MANJAL',
    'CHILLI POWDER', 'MILAGAI', 'CORIANDER', 'DHANIA', 'CUMIN', 'JEERA',
    'MUSTARD', 'KADUGU', 'PEPPER', 'MILAGU', 'GARAM MASALA', 'BIRYANI MASALA',
    'ASAFOETIDA', 'HING', 'PERUNGAYAM', 'PICKLE', 'OORUGAI', 'PAYASAM MIX',
    'IDLI PODI', 'PODI', 'VATHAL', 'VADAGAM', 'APPALAM', 'PAPAD', 'SAUCE',
    'KETCHUP', 'JAM', 'HONEY', 'NOODLES', 'MAGGI', 'PASTA', 'SOUP',
  ]],
]

// Shop-defined category names mapped onto the same archetypes.
const CATEGORY_KEYWORDS = [
  ['staple_bulk',   ['STAPLE', 'STAPLES', 'GROCERY', 'GROCERIES', 'PROVISION', 'PROVISIONS', 'RICE', 'FLOUR', 'ATTA', 'PULSE', 'PULSES', 'DAL', 'GRAIN', 'GRAINS', 'CEREAL', 'CEREALS']],
  ['edible_oil',    ['OIL', 'OILS', 'EDIBLE OIL', 'GHEE']],
  ['dairy',         ['DAIRY', 'MILK', 'FROZEN']],
  ['bakery',        ['BAKERY', 'BREAD']],
  ['beverage_pack', ['BEVERAGE', 'BEVERAGES', 'DRINK', 'DRINKS', 'TEA', 'COFFEE', 'JUICE']],
  ['spice_pack',    ['SPICE', 'SPICES', 'MASALA', 'MASALAS', 'CONDIMENT', 'CONDIMENTS', 'PICKLE', 'INSTANT FOOD']],
  ['confectionery', ['CONFECTIONERY', 'CONFECTIONARY', 'CHOCOLATE', 'CHOCOLATES', 'CANDY', 'SWEETS']],
  ['snack',         ['SNACK', 'SNACKS', 'BISCUIT', 'BISCUITS', 'NAMKEEN', 'CHIPS']],
  ['personal_care', ['PERSONAL CARE', 'PERSONAL', 'COSMETIC', 'COSMETICS', 'BEAUTY', 'HYGIENE', 'BABY CARE', 'BABY']],
  ['household',     ['HOUSEHOLD', 'HOME CARE', 'CLEANING', 'CLEANER', 'CLEANERS', 'DETERGENT', 'UTILITY', 'UTILITIES', 'POOJA']],
]

function buildMatchers(groups) {
  return groups.map(([key, terms]) => {
    const alternatives = terms
      .map((term) => term.replace(/[^A-Z0-9 ]/g, '').replace(/ +/g, '\\s*'))
      .sort((a, b) => b.length - a.length)
      .join('|')
    return [key, new RegExp(`\\b(?:${alternatives})\\b`)]
  })
}

const NAME_RULES = buildMatchers(NAME_KEYWORDS)
const CATEGORY_RULES = buildMatchers(CATEGORY_KEYWORDS)

// Units that mean the line quantity is a weight/volume, not a pack count.
const WEIGHED_UNITS = /^(?:KG|KGS|G|GM|GMS|GRAM|GRAMS|L|LTR|LITRE|LITER|ML)$/

function normalise(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

function categoryName(product) {
  // Supabase returns the embedded relation as an object or a single-item array.
  const cat = product?.categories
  if (Array.isArray(cat)) return cat[0]?.name || ''
  return cat?.name || product?.category_name || ''
}

/** Classify a product into a purchase archetype key. */
export function classifyProduct(product, rate) {
  const tags = Array.isArray(product?.tags) ? product.tags.join(' ') : ''
  const haystack = normalise(`${product?.brand || ''} ${product?.name || ''} ${tags}`)

  for (const [key, pattern] of NAME_RULES) {
    if (pattern.test(haystack)) return key
  }

  const category = normalise(categoryName(product))
  if (category) {
    for (const [key, pattern] of CATEGORY_RULES) {
      if (pattern.test(category)) return key
    }
  }

  if (WEIGHED_UNITS.test(normalise(product?.unit))) return 'weighed'

  // Price is the weakest signal, so it only runs when nothing else matched.
  const price = Number(rate) || 0
  if (price > 0 && price <= 10) return 'sachet'
  if (price >= 150) return 'staple_bulk'
  return 'general'
}

/**
 * Realistic [min, max] units for one bill line.
 *
 * `stretch`  — the target cannot be reached otherwise, so quantities grow.
 * `pressure` — 0..1, how badly overstocked this item is. Deep stock rides the
 *              upper half of its own band (and up to the archetype ceiling) so
 *              it clears faster, but it can never exceed that ceiling: a
 *              warehouse full of toffee still only sells a handful at a time.
 *
 * Every archetype keeps a hard ceiling so the bill never shows thirty packets
 * of chips or three sacks of rice.
 */
export function qtyRangeFor(product, rate, { stretch = 1, pressure = 0 } = {}) {
  const key = classifyProduct(product, rate)
  const band = ARCHETYPES[key] || ARCHETYPES.general
  const price = Number(rate) || 0

  // A rupee-priced item is a sachet/strip buy whatever shelf it sits on.
  const effective = price > 0 && price <= 5 && band.max < ARCHETYPES.sachet.max
    ? ARCHETYPES.sachet
    : band

  // Expensive items stay near single units no matter what the archetype says.
  const priceCeiling = price >= 400 ? 1 : price >= 200 ? 2 : price >= 100 ? 3 : Infinity

  const ceiling = Math.max(1, Math.min(effective.ceil, priceCeiling))
  const push = Math.max(0, Math.min(1, pressure))

  // Overstocked items lean toward the ceiling; normal items keep their band.
  const naturalMax = effective.max + (effective.ceil - effective.max) * push
  const min = Math.max(1, Math.min(Math.round(effective.min + (effective.max - effective.min) * push * 0.5), ceiling))
  const max = Math.max(min, Math.min(Math.round(naturalMax * Math.max(1, stretch)), ceiling))

  return { key, min, max }
}
