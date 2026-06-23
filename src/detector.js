import axios from 'axios';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
};

/**
 * Fetch the product page HTML and extract the Nuxt 3 devalue SSR payload.
 * Returns the raw parsed payload array or null if not a Plugo store.
 */
async function fetchPlugoPayload(productUrl) {
  const res = await axios.get(productUrl, {
    timeout: 15_000,
    headers: BROWSER_HEADERS,
    responseType: 'text',
  });

  const html = res.data;

  // Must be a Plugo storefront (api.plugo.world in config)
  if (!html.includes('plugo.world') && !html.includes('plugo.co')) return null;

  // Find the Nuxt 3 hydration script (ShallowReactive devalue format)
  for (const [, content] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (content.includes('ShallowReactive') && content.length > 5_000) {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Decode the Nuxt 3 devalue payload array into variant stock data.
 *
 * Strategy: scan for all {"quantity": N} objects (skipping cart-state ones
 * that also have a "variation" key), then scan backward from each to find
 * the nearest string that looks like a variant label.
 *
 * This handles both standard size labels (S/M/L/XL) and store-specific
 * product codes (e.g. "CH366") used by some Plugo stores.
 */
function decodePlugoPayload(payload, productUrl) {
  const SKIP_STRINGS = new Set([
    'normal', 'unavailable', 'available', 'Ukuran', 'Warna', 'desc', 'asc',
    'mobile', 'desktop', 'tablet', 'id', 'success', 'error', 'loading',
    'true', 'false', 'null',
  ]);

  const variants = [];
  let productName = 'Unknown Product';

  // --- Product name ---
  // Find integer product ID (100k–10M) followed by a readable name string.
  // If the next string looks like a SKU code (e.g. "CH366"), skip it and
  // fall back to deriving the name from the product URL slug.
  for (let i = 0; i < payload.length - 1; i++) {
    const el   = payload[i];
    const next = payload[i + 1];
    if (
      typeof el === 'number' && el > 100_000 && el < 10_000_000 &&
      typeof next === 'string' && next.length > 3 && next.length < 150 &&
      !next.startsWith('http') && !next.startsWith('<') &&
      /[a-zA-Z]/.test(next) && !SKIP_STRINGS.has(next)
    ) {
      // Skip short all-caps SKU codes like "CH366", "BRD001"
      const isSKU = next.length <= 10 && !/\s/.test(next) && /^[A-Z]{1,5}\d+$/i.test(next);
      if (!isSKU) {
        productName = next;
        break;
      }
    }
  }

  // Fallback: extract readable name from URL slug
  if (productName === 'Unknown Product' && productUrl) {
    try {
      const path  = new URL(productUrl).pathname;
      const match = path.match(/\/products\/\d+\/(.+)/);
      if (match) {
        productName = match[1]
          .replace(/-__-/g, ' – ')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());
      }
    } catch { /* ignore */ }
  }

  // --- Variants: backward scan from each {"quantity": N} object ---
  // Objects that also have "variation" key are cart-selection state, not product variants.
  for (let i = 0; i < payload.length; i++) {
    const el = payload[i];
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    if (!('quantity' in el) || 'variation' in el) continue;

    const qRef = el.quantity;
    if (typeof qRef !== 'number') continue;
    const stock = payload[qRef];
    if (typeof stock !== 'number') continue;

    // Scan backward up to 8 positions for the nearest usable label string
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const candidate = payload[j];
      if (
        typeof candidate === 'string' &&
        candidate.length >= 1 && candidate.length <= 50 &&
        !candidate.startsWith('<') && !candidate.startsWith('http') &&
        !/^\s*$/.test(candidate) && !SKIP_STRINGS.has(candidate)
      ) {
        const label = candidate.trim().toUpperCase();
        if (!variants.find(v => v.label === label)) {
          variants.push({ label, stock });
        }
        break;
      }
    }
  }

  return { productName, variants };
}

/**
 * Returns true if the URL is a collection/listing page, not a single product.
 * Product URLs contain a numeric ID segment: /products/835792/slug
 */
export function isCollectionUrl(url) {
  const path = new URL(url).pathname;
  return (
    /^\/products\/?$/.test(path) ||
    /^\/collections\//.test(path) ||
    (/^\/products\//.test(path) && !/^\/products\/\d+/.test(path))
  );
}

/**
 * Extract vendor ID from a Plugo store page HTML.
 * The vendor ID appears in URLs like /v1/shop/3899/manifest
 */
function extractVendorId(html) {
  const m = html.match(/\/shop\/(\d+)\//);
  return m ? m[1] : null;
}

/**
 * Fetch a collection/listing page and return ALL unique product URLs.
 *
 * Strategy:
 * 1. Fetch collection HTML → extract vendor ID
 * 2. Call api.plugo.world/v1/shop/{vendorId}/products → full product list
 * 3. Construct /products/{id} URLs (slug not required for Plugo)
 * 4. Fall back to parsing href="/products/{id}/..." from HTML (first page only)
 */
export async function scanCollectionPage(collectionUrl) {
  const res = await axios.get(collectionUrl, {
    timeout: 15_000,
    headers: BROWSER_HEADERS,
    responseType: 'text',
  });

  const html = res.data;
  if (!html.includes('plugo.world') && !html.includes('plugo.co')) {
    throw new Error('Bukan Plugo store');
  }

  const base      = new URL(collectionUrl);
  const vendorId  = extractVendorId(html);

  // Try the Plugo products API for full product list (all pages)
  if (vendorId) {
    try {
      const apiRes = await axios.get(
        `https://api.plugo.world/v1/shop/${vendorId}/products`,
        { timeout: 10_000, headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] } }
      );
      const products = apiRes.data?.data ?? apiRes.data;
      if (Array.isArray(products) && products.length > 0) {
        return products.map(p => `${base.protocol}//${base.host}/products/${p.id}`);
      }
    } catch { /* fall through to HTML scrape */ }
  }

  // Fallback: extract hrefs from HTML (first page only)
  const found = new Set();
  for (const [, path] of html.matchAll(/href="(\/products\/\d+\/[^"?#\s]+)"/g)) {
    found.add(`${base.protocol}//${base.host}${path}`);
  }
  return [...found];
}

/**
 * Main detection entry point.
 * Returns { productUrl, initial: { productName, variants } } or null.
 */
export async function detectPlugoEndpoint(productUrl, log) {
  log(`Fetching page: ${productUrl}`);

  let payload;
  try {
    payload = await fetchPlugoPayload(productUrl);
  } catch (err) {
    log(`  HTTP error: ${err.message}`);
    return null;
  }

  if (!payload) {
    log('  Not a Plugo store or SSR payload not found.');
    return null;
  }

  log(`  SSR payload found (${payload.length} elements)`);

  const initial = decodePlugoPayload(payload, productUrl);
  log(`  Product: ${initial.productName}`);
  log(`  Variants: ${initial.variants.map(v => `${v.label}=${v.stock}`).join(', ')}`);

  // The "API URL" for Plugo is simply the product page itself — we re-fetch HTML
  return { apiUrl: productUrl, initial };
}

/**
 * Parse stock data from a fresh HTML fetch (used by the poller).
 */
export function parseStockData(html, productUrl) {
  for (const [, content] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (content.includes('ShallowReactive') && content.length > 5_000) {
      try {
        const payload = JSON.parse(content);
        return decodePlugoPayload(payload, productUrl);
      } catch {
        return null;
      }
    }
  }
  return null;
}
