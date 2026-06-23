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
 * Plugo encodes each variant as a sequence in the flat array:
 *   ..., "SIZE_LABEL", [ref], {"quantity": qRef}, <stockNumber>, ...
 *
 * When {"quantity": N} appears:
 *   - if payload[N] is a number  → stock = payload[N]
 *   - if {"quantity": N} is the literal object and the NEXT raw number in
 *     the array at that index position is inline → we fall back to scanning
 *
 * We also extract the product name from a nearby "Ziptee Polo…"-like string.
 */
function decodePlugoPayload(payload) {
  const SIZE_RE = /^(XS|S|M|L|XL|2?XXL|XXXL|3XL|ONE SIZE|FREE SIZE|[0-9]{2,3})$/i;
  // Plugo product name pattern: large integer (product ID) followed immediately by the name string
  // e.g. payload[i] = 835792, payload[i+1] = "Ziptee Polo Shirt Dark Tones", payload[i+2] = "normal"
  const SKIP_STRINGS = new Set(['normal', 'unavailable', 'available', 'Ukuran', 'Warna', 'desc', 'asc']);

  const variants = [];
  let productName = 'Unknown Product';

  // First pass: find product name (integer > 100000 followed by a title-like string)
  for (let i = 0; i < payload.length - 1; i++) {
    const el = payload[i];
    const next = payload[i + 1];
    if (
      typeof el === 'number' &&
      el > 100_000 &&
      el < 10_000_000 && // exclude timestamps (13 digits) and option IDs (> 10M)
      typeof next === 'string' &&
      next.length > 3 &&
      next.length < 150 &&
      !next.startsWith('http') &&
      !next.startsWith('<') &&
      /[a-zA-Z]/.test(next) &&
      !SKIP_STRINGS.has(next)
    ) {
      productName = next;
      break;
    }
  }

  // Second pass: extract size variants
  for (let i = 0; i < payload.length; i++) {
    const el = payload[i];

    if (typeof el !== 'string' || !SIZE_RE.test(el.trim())) continue;


    const label = el.trim().toUpperCase();

    // Look forward for {"quantity": refOrNumber}
    for (let j = i + 1; j < Math.min(i + 6, payload.length); j++) {
      const candidate = payload[j];
      if (
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        'quantity' in candidate
      ) {
        const qRef = candidate.quantity;
        let stock = 0;

        if (typeof qRef === 'number') {
          // qRef is an index into payload
          const resolved = payload[qRef];
          stock = typeof resolved === 'number' ? resolved : 0;
        }

        variants.push({ label, stock });
        break;
      }
    }
  }

  return { productName, variants };
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

  const initial = decodePlugoPayload(payload);
  log(`  Product: ${initial.productName}`);
  log(`  Variants: ${initial.variants.map(v => `${v.label}=${v.stock}`).join(', ')}`);

  // The "API URL" for Plugo is simply the product page itself — we re-fetch HTML
  return { apiUrl: productUrl, initial };
}

/**
 * Parse stock data from a fresh HTML fetch (used by the poller).
 */
export function parseStockData(html) {
  for (const [, content] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (content.includes('ShallowReactive') && content.length > 5_000) {
      try {
        const payload = JSON.parse(content);
        return decodePlugoPayload(payload);
      } catch {
        return null;
      }
    }
  }
  return null;
}
