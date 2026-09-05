'use strict';

// Best-effort Amazon product title + price scraper.
//
// Amazon serves a CAPTCHA/robot page to the desktop product URL from datacenter
// (and even many residential) IPs, so the old desktop scrape almost always failed.
// The MOBILE product endpoint (/gp/aw/d/<ASIN>) with a mobile User-Agent returns
// the real page reliably, so we fetch that instead. Every failure still degrades
// gracefully to nulls.
const REQUEST_TIMEOUT_MS = 9000;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const CAPTCHA_RE = /Enter the characters|automated access|Robot Check|api-services-support@amazon/i;

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&rsquo;/g, '’')
    .trim();
}

// Rewrite a product URL to Amazon's lightweight mobile endpoint, which is far
// less likely to be served a robot page. Non-product pages pass through as-is.
function toMobileUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/)([A-Z0-9]{10})/i);
    if (m) return `https://${u.hostname}/gp/aw/d/${m[1]}`;
    return url;
  } catch {
    return url;
  }
}

function acceptLangFor(url) {
  try {
    return new URL(url).hostname.endsWith('.in') ? 'en-IN,en;q=0.9' : 'en-US,en;q=0.9';
  } catch {
    return 'en-US,en;q=0.9';
  }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': MOBILE_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': acceptLangFor(url),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Current buy-box price. Order matters: anchor on the "price to pay" block first
// (the current price, not the struck-through MRP), then the apex whole-number
// element, then the accessible "Price:" label (.com mobile renders the number
// client-side but keeps this a11y label), then any currency-tagged offscreen span.
function extractPrice(html) {
  let m;
  m = html.match(/priceToPay[\s\S]{0,300}?([\d,]+\.\d{2})/i);
  if (m) return m[1];
  m = html.match(/priceToPay[\s\S]{0,300}?a-price-whole"[^>]*>\s*([\d,]+)/i);
  if (m) return m[1];
  m = html.match(/a-price-whole"[^>]*>\s*([\d,]+)/i);
  if (m) return m[1];
  m = html.match(/Price:\s*(?:₹|&#8377;|Rs\.?|INR|\$|£|€)?\s*([\d,]+\.?\d{0,2})/i);
  if (m) return m[1];
  m = html.match(/a-offscreen"[^>]*>\s*(?:₹|&#8377;|Rs\.?|\$|£|€)\s*([\d,]+\.?\d{0,2})/i);
  if (m) return m[1];
  return null;
}

function extractTitle(html) {
  let m = html.match(/id="productTitle"[^>]*>([^<]+)</i);
  if (m) return decodeEntities(m[1]);
  m = html.match(/<title>([^<]+)<\/title>/i);
  if (m) {
    const t = decodeEntities(m[1])
      .replace(/^Amazon\.[a-z.]+\s*:?\s*/i, '') // "Amazon.in: " prefix
      .replace(/\s*:\s*Amazon\.[a-z.]+.*$/i, '') // trailing " : Amazon.in …"
      .trim();
    if (t && t.length >= 3 && !/^amazon/i.test(t)) return t;
  }
  return null;
}

async function fetchProductMeta(url) {
  const mobileUrl = toMobileUrl(url);
  let html = await fetchHtml(mobileUrl);
  // One retry if we got nothing or a robot page — these are often transient.
  if (!html || CAPTCHA_RE.test(html)) {
    html = await fetchHtml(mobileUrl);
  }
  if (!html || CAPTCHA_RE.test(html)) return { title: null, price: null };
  return { title: extractTitle(html) || null, price: extractPrice(html) || null };
}

module.exports = { fetchProductMeta, toMobileUrl, extractPrice };
