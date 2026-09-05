'use strict';

// ProductPriceService — fetch the current numeric price (+ title) for an Amazon
// or Flipkart product. Reuses the existing Amazon URL resolution + meta scraper;
// adds a best-effort Flipkart scraper. Prices are returned as safe numbers
// (rounded to 2 decimals), never compared as formatted strings.
const { ApiError } = require('./errors');
const { classify } = require('./links');
const { buildCleanProductUrl } = require('./amazon');
const { fetchProductMeta } = require('./productMeta');

const TIMEOUT_MS = 10000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function round2(n) {
  // Guard null/''/undefined explicitly: Number(null) and Number('') are 0, which
  // would otherwise turn an unreadable price into a bogus "dropped to 0" alert.
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

// Parse a price string ("₹1,600.00", "1,600", "$239.99") into a number. Treats
// comma as a thousands separator and dot as the decimal (Amazon.in / Flipkart).
function parsePrice(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return null;
  s = s.replace(/,/g, ''); // drop thousands separators
  // If multiple dots remain, keep the first as decimal point.
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

function currencyFor(hostname, marketplace) {
  const h = String(hostname || '').toLowerCase();
  if (marketplace === 'FLIPKART') return '₹';
  if (h.endsWith('amazon.in')) return '₹';
  if (h.endsWith('amazon.co.uk')) return '£';
  if (h.endsWith('amazon.de') || h.endsWith('amazon.fr') || h.endsWith('amazon.it') || h.endsWith('amazon.es') || h.endsWith('amazon.nl')) return '€';
  return '$';
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-IN,en;q=0.9' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = res.url || url;
    if (!res.ok) return { ok: false, status: res.status, finalUrl, html: '' };
    return { ok: true, status: res.status, finalUrl, html: await res.text() };
  } catch {
    return { ok: false, status: 0, finalUrl: url, html: '' };
  } finally {
    clearTimeout(timer);
  }
}

// ── Amazon (reuse existing resolution + meta) ────────────────────────────────
async function amazonPrice(rawUrl) {
  const { cleanUrl, asin, hostname } = await buildCleanProductUrl(rawUrl); // resolves shorts, canonicalises, SSRF-safe
  const meta = await fetchProductMeta(cleanUrl); // title + price string, best-effort
  const price = parsePrice(meta.price);
  return {
    marketplace: 'AMAZON',
    price, // may be null (blocked / out of stock / markup change)
    currency: currencyFor(hostname, 'AMAZON'),
    productUrl: cleanUrl,
    canonicalUrl: cleanUrl,
    title: meta.title || null,
    asin: asin || null,
  };
}

// ── Flipkart (best-effort scrape; Flipkart often blocks bots) ────────────────
const FLIPKART_HOST_RE = /(?:[a-z0-9-]+\.)?flipkart\.com/i;
async function flipkartPrice(rawUrl) {
  // Follow redirects (fkrt.* short links) to the product page, staying on Flipkart.
  const r = await fetchHtml(rawUrl);
  let productUrl = r.finalUrl;
  try {
    if (!FLIPKART_HOST_RE.test(new URL(productUrl).hostname)) {
      throw new ApiError(400, 'That link did not resolve to a Flipkart product page.');
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, 'Invalid Flipkart link.');
  }
  const html = r.html || '';
  let title = null;
  let m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (m) title = m[1].replace(/\s*[|:-].*$/, '').trim();
  if (!title) {
    m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) title = m[1].replace(/\s*[|:-].*$/, '').trim();
  }
  // Try JSON "price" fields Flipkart embeds, then the ₹ price markup.
  let price = null;
  m = html.match(/"(?:finalPrice|sellingPrice|price)"\s*:\s*\{[^}]*"decimalValue"\s*:\s*"?([\d.,]+)"?/i)
    || html.match(/"price"\s*:\s*"?([\d.,]+)"?/i)
    || html.match(/₹\s*([\d.,]+)/);
  if (m) price = parsePrice(m[1]);
  return {
    marketplace: 'FLIPKART',
    price,
    currency: '₹',
    productUrl,
    canonicalUrl: productUrl,
    title: title || null,
    asin: null,
  };
}

// Public: get current price for a product URL. Marketplace is auto-detected from
// the link if not given. Returns { marketplace, price, currency, productUrl,
// canonicalUrl, title, asin }. `price` is null when it couldn't be extracted.
async function getProductPrice(rawUrl, marketplaceHint) {
  const platform = marketplaceHint
    ? String(marketplaceHint).toLowerCase()
    : classify(rawUrl); // 'amazon' | 'flipkart' | null
  if (platform === 'amazon') return amazonPrice(rawUrl);
  if (platform === 'flipkart') return flipkartPrice(rawUrl);
  throw new ApiError(400, 'Only Amazon and Flipkart product links are supported.');
}

module.exports = { getProductPrice, parsePrice, round2 };
