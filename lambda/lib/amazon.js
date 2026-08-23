'use strict';

// Amazon link handling ported from the reference project's
// amazonAffiliateService.ts + siteStripeService.ts (Amazon-only for now).
const { ApiError } = require('./errors');
const { validateSiteStripeEndpoint, isAmazonHost, isShortLink } = require('./curl');

const ASIN_RE = /\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})(?:\/|$|\?)/i;
const REQUEST_TIMEOUT_MS = 15000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function extractAsin(pathname) {
  const m = ASIN_RE.exec(pathname);
  return m ? m[1].toUpperCase() : null;
}

function validateAmazonUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Please paste a valid URL.');
  }
  if (!isAmazonHost(u.hostname)) {
    throw new ApiError(400, 'That does not look like an Amazon product link.');
  }
  return u;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Follow redirects on an amzn.in/amzn.to short link to the real product URL.
async function resolveShortLink(rawUrl) {
  let res;
  try {
    res = await fetchWithTimeout(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': BROWSER_UA },
    });
  } catch {
    throw new ApiError(502, 'Could not expand the short link.');
  }
  const finalUrl = res.url || rawUrl;
  let host;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    throw new ApiError(502, 'The short link did not resolve to a valid URL.');
  }
  if (isShortLink(host) || !isAmazonHost(host)) {
    throw new ApiError(400, 'The short link did not resolve to an Amazon product page.');
  }
  return finalUrl;
}

// rawUrl -> { hostname, asin, cleanUrl } where cleanUrl is https://<host>/dp/<ASIN>
async function buildCleanProductUrl(rawUrl) {
  let prelim;
  try {
    prelim = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Please paste a valid URL.');
  }

  let target = rawUrl;
  if (isShortLink(prelim.hostname)) {
    target = await resolveShortLink(rawUrl);
  }

  const url = validateAmazonUrl(target);
  const asin = extractAsin(url.pathname);
  if (!asin) {
    throw new ApiError(400, 'Could not find a product ASIN in that link.');
  }
  return { hostname: url.hostname, asin, cleanUrl: `https://${url.hostname}/dp/${asin}` };
}

// TAG mode: pure URL rewrite to https://<host>/dp/<ASIN>?tag=<TAG> (no session).
function buildTagUrl(hostname, asin, tag) {
  const u = new URL(`https://${hostname}/dp/${asin}`);
  u.searchParams.set('tag', tag);
  return u.toString();
}

// Call the stored SiteStripe session to get an affiliate short link.
async function requestShortUrl(siteStripe, cleanProductUrl) {
  const endpoint = validateSiteStripeEndpoint(siteStripe.url);
  endpoint.searchParams.set('longUrl', cleanProductUrl);

  const headers = {};
  for (const [name, value] of Object.entries(siteStripe.headers || {})) {
    const n = name.toLowerCase();
    if (n === 'cookie' || n === 'content-length' || n === 'host') continue;
    headers[name] = value;
  }
  if (siteStripe.cookies && Object.keys(siteStripe.cookies).length) {
    headers['cookie'] = Object.entries(siteStripe.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  let res;
  try {
    res = await fetchWithTimeout(endpoint.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
  } catch {
    throw new ApiError(502, 'Could not reach Amazon SiteStripe.');
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError(401, 'Amazon session expired or blocked. Paste a fresh cURL in the admin panel.');
  }
  if (res.status === 429) {
    throw new ApiError(429, 'Amazon rate-limited the request. Try again shortly.');
  }
  if (res.status >= 500) {
    throw new ApiError(502, 'Amazon returned a server error.');
  }
  if (res.status !== 200) {
    throw new ApiError(502, `Unexpected response from Amazon (${res.status}).`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(502, 'Amazon returned an unexpected (non-JSON) response.');
  }
  const ok = body && (body.ok === true || body.isOk === true);
  if (!ok || !body.shortUrl) {
    throw new ApiError(502, 'Amazon could not generate a short link for this product.');
  }
  return body.shortUrl;
}

module.exports = {
  buildCleanProductUrl,
  requestShortUrl,
  buildTagUrl,
  extractAsin,
};
