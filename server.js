/**
 * WAO Burgers — Meta Shops website-checkout endpoint.
 *
 * Meta (Facebook/Instagram Shops) redirects the buyer here with a GET request:
 *   /checkout?products=<productId>:<qty>,<productId>:<qty>&coupon=<code>
 *             &fbclid=...&cart_origin=facebook|instagram|meta_shops&utm_...=...
 *
 * `products` is URL-encoded, e.g. products=12345%3A3%2C23456%3A1
 * (12345:3, 23456:1). Product IDs are the Meta catalog content IDs, but this
 * endpoint also accepts the catalog retailer_id / SKU (e.g. MOON-CHEESE-BURGER).
 *
 * Flow:
 *   1. Parse and resolve the cart against meta-to-square-mapping.json.
 *   2. The customer picks the same options as on waoburger.com on the
 *      summary page. Modifier sets VARY BY PRODUCT (see PRODUCT_CONFIGS
 *      below — full 31-product audit, menu-audit-2026-11-17.md, verified
 *      live 2026-11-17 ~20:09–20:14 EST, Pickup ZIP 18052, Whitehall).
 *      Selections travel as m<index>_<group> query params, so a
 *      link can also carry them pre-filled; free sauce defaults to RANCH and
 *      link can also carry them pre-filled; free sauce defaults to RANCH and
 *      free soda to WATER where those selectors exist; protein/flavor
 *      dropdowns have no default ("Select one").
 *   3. If SQUARE_ACCESS_TOKEN is set, createSquareCheckout() builds a real
 *      Square checkout (Payment Links API) and we 302 to Square, so the
 *      customer pays directly in Square with the items already in the cart.
 *      Any Square error falls back to the summary page (step 4).
 *   4. Otherwise render a guest checkout-summary page (no login required)
 *      with a "Pay on waoburger.com" button. Square Online's /s/order page
 *      has no multi-item deep link, so the button goes to the order page
 *      and the summary shows the customer exactly what to add.
 *
 * Zero dependencies — plain Node.js http. Run:  node server.js
 * Env: PORT (default 3000), SQUARE_ACCESS_TOKEN (optional, enables step 3),
 * SQUARE_LOCATION_ID (optional — auto-detected from Square otherwise).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ORDER_PAGE = 'https://www.waoburger.com/s/order';

// ---------------------------------------------------------------------------
// Mapping: Meta product ID / retailer_id -> product + Square order link.
// ---------------------------------------------------------------------------
// Serverless wrappers (Netlify) may run from a bundle where the JSON file
// isn't on disk; they can inject the parsed mapping via
// global.__WAO_MAPPING__ before requiring this module. Otherwise read it
// from disk as usual.
const mapping = global.__WAO_MAPPING__ || JSON.parse(
  fs.readFileSync(path.join(__dirname, 'meta-to-square-mapping.json'), 'utf8')
);

const byMetaId = new Map();
const bySku = new Map();
for (const p of mapping.products) {
  byMetaId.set(String(p.meta_product_id), p);
  bySku.set(String(p.retailer_id).toUpperCase(), p);
}

function lookupProduct(id) {
  if (byMetaId.has(id)) return byMetaId.get(id);
  return bySku.get(String(id).toUpperCase()) || null;
}

// ---------------------------------------------------------------------------
// Modifiers — exactly as on waoburger.com (verified live 2026-11-17
// ~20:02–20:07 EST, Pickup ZIP 18052, Whitehall). Modifier sets VARY BY
// PRODUCT; PRODUCT_CONFIGS below is the per-product map.
//
// Shared option lists:
//   SAUCES  — 18, free, default RANCH ("Choose Your Favorite Sauce")
//   SODAS   — 14, free, default WATER ("Choose Your Favorite Soda")
//   PROTEINS (free protein dropdown, no default) — EGG, BEEF, PORK, SHRIMP,
//             CHICKEN, PEPPERONI, MUSHROOM
//   EXTRA_MEAT — same 7 proteins, priced: EGG $1.50, BEEF/PORK/SHRIMP/
//             CHICKEN $3.50, PEPPERONI/MUSHROOM $1.50
//   EXTRAS ("Additional Features", 33) — see prices below
//   CRAZY_FRIES — "Convert Fries to Crazy Fries", $7.33 per protein.
//             The site spells it "Comvert-Fries"; we use the correct
//             spelling here.
// Per-product notes:
//   Canned Sodas: required soda dropdown only (14, free).
//   Snapple: optional "SNAPPLE CHOICES" +$2.00 (APPLE, MANGO, KIWI
//             STRAWBERRY). Fruit Punch is named in the description but has
//             NO checkbox — do not invent it.
//   Jarritos: required flavor dropdown, free, no default (GUAVA, LEMON,
//             TAMARIND, MANDARIN, PINEAPPLE).
//   Orange Juice Tropicana: no selectors at all.
//   Cheese Fries: optional "Sodas & More" +$1.00 each (14 sodas) +
//             required free sauce (18). No Extra Meat, no Additional
//             Features, no Convert-Fries.
//   Crazy Fries: required free protein + required free soda + optional
//             Extra Meat + optional Additional Features. NO sauce dropdown,
//             NO Convert-Fries.
//   Chicken Wings / Chicken Nuggets: required free sauce + soda, optional
//             Extra Meat, Additional Features, Convert-Fries.
//   Chimi Burger: required free sauce + soda, required free protein,
//             optional Extra Meat, Additional Features, Convert-Fries.
//   Moon / Double Bacon Cheese Burger and the other 11 burgers (Bacon
//             Cheese $12, Egg, BBQ, Shrimp, Bourbon, Fries Cheese, Salmon,
//             Justin, Jamaican, Buffalo, Mushroom): required free sauce +
//             soda, optional Additional Features, Convert-Fries. No protein,
//             no Extra Meat — each is an EXPLICIT config now (no reliance on
//             the default).
//   Avocado Burger: Moon template + Extra Meat. No protein selector.
//   Mozzarella Sticks / Chicken Boneless / Wao Cheese Steak / Chopped
//             Cheese: Moon template + Extra Meat.
//   Quesadillas: OPTIONAL tortilla checkboxes, FREE, no default (REGULAR,
//             WHOLE WHEAT, SPINACH HERB, GARLIC HERB) + required free
//             protein + required free sauce + soda + Extra Meat +
//             Additional Features + Convert-Fries.
//   Salchipapas: ONLY required free soda + Extra Meat + Additional
//             Features. NO sauce, NO protein, NO Convert-Fries. Params for
//             groups it doesn't have are ignored.
//   Bacon Cheese Fries: required free sauce + soda + Additional Features
//             + Extra Meat. NO Convert-Fries.
//   Chicken Wrap: REQUIRED tortilla dropdown, FREE, no default (same 4
//             tortillas) + REQUIRED chicken-style dropdown, FREE, default
//             CRISPY (CRISPY, GRILLED) + required free sauce + soda +
//             Additional Features + Convert-Fries. NO Extra Meat.
// Products NOT listed below default to the Moon template (sauce + soda +
// Additional Features + Convert-Fries). After the full audit
// (menu-audit-2026-11-17.md, ~20:09–20:14 EST) every one of the 31
// products is listed explicitly, so the default is only a safety net.
// ---------------------------------------------------------------------------
const SAUCES = [
  'RANCH', 'MAYO-Q', 'KETCHUP', 'BOURBON', 'BBQ SAUCE', 'MAYONNAISE',
  'BLUE CHEESE', 'SOUR CREAM', 'Mayo-KETCHUP', 'SWEET TERiYAKi',
  'MARINARA SAUCE', 'JAMAiCAN JERK', 'BUFFALO SAUCE', 'HONEY Sriracha',
  'GARLIC PARMESAN', 'SWEET & SOUR SAUCE', 'HONEY MUSTARD', 'MANGO HABANERO',
];
const DEFAULT_SAUCE = 'RANCH';

const SODAS = [
  'WATER', 'A&W', 'PEPSI', 'SPRITE', 'GINGER', 'GRAPE', 'ORANGE', 'MTN-DEW',
  'DIET COKE', 'DR PEPPER', 'COCA-COLA', 'PINEAPPLE', 'BRISK LEMON', 'COCONUT',
];
const DEFAULT_SODA = 'WATER';

const PROTEINS = ['EGG', 'BEEF', 'PORK', 'SHRIMP', 'CHICKEN', 'PEPPERONI', 'MUSHROOM'];

const EXTRA_MEAT = [
  { name: 'EGG', price: 1.50 },
  { name: 'BEEF', price: 3.50 },
  { name: 'PORK', price: 3.50 },
  { name: 'SHRIMP', price: 3.50 },
  { name: 'CHICKEN', price: 3.50 },
  { name: 'PEPPERONI', price: 1.50 },
  { name: 'MUSHROOM', price: 1.50 },
];

const SNAPPLE_CHOICES = [
  { name: 'APPLE', price: 2.00 },
  { name: 'MANGO', price: 2.00 },
  { name: 'KIWI STRAWBERRY', price: 2.00 },
];

const JARRITOS_FLAVORS = ['GUAVA', 'LEMON', 'TAMARIND', 'MANDARIN', 'PINEAPPLE'];

// Tortillas — free. Quesadillas: OPTIONAL checkboxes, no default. Chicken
// Wrap: REQUIRED dropdown, no default. Same 4 options on both.
const TORTILLAS = ['REGULAR', 'WHOLE WHEAT', 'SPINACH HERB', 'GARLIC HERB'];
const TORTILLAS_FREE = TORTILLAS.map((name) => ({ name, price: 0 }));

// Chicken Wrap style — free, REQUIRED dropdown, default CRISPY.
const WRAP_STYLES = ['CRISPY', 'GRILLED'];
const DEFAULT_WRAP_STYLE = 'CRISPY';

// "Sodas & More" on Cheese Fries: same 14 sodas, +$1.00 each.
const SODAS_MORE = SODAS.map((name) => ({ name, price: 1.00 }));

// First sauce/soda choice (selectors above) is free. These are EXTRA
// sauces/portions and extra toppings, hence paid.
const EXTRAS = [
  { name: 'SWISS CHEESE', price: 0.75 },
  { name: 'CHEDDAR CHEESE', price: 0.75 },
  { name: 'MUNSTER CHEESE', price: 0.75 },
  { name: 'PROVOLONE CHEESE', price: 0.75 },
  { name: 'MOZARELLA CHEESE', price: 1.00 },
  { name: 'PEPPER JACK CHESSE', price: 0.75 }, // site spelling ("CHESSE")
  { name: 'PICKLES', price: 0.33 },
  { name: 'FRIED CRISPY ONIONS', price: 0.33 },
  { name: 'LETTUCE', price: 0.33 },
  { name: 'MUSHROOM', price: 1.50 },
  { name: 'JALAPEÑOS', price: 0.75 },
  { name: 'BANANA PEPPERS', price: 0.75 },
  { name: 'TURKEY BACON', price: 1.50 },
  { name: 'EGG', price: 1.50 },
  { name: 'EXTRA-FRIES', price: 3.00 },
  { name: 'AVOCADO', price: 1.00 },
  { name: 'RANCH', price: 0.75 },
  { name: 'MAYO-Q', price: 0.75 },
  { name: 'KETCHUP', price: 0.75 },
  { name: 'BOURBON', price: 0.75 },
  { name: 'BBQ SAUCE', price: 0.75 },
  { name: 'MAYONNAISE', price: 0.75 },
  { name: 'SOUR CREAM', price: 0.75 },
  { name: 'MAYO-KETCHUP', price: 0.75 },
  { name: 'BLUE CHEESE', price: 0.75 },
  { name: 'HONEY Sriracha', price: 0.75 },
  { name: 'SWEET TERiYAKi', price: 0.75 },
  { name: 'BUFFALO SAUCE', price: 0.75 },
  { name: 'HONEY MUSTARD', price: 0.75 },
  { name: 'GARLIC PARMESAN', price: 0.75 },
  { name: 'SWEET & SOUR SAUCE', price: 0.75 },
  { name: 'MANGO HABANERO', price: 0.75 },
  { name: 'JAMAICAN JERK SAUCE', price: 0.75 },
];

const CRAZY_FRIES_PRICE = 7.33;

// NOTE: the Convert-Fries protein list (burger pop-ups) is BEEF, CHICKEN,
// SALMON, SHRIMP, EGGS, MUSHROOM, ITALIAN SAUSAGE ($7.33 each). The free
// protein dropdown (Chimi, Crazy Fries) uses a DIFFERENT list: EGG, BEEF,
// PORK, SHRIMP, CHICKEN, PEPPERONI, MUSHROOM. Keep them separate.
const CONVERT_FRIES_PROTEINS = ['BEEF', 'CHICKEN', 'SALMON', 'SHRIMP', 'EGGS', 'MUSHROOM', 'ITALIAN SAUSAGE'];

// Per-product modifier config. Flags: sauce, soda, protein, flavor,
// snapple, sodasMore, extraMeat, extras, crazyFries, tortilla
// ('checkbox' = optional free checkboxes, 'select' = required free
// dropdown, no default), wrapStyle (required free dropdown, default
// CRISPY). Full audit: menu-audit-2026-11-17.md (~20:09–20:14 EST).
// All 31 products are listed explicitly here.
const MOON_CONFIG = { sauce: true, soda: true, extras: true, crazyFries: true };
const MOON_PLUS_MEAT = { sauce: true, soda: true, extraMeat: true, extras: true, crazyFries: true };
const PRODUCT_CONFIGS = {
  // Drinks
  'CANNED-SODAS': { soda: true },
  'SNAPPLE': { snapple: true },
  'JARRITOS': { flavor: true },
  'ORANGE-JUICE': {},
  // Fries & sides
  'CHEESE-FRIES': { sauce: true, sodasMore: true },
  'CRAZY-FRIES': { protein: true, soda: true, extraMeat: true, extras: true },
  'BACON-CHEESE-FRIES': { sauce: true, soda: true, extraMeat: true, extras: true },
  'SALCHIPAPAS': { soda: true, extraMeat: true, extras: true },
  'MOZZARELLA-STICKS': MOON_PLUS_MEAT,
  'CHICKEN-BONELESS': MOON_PLUS_MEAT,
  'CHICKEN-NUGGETS': MOON_PLUS_MEAT,
  'CHICKEN-WINGS': MOON_PLUS_MEAT,
  'WAO-CHEESE-STEAK': MOON_PLUS_MEAT,
  'CHOPPED-CHEESE': MOON_PLUS_MEAT,
  // Burgers — Moon template (explicit)
  'MOON-CHEESE-BURGER': MOON_CONFIG,
  'DOUBLE-BACON-CHEESE-BURGER': MOON_CONFIG,
  'BACON-CHEESE-BURGER': MOON_CONFIG,
  'EGG-BURGER': MOON_CONFIG,
  'BBQ-BURGER': MOON_CONFIG,
  'SHRIMP-BURGER': MOON_CONFIG,
  'BOURBON-BURGER': MOON_CONFIG,
  'FRIES-CHEESE-BURGER': MOON_CONFIG,
  'SALMON-BURGER': MOON_CONFIG,
  'JUSTIN-BURGER': MOON_CONFIG,
  'JAMAICAN-BURGER': MOON_CONFIG,
  'BUFFALO-BURGER': MOON_CONFIG,
  'MUSHROOM-BURGER': MOON_CONFIG,
  // Burgers with extras
  'CHIMI-BURGER': { sauce: true, soda: true, protein: true, extraMeat: true, extras: true, crazyFries: true },
  'AVOCADO-BURGER': MOON_PLUS_MEAT,
  // Wraps & quesadillas
  'QUESADILLAS': { tortilla: 'checkbox', protein: true, sauce: true, soda: true, extraMeat: true, extras: true, crazyFries: true },
  'CHICKEN-WRAP': { tortilla: 'select', wrapStyle: true, sauce: true, soda: true, extras: true, crazyFries: true },
};

function modifierConfig(product) {
  return PRODUCT_CONFIGS[product.retailer_id] || MOON_CONFIG;
}

function normName(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchName(value, list) {
  const n = normName(value);
  if (!n) return null;
  const hit = list.find((x) => normName(typeof x === 'string' ? x : x.name) === n);
  return hit || null;
}

function parsePricedList(raw, list) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const hit = matchName(part, list);
    if (hit && !out.find((e) => e.name === hit.name)) {
      out.push({ name: hit.name, price_usd: hit.price });
    }
  }
  return out;
}

// Parse one line item's modifiers from the query string. `index` is the
// item's position in the cart (m<index>_sauce, m<index>_soda,
// m<index>_protein, m<index>_flavor, m<index>_snapple,
// m<index>_sodasmore, m<index>_extrameat, m<index>_extras,
// m<index>_crazyfries, m<index>_tortilla, m<index>_wrapstyle).
// Missing/invalid sauce or soda fall back to the free defaults
// (RANCH/WATER); protein/flavor/tortilla-dropdown have no default (null =
// "Select one"); wrap style defaults to CRISPY; invalid priced options are
// dropped. Params for groups a product doesn't have are ignored.
function parseModifiers(searchParams, index, product) {
  const cfg = modifierConfig(product);
  const p = `m${index}_`;
  return {
    sauce: cfg.sauce ? (matchName(searchParams.get(p + 'sauce'), SAUCES) || DEFAULT_SAUCE) : null,
    soda: cfg.soda ? (matchName(searchParams.get(p + 'soda'), SODAS) || DEFAULT_SODA) : null,
    protein: cfg.protein ? matchName(searchParams.get(p + 'protein'), PROTEINS) : null,
    flavor: cfg.flavor ? matchName(searchParams.get(p + 'flavor'), JARRITOS_FLAVORS) : null,
    // Chicken Wrap: required tortilla dropdown, no default.
    tortilla: cfg.tortilla === 'select' ? matchName(searchParams.get(p + 'tortilla'), TORTILLAS) : null,
    // Quesadillas: optional free tortilla checkboxes, no default.
    tortilla_choices: cfg.tortilla === 'checkbox' ? parsePricedList(searchParams.get(p + 'tortilla'), TORTILLAS_FREE) : [],
    // Chicken Wrap: required chicken-style dropdown, default CRISPY.
    wrap_style: cfg.wrapStyle ? (matchName(searchParams.get(p + 'wrapstyle'), WRAP_STYLES) || DEFAULT_WRAP_STYLE) : null,
    snapple_choices: cfg.snapple ? parsePricedList(searchParams.get(p + 'snapple'), SNAPPLE_CHOICES) : [],
    sodas_more: cfg.sodasMore ? parsePricedList(searchParams.get(p + 'sodasmore'), SODAS_MORE) : [],
    extra_meat: cfg.extraMeat ? parsePricedList(searchParams.get(p + 'extrameat'), EXTRA_MEAT) : [],
    extras: cfg.extras ? parsePricedList(searchParams.get(p + 'extras'), EXTRAS) : [],
    crazy_fries: cfg.crazyFries
      ? (matchName(searchParams.get(p + 'crazyfries'), CONVERT_FRIES_PROTEINS)
        ? { protein: matchName(searchParams.get(p + 'crazyfries'), CONVERT_FRIES_PROTEINS), price_usd: CRAZY_FRIES_PRICE }
        : null)
      : null,
  };
}

function modifiersTotal(m) {
  let t = 0;
  for (const key of ['snapple_choices', 'sodas_more', 'extra_meat', 'extras']) {
    for (const e of m[key]) t += e.price_usd;
  }
  if (m.crazy_fries) t += m.crazy_fries.price_usd;
  return t;
}

// Line total: (base price + paid modifiers) x qty. Sauce/soda/protein/flavor
// are free choices.
function lineTotal(item) {
  return (item.product.price_usd + modifiersTotal(item.modifiers)) * item.qty;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cart parsing.
// Meta sends: products=<url-encoded "id:qty,id:qty">  (qty defaults to 1)
// Modifiers (if any) ride as m<index>_<group>, indexed by cart position.
// If the same product appears twice it merges into one line and keeps the
// modifiers of its first occurrence.
// ---------------------------------------------------------------------------
function parseProducts(raw, searchParams) {
  const items = [];
  const unresolved = [];
  if (!raw) return { items, unresolved };
  const decoded = decodeURIComponent(raw);
  for (const part of decoded.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const [rawId, rawQty] = token.split(':');
    const id = (rawId || '').trim();
    let qty = parseInt(rawQty, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 99) qty = 99;
    const product = lookupProduct(id);
    if (!product) {
      unresolved.push({ id, qty });
      continue;
    }
    const existing = items.find((i) => i.product.retailer_id === product.retailer_id);
    if (existing) {
      existing.qty = Math.min(99, existing.qty + qty);
    } else {
      const index = items.length;
      items.push({
        product,
        qty,
        modifiers: parseModifiers(searchParams, index, product),
      });
    }
  }
  return { items, unresolved };
}

function cartSubtotal(items) {
  return items.reduce((sum, i) => sum + lineTotal(i), 0);
}

// Structured order payload — what createSquareCheckout() will send to Square
// once implemented (line items + modifiers + totals). Also used by ?debug=1.
function orderPayload(items, coupon) {
  return {
    coupon: coupon || null,
    items: items.map((i) => ({
      retailer_id: i.product.retailer_id,
      meta_product_id: i.product.meta_product_id,
      name: i.product.name,
      qty: i.qty,
      unit_price_usd: i.product.price_usd,
      modifiers: {
        sauce: i.modifiers.sauce,
        soda: i.modifiers.soda,
        protein: i.modifiers.protein,
        flavor: i.modifiers.flavor,
        tortilla: i.modifiers.tortilla,
        tortilla_choices: i.modifiers.tortilla_choices,
        wrap_style: i.modifiers.wrap_style,
        snapple_choices: i.modifiers.snapple_choices,
        sodas_more: i.modifiers.sodas_more,
        extra_meat: i.modifiers.extra_meat,
        extras: i.modifiers.extras,
        crazy_fries: i.modifiers.crazy_fries,
      },
      line_total_usd: round2(lineTotal(i)),
      square_order_link: i.product.square_order_link,
    })),
    subtotal_usd: round2(cartSubtotal(items)),
  };
}

// Encode the cart's modifier selections as query params for the pay URL,
// so the selections travel with the customer to waoburger.com.
function modifierParams(items) {
  const out = new URLSearchParams();
  items.forEach((item, index) => {
    const cfg = modifierConfig(item.product);
    const m = item.modifiers;
    const p = `m${index}_`;
    if (cfg.sauce && m.sauce) out.set(p + 'sauce', m.sauce);
    if (cfg.soda && m.soda) out.set(p + 'soda', m.soda);
    if (cfg.protein && m.protein) out.set(p + 'protein', m.protein);
    if (cfg.flavor && m.flavor) out.set(p + 'flavor', m.flavor);
    if (cfg.tortilla === 'select' && m.tortilla) out.set(p + 'tortilla', m.tortilla);
    if (cfg.tortilla === 'checkbox' && m.tortilla_choices.length) out.set(p + 'tortilla', m.tortilla_choices.map((e) => e.name).join(','));
    if (cfg.wrapStyle && m.wrap_style) out.set(p + 'wrapstyle', m.wrap_style);
    if (cfg.snapple && m.snapple_choices.length) out.set(p + 'snapple', m.snapple_choices.map((e) => e.name).join(','));
    if (cfg.sodasMore && m.sodas_more.length) out.set(p + 'sodasmore', m.sodas_more.map((e) => e.name).join(','));
    if (cfg.extraMeat && m.extra_meat.length) out.set(p + 'extrameat', m.extra_meat.map((e) => e.name).join(','));
    if (cfg.extras && m.extras.length) out.set(p + 'extras', m.extras.map((e) => e.name).join(','));
    if (cfg.crazyFries && m.crazy_fries) out.set(p + 'crazyfries', m.crazy_fries.protein);
  });
  return out;
}

// Params Meta / ads append that must be passed along on any redirect or
// outbound link so attribution is not lost.
const PASSTHROUGH_PARAMS = ['fbclid', 'cart_origin'];
function passthroughQuery(searchParams) {
  const out = new URLSearchParams();
  for (const key of PASSTHROUGH_PARAMS) {
    if (searchParams.has(key)) out.set(key, searchParams.get(key));
  }
  for (const [key, value] of searchParams.entries()) {
    if (key.startsWith('utm_')) out.set(key, value);
  }
  return out;
}

function orderPageUrl(searchParams, items) {
  const qs = passthroughQuery(searchParams);
  if (items) {
    for (const [key, value] of modifierParams(items).entries()) qs.set(key, value);
  }
  const s = qs.toString();
  return s ? `${ORDER_PAGE}?${s}` : ORDER_PAGE;
}

// ---------------------------------------------------------------------------
// Square Checkout integration — the direct connection to Square.
//
// When SQUARE_ACCESS_TOKEN is set, this builds a real Square checkout with
// the Payment Links API (POST /v2/online-checkout/payment-links) and the
// handler 302-redirects the buyer straight to Square to pay.
//
// No Square catalog object IDs are needed: line items are ad-hoc
// (name + base_price_money). Free choices (sauce, soda, protein, flavor,
// tortilla, wrap style) go in the line-item note; priced options
// (Snapple flavors, extra sodas, extra meat, extras, Crazy Fries
// conversion) become separate line items, so the Square total matches
// `line_total_usd` exactly. Coupon codes are ignored on purpose (never fail
// a checkout on a coupon).
// Location: SQUARE_LOCATION_ID if set, otherwise the first ACTIVE location
// whose address matches Whitehall PA 18052 / Fullerton Ave, else the first
// ACTIVE location (fetched once via GET /v2/locations and cached).
// Any Square error returns null so the handler falls back to the summary
// page — the customer can still pay on waoburger.com.
// ---------------------------------------------------------------------------
const SQUARE_API = 'https://connect.squareup.com';
const SQUARE_VERSION = '2024-12-18';
let cachedLocationId = process.env.SQUARE_LOCATION_ID || null;

async function squareApi(path, method, body) {
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this Node runtime (needs Node 18+)');
  const res = await fetch(`${SQUARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Square ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

async function resolveLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const data = await squareApi('/v2/locations', 'GET', null);
  const active = (data.locations || []).filter((l) => l.status === 'ACTIVE');
  const match = active.find((l) => {
    const a = l.address || {};
    return a.postal_code === '18052' || String(a.address_line_1 || '').toLowerCase().includes('fullerton');
  });
  cachedLocationId = (match || active[0] || {}).id || null;
  return cachedLocationId;
}

// Free choices as a readable note; priced options as their own lines.
function buildSquareLineItems(items) {
  const lines = [];
  for (const it of items) {
    const m = it.modifiers;
    const noteParts = [];
    if (m.sauce) noteParts.push(`Sauce: ${m.sauce}`);
    if (m.soda) noteParts.push(`Soda: ${m.soda}`);
    if (m.protein) noteParts.push(`Protein: ${m.protein}`);
    if (m.flavor) noteParts.push(`Flavor: ${m.flavor}`);
    if (m.tortilla) noteParts.push(`Tortilla: ${m.tortilla}`);
    if (m.tortilla_choices && m.tortilla_choices.length) noteParts.push(`Tortilla: ${m.tortilla_choices.map((e) => e.name).join(', ')}`);
    if (m.wrap_style) noteParts.push(`Style: ${m.wrap_style}`);
    const base = {
      name: it.product.name,
      quantity: String(it.qty),
      base_price_money: { amount: Math.round(it.product.price_usd * 100), currency: 'USD' },
    };
    if (noteParts.length) base.note = noteParts.join(', ');
    lines.push(base);
    const priced = [];
    for (const key of ['snapple_choices', 'sodas_more', 'extra_meat', 'extras']) {
      for (const e of m[key] || []) priced.push(e);
    }
    if (m.crazy_fries) priced.push({ name: `Crazy Fries (${m.crazy_fries.protein})`, price_usd: m.crazy_fries.price_usd });
    for (const e of priced) {
      lines.push({
        name: `${e.name} — ${it.product.name}`,
        quantity: String(it.qty),
        base_price_money: { amount: Math.round(e.price_usd * 100), currency: 'USD' },
      });
    }
  }
  return lines;
}

async function createSquareCheckout(items, coupon) {
  if (!process.env.SQUARE_ACCESS_TOKEN) return null;
  try {
    const locationId = await resolveLocationId();
    if (!locationId) {
      console.warn('[square] no ACTIVE Square location found; falling back to the summary page.');
      return null;
    }
    const data = await squareApi('/v2/online-checkout/payment-links', 'POST', {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: locationId,
        line_items: buildSquareLineItems(items),
      },
      checkout_options: {
        redirect_url: ORDER_PAGE,
        ask_for_shipping_address: false,
      },
    });
    const link = data.payment_link || {};
    // Prefer the full checkout URL; the short square.link URL works too.
    return link.long_url || link.url || null;
  } catch (err) {
    console.error('[square] checkout creation failed, falling back to the summary page:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML rendering helpers.
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — WAO Burgers</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#111;color:#fff}
  .wrap{max-width:560px;margin:0 auto;padding:24px 16px 48px}
  h1{color:#ff0000;font-size:28px;margin:8px 0 4px}
  p.sub{color:#bbb;margin:0 0 20px}
  .item{border:1px solid #333;border-radius:12px;padding:14px;margin:14px 0}
  .item-head{font-size:17px;font-weight:700}
  .item-head a{color:#fff}
  .item-head .unit{color:#bbb;font-weight:400;font-size:14px}
  label{display:block;margin:12px 0 4px;font-size:14px;font-weight:600}
  label .free{color:#8dff8d;font-weight:400}
  select{width:100%;padding:10px;margin-top:6px;background:#222;color:#fff;border:1px solid #555;border-radius:8px;font-size:15px}
  fieldset{border:1px solid #333;border-radius:8px;margin:14px 0 4px;padding:10px 12px}
  fieldset legend{font-size:14px;font-weight:600;padding:0 6px}
  .chk{display:block;margin:6px 0;font-size:14px;font-weight:400}
  .chk input{margin-right:8px}
  .choices{color:#bbb;font-size:13px;line-height:1.5;margin:10px 0 2px}
  .line-total{text-align:right;font-size:16px;margin:6px 0 0}
  .subtotal{font-weight:700;font-size:19px;text-align:right;margin:18px 0 0}
  .btn{display:block;text-align:center;background:#ff0000;color:#fff;text-decoration:none;font-weight:700;font-size:18px;padding:16px;border-radius:999px;margin:24px 0 8px}
  .note{color:#bbb;font-size:14px;line-height:1.5}
  .warn{background:#2a1a00;border:1px solid #7a5200;color:#ffd27a;padding:12px;border-radius:8px;font-size:14px}
  .coupon{color:#8dff8d}
  a{color:#ff6b6b}
</style>
</head>
<body><div class="wrap">
<h1>WAO Burgers</h1>
${body}
</div></body>
</html>`;
}

function selectGroup({ label, cls, name, options, selected, freeText, noDefault }) {
  const opts = (noDefault ? '<option value="">Select one</option>' : '')
    + options.map((o) => {
      const val = typeof o === 'string' ? o : o.name;
      const price = typeof o === 'string' ? null : o.price;
      const sel = selected === val ? ' selected' : '';
      const dp = price != null ? ` data-price="${price}"` : '';
      return `<option value="${esc(val)}"${dp}${sel}>${esc(val)}${price != null ? ` +${money(price)}` : ''}</option>`;
    }).join('');
  return `<label>${esc(label)}${freeText ? ` <span class="free">${esc(freeText)}</span>` : ''}
    <select name="${esc(name)}" class="${cls}">${opts}</select>
  </label>`;
}

function checkboxGroup({ legend, cls, name, options, selectedNames, free }) {
  const boxes = options.map((o) => {
    const checked = selectedNames.includes(o.name);
    const priceText = free ? '' : ` +${money(o.price)}`;
    return `<label class="chk"><input type="checkbox" class="${cls}" name="${esc(name)}" value="${esc(o.name)}" data-price="${o.price}"${checked ? ' checked' : ''}> ${esc(o.name)}${priceText}</label>`;
  }).join('');
  return `<fieldset><legend>${esc(legend)}${free ? ' — FREE' : ''}</legend>${boxes}</fieldset>`;
}

function choicesText(item) {
  const cfg = modifierConfig(item.product);
  const m = item.modifiers;
  const parts = [];
  if (cfg.tortilla === 'select') parts.push(m.tortilla ? `Tortilla: ${m.tortilla} (included)` : 'Tortilla: not selected');
  if (cfg.tortilla === 'checkbox') {
    for (const e of m.tortilla_choices) parts.push(`Tortilla: ${e.name} (included)`);
  }
  if (cfg.wrapStyle) parts.push(`Style: ${m.wrap_style} (included)`);
  if (cfg.sauce) parts.push(`Sauce: ${m.sauce} (included)`);
  if (cfg.soda) parts.push(`Soda: ${m.soda} (included)`);
  if (cfg.protein) parts.push(m.protein ? `Protein: ${m.protein} (included)` : 'Protein: not selected');
  if (cfg.flavor) parts.push(m.flavor ? `Flavor: ${m.flavor} (included)` : 'Flavor: not selected');
  for (const e of m.snapple_choices) parts.push(`${e.name} (+${money(e.price_usd)})`);
  for (const e of m.sodas_more) parts.push(`${e.name} (+${money(e.price_usd)})`);
  for (const e of m.extra_meat) parts.push(`${e.name} (+${money(e.price_usd)})`);
  for (const e of m.extras) parts.push(`${e.name} (+${money(e.price_usd)})`);
  if (m.crazy_fries) parts.push(`Crazy Fries: ${m.crazy_fries.protein} (+${money(m.crazy_fries.price_usd)})`);
  return parts.join(' · ') || 'No options for this item.';
}

function itemBlock(item, index) {
  const cfg = modifierConfig(item.product);
  const m = item.modifiers;
  const p = `m${index}_`;
  let groups = '';
  if (cfg.tortilla === 'select') {
    groups += selectGroup({ label: 'Choose Your Tortilla', cls: 'tortilla', name: p + 'tortilla', options: TORTILLAS, selected: m.tortilla, freeText: 'FREE — included', noDefault: true });
  }
  if (cfg.tortilla === 'checkbox') {
    groups += checkboxGroup({ legend: 'Choose Your Favorite Tortilla (optional)', cls: 'tortillachk', name: p + 'tortilla', options: TORTILLAS_FREE, selectedNames: m.tortilla_choices.map((e) => e.name), free: true });
  }
  if (cfg.wrapStyle) {
    groups += selectGroup({ label: 'Choose Your Chicken Style', cls: 'wrapstyle', name: p + 'wrapstyle', options: WRAP_STYLES, selected: m.wrap_style, freeText: 'FREE — included' });
  }
  if (cfg.sauce) {
    groups += selectGroup({ label: 'Choose Your Favorite Sauce', cls: 'sauce', name: p + 'sauce', options: SAUCES, selected: m.sauce, freeText: 'FREE — included' });
  }
  if (cfg.soda) {
    groups += selectGroup({ label: 'Choose Your Favorite Soda', cls: 'soda', name: p + 'soda', options: SODAS, selected: m.soda, freeText: 'FREE — included' });
  }
  if (cfg.protein) {
    groups += selectGroup({ label: 'Choose Your Protein', cls: 'protein', name: p + 'protein', options: PROTEINS, selected: m.protein, freeText: 'FREE — included', noDefault: true });
  }
  if (cfg.flavor) {
    groups += selectGroup({ label: 'Choose Your Flavor', cls: 'flavor', name: p + 'flavor', options: JARRITOS_FLAVORS, selected: m.flavor, freeText: 'FREE — included', noDefault: true });
  }
  if (cfg.snapple) {
    groups += checkboxGroup({ legend: 'SNAPPLE CHOICES (optional)', cls: 'snapple', name: p + 'snapple', options: SNAPPLE_CHOICES, selectedNames: m.snapple_choices.map((e) => e.name) });
  }
  if (cfg.sodasMore) {
    groups += checkboxGroup({ legend: 'Sodas & More (optional)', cls: 'sodasmore', name: p + 'sodasmore', options: SODAS_MORE, selectedNames: m.sodas_more.map((e) => e.name) });
  }
  if (cfg.extraMeat) {
    groups += checkboxGroup({ legend: 'Extra Meat (optional)', cls: 'extrameat', name: p + 'extrameat', options: EXTRA_MEAT, selectedNames: m.extra_meat.map((e) => e.name) });
  }
  if (cfg.extras) {
    groups += checkboxGroup({ legend: 'Additional Features (optional)', cls: 'extra', name: p + 'extras', options: EXTRAS, selectedNames: m.extras.map((e) => e.name) });
  }
  if (cfg.crazyFries) {
    groups += selectGroup({
      label: 'Convert Fries to Crazy Fries (optional)',
      cls: 'crazy',
      name: p + 'crazyfries',
      options: CONVERT_FRIES_PROTEINS.map((pr) => ({ name: pr, price: CRAZY_FRIES_PRICE })),
      selected: m.crazy_fries ? m.crazy_fries.protein : null,
      noDefault: true,
    }).replace('<option value="">Select one</option>', '<option value="">No, keep regular fries</option>');
  }
  return `<div class="item" data-index="${index}" data-base="${item.product.price_usd}" data-qty="${item.qty}">
    <div class="item-head"><a href="${esc(item.product.square_order_link)}">${esc(item.product.name)}</a> <span class="unit">&times; ${item.qty} · ${money(item.product.price_usd)} each</span></div>
    ${groups}
    <p class="choices" id="ch${index}">${esc(choicesText(item))}</p>
    <p class="line-total">Item total: <strong id="lt${index}">${money(lineTotal(item))}</strong></p>
  </div>`;
}

function summaryPage({ items, unresolved, coupon, payUrl, cartOrigin }) {
  const subtotal = cartSubtotal(items);
  const blocks = items.map((item, index) => itemBlock(item, index)).join('');
  const unresolvedBlock = unresolved.length
    ? `<div class="warn">We couldn't find these items in our menu, so they were left out of your order: ${unresolved.map((u) => esc(u.id)).join(', ')}. Everything below is still ready for you.</div>`
    : '';
  const couponBlock = coupon
    ? `<p class="coupon">Coupon code: <strong>${esc(coupon)}</strong> — enter it again at payment on waoburger.com if it isn't applied automatically.</p>`
    : '';
  const originBlock = cartOrigin
    ? `<p class="note">Coming from ${esc(cartOrigin)}.</p>`
    : '';
  return page('Your order', `
    <p class="sub">Review your order, pick your free sauce and soda, then pay on our website. No account needed.</p>
    ${unresolvedBlock}
    ${blocks}
    <p class="subtotal">Subtotal: <span id="subtotal">${money(subtotal)}</span></p>
    ${couponBlock}
    <a class="btn" id="payBtn" data-pay-base="${esc(payUrl)}" href="${esc(payUrl)}">Pay on waoburger.com</a>
    <p class="note">Your sauce and soda are included free with every item that offers them, just like on waoburger.com. You'll finish your order and pay on waoburger.com (Square). Pickup: 515 Fullerton Ave, Whitehall, PA 18052 · Phone: (484) 246-6337.</p>
    ${originBlock}
    <script>
    (function () {
      var payBtn = document.getElementById('payBtn');
      var payBase = payBtn.getAttribute('data-pay-base');
      function fmt(n) { return '$' + n.toFixed(2); }
      function recompute() {
        var subtotal = 0;
        var q0 = payBase.indexOf('?') >= 0 ? payBase.split('?')[1] : '';
        var qs = new URLSearchParams(q0);
        document.querySelectorAll('.item').forEach(function (el) {
          var idx = el.getAttribute('data-index');
          var base = parseFloat(el.getAttribute('data-base'));
          var qty = parseInt(el.getAttribute('data-qty'), 10);
          var lineExtra = 0;
          var parts = [];
          function sel(cls, param, label) {
            var s = el.querySelector('.' + cls);
            if (!s) return;
            var v = s.value;
            if (v) { qs.set('m' + idx + '_' + param, v); parts.push(label + ': ' + v + ' (included)'); }
            else { qs.delete('m' + idx + '_' + param); parts.push(label + ': not selected'); }
          }
          function checks(cls, param) {
            var t = 0;
            var names = [];
            el.querySelectorAll('.' + cls + ':checked').forEach(function (cb) {
              var p = parseFloat(cb.getAttribute('data-price'));
              t += p;
              names.push(cb.value);
              parts.push(cb.value + ' (+' + fmt(p) + ')');
            });
            if (names.length) qs.set('m' + idx + '_' + param, names.join(','));
            else qs.delete('m' + idx + '_' + param);
            return t;
          }
          function checksFree(cls, param, label) {
            var names = [];
            el.querySelectorAll('.' + cls + ':checked').forEach(function (cb) {
              names.push(cb.value);
              parts.push(label + ': ' + cb.value + ' (included)');
            });
            if (names.length) qs.set('m' + idx + '_' + param, names.join(','));
            else qs.delete('m' + idx + '_' + param);
          }
          sel('tortilla', 'tortilla', 'Tortilla');
          checksFree('tortillachk', 'tortilla', 'Tortilla');
          sel('wrapstyle', 'wrapstyle', 'Chicken Style');
          sel('sauce', 'sauce', 'Sauce');
          sel('soda', 'soda', 'Soda');
          sel('protein', 'protein', 'Protein');
          sel('flavor', 'flavor', 'Flavor');
          lineExtra += checks('snapple', 'snapple');
          lineExtra += checks('sodasmore', 'sodasmore');
          lineExtra += checks('extrameat', 'extrameat');
          lineExtra += checks('extra', 'extras');
          var crazySel = el.querySelector('.crazy');
          if (crazySel) {
            var cv = crazySel.value;
            if (cv) {
              var cp = parseFloat(crazySel.options[crazySel.selectedIndex].getAttribute('data-price'));
              lineExtra += cp;
              qs.set('m' + idx + '_crazyfries', cv);
              parts.push('Crazy Fries: ' + cv + ' (+' + fmt(cp) + ')');
            } else qs.delete('m' + idx + '_crazyfries');
          }
          var line = (base + lineExtra) * qty;
          subtotal += line;
          document.getElementById('lt' + idx).textContent = fmt(line);
          document.getElementById('ch' + idx).textContent = parts.join(' \\u00b7 ') || 'No options for this item.';
        });
        document.getElementById('subtotal').textContent = fmt(subtotal);
        payBtn.href = payBase.split('?')[0] + '?' + qs.toString();
      }
      document.querySelectorAll('select, input[type=checkbox]').forEach(function (c) {
        c.addEventListener('change', recompute);
      });
      recompute();
    })();
    </script>
  `);
}

function emptyPage(payUrl) {
  return page('Your order', `
    <p class="sub">We couldn't find any items in your cart.</p>
    <p class="note">Your cart from Facebook or Instagram was empty, or the items are no longer on our menu. You can still browse the full menu and order below.</p>
    <a class="btn" href="${esc(payUrl)}">See the menu on waoburger.com</a>
  `);
}

// ---------------------------------------------------------------------------
// Request handler.
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const sp = url.searchParams;

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, products: mapping.products.length }));
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  const coupon = sp.get('coupon') || null;
  const cartOrigin = sp.get('cart_origin') || null;
  const { items, unresolved } = parseProducts(sp.get('products'), sp);
  const payUrl = orderPageUrl(sp, items);

  // Debug view: ?debug=1 returns the parsed cart as JSON (no checkout).
  if (sp.get('debug') === '1') {
    const payload = orderPayload(items, coupon);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...payload,
      unresolved,
      cart_origin: cartOrigin,
      pay_url: payUrl,
    }, null, 2));
    return;
  }

  if (items.length === 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(emptyPage(payUrl));
    return;
  }

  // Future Square integration point: if a Square checkout URL is produced,
  // redirect the buyer there (preserving attribution params).
  const squareUrl = await createSquareCheckout(items, coupon);
  if (squareUrl) {
    const qs = passthroughQuery(sp);
    const sep = squareUrl.includes('?') ? '&' : '?';
    const target = qs.toString() ? `${squareUrl}${sep}${qs.toString()}` : squareUrl;
    res.writeHead(302, { Location: target });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(summaryPage({ items, unresolved, coupon, payUrl, cartOrigin }));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something went wrong. Please order directly at https://www.waoburger.com/s/order');
  });
});

// Only listen when run directly (`node server.js`). When required by a
// serverless wrapper (e.g. Vercel api/index.js), the platform drives the
// server via `server.emit('request', req, res)` instead.
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WAO Burgers checkout endpoint listening on port ${PORT}`);
    console.log(`Mapping loaded: ${mapping.products.length} products (catalog ${mapping.catalog_id})`);
  });
}

module.exports = server;
