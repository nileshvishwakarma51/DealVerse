'use strict';

// Best-effort Amazon product title + price scraper. Amazon may serve a CAPTCHA
// or vary its markup, so every failure degrades gracefully to nulls.
const REQUEST_TIMEOUT_MS = 8000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

async function fetchProductMeta(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-IN,en;q=0.9' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return { title: null, price: null };
    html = await res.text();
  } catch {
    return { title: null, price: null };
  } finally {
    clearTimeout(timer);
  }

  let title = null;
  let m = html.match(/id="productTitle"[^>]*>([^<]+)</i);
  if (m) title = decodeEntities(m[1]);
  if (!title) {
    m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) {
      title = decodeEntities(m[1])
        .replace(/\s*[:\-|].*$/, '') // strip "… : Amazon.in" style suffixes
        .trim();
      if (/amazon/i.test(title) || title.length < 3) title = null;
    }
  }

  let price = null;
  m = html.match(/class="a-price-whole"[^>]*>([\d.,]+)/i);
  if (m) price = m[1].replace(/[.,]\s*$/, '');
  if (!price) {
    m = html.match(/class="a-offscreen"[^>]*>\s*([^<]+?)\s*</i);
    if (m) price = decodeEntities(m[1]);
  }

  return { title: title || null, price: price || null };
}

module.exports = { fetchProductMeta };
