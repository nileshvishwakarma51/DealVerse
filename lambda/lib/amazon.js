'use strict';

// Amazon link handling ported from the reference project's
// amazonAffiliateService.ts + siteStripeService.ts (Amazon-only for now).
const { ApiError } = require('./errors');
const { validateSiteStripeEndpoint, isAmazonHost, isShortLink, isDeepLink } = require('./curl');

// Pull an Amazon URL out of a wrapper URL — either the whole thing is Amazon,
// or it's carried in a query param (?url=…amazon.in/dp/…), or embedded in the
// raw string. Returns the Amazon URL string, or null.
function extractEmbeddedAmazon(u) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (isAmazonHost(parsed.hostname) || isShortLink(parsed.hostname)) return u;
  for (const key of ['url', 'u', 'link', 'redirect', 'r', 'dl', 'target', 'q']) {
    const v = parsed.searchParams.get(key);
    if (!v) continue;
    try {
      const vu = new URL(v);
      if (isAmazonHost(vu.hostname) || isShortLink(vu.hostname)) return v;
    } catch {
      /* not a URL — ignore */
    }
  }
  const m = decodeURIComponent(u).match(
    /https?:\/\/[^"'\s&]*(?:amazon\.[a-z.]+|amzn\.[a-z]+|link\.amazon|a\.co)\/[^"'\s&]*/i
  );
  return m ? m[0] : null;
}

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
    throw new ApiError(400, 'The short link did not resolve to an Amazon page.');
  }
  return finalUrl;
}

// Follow a third-party deal shortener (e.g. amznn.cc) and pull out the Amazon
// URL it wraps — from the final redirect URL, its query params, or the raw link.
async function resolveDeepLink(rawUrl) {
  let finalUrl = rawUrl;
  try {
    const res = await fetchWithTimeout(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': BROWSER_UA },
    });
    finalUrl = res.url || rawUrl;
  } catch {
    /* fall back to inspecting the raw URL's params below */
  }
  const found = extractEmbeddedAmazon(finalUrl) || extractEmbeddedAmazon(rawUrl);
  if (!found) {
    throw new ApiError(400, 'Could not find an Amazon product in that link.');
  }
  return found;
}

// Remove other people's affiliate / tracking params so we can apply our own.
const TRACKING_PARAMS = new Set(['tag', 'ascsubtag', 'linkcode', 'linkid', 'creative', 'creativeasin']);
function stripTracking(url) {
  const u = new URL(url.toString());
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k) || k.startsWith('ref')) u.searchParams.delete(key);
  }
  u.hash = '';
  return u;
}

// rawUrl -> { hostname, asin, cleanUrl }.
// Product links collapse to https://<host>/dp/<ASIN>; non-product Amazon pages
// (search, storefront, deals) keep their path/query with tracking stripped so we
// can still affiliate them (asin is null in that case).
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
  } else if (isDeepLink(prelim.hostname)) {
    target = await resolveDeepLink(rawUrl);
    // The extracted Amazon URL may itself be a short link (amzn.to/a.co/…).
    try {
      if (isShortLink(new URL(target).hostname)) target = await resolveShortLink(target);
    } catch {
      /* ignore */
    }
  }

  const url = validateAmazonUrl(target);
  const asin = extractAsin(url.pathname);
  if (asin) {
    return { hostname: url.hostname, asin, cleanUrl: `https://${url.hostname}/dp/${asin}` };
  }
  // Non-product Amazon page — affiliate the page itself.
  return { hostname: url.hostname, asin: null, cleanUrl: stripTracking(url).toString() };
}

// TAG mode: rewrite to https://<host>/dp/<ASIN>?tag=<TAG> (no session).
function buildTagUrl(hostname, asin, tag) {
  const u = new URL(`https://${hostname}/dp/${asin}`);
  u.searchParams.set('tag', tag);
  return u.toString();
}

// Expand an affiliate link (incl. link.amazon / amzn.to short links) and report
// the tag it actually carries, so an admin can confirm attribution is theirs.
async function verifyAffiliate(affiliateUrl) {
  let res;
  try {
    res = await fetchWithTimeout(affiliateUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': BROWSER_UA },
    });
  } catch {
    throw new ApiError(502, 'Could not expand the affiliate link.');
  }
  const finalUrl = res.url || affiliateUrl;
  let tag = null;
  let sitestripe = false;
  try {
    const u = new URL(finalUrl);
    tag = u.searchParams.get('tag');
    // SiteStripe links attribute via these markers, not a tag param.
    sitestripe =
      u.searchParams.get('btn_type') === 'ss' ||
      u.searchParams.has('ascsubtag') ||
      u.searchParams.has('btn_ref');
  } catch {
    /* ignore */
  }
  return { finalUrl, tag, sitestripe };
}

// Append our tag to any (already-cleaned) Amazon URL — used for non-product pages.
function appendTag(cleanUrl, tag) {
  const u = new URL(cleanUrl);
  u.searchParams.delete('tag');
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
    // Expired SiteStripe sessions typically return a 200 HTML login page (not a
    // 401). Treat a non-JSON response as an expired/invalid session (status 401
    // so it flags the dashboard and falls back to TAG).
    throw new ApiError(401, 'SiteStripe session looks expired (Amazon returned a login/HTML page). Paste a fresh cURL.');
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
  appendTag,
  verifyAffiliate,
  extractAsin,
};
