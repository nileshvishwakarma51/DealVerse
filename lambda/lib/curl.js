'use strict';

// Parses a "Copy as cURL" command (Chrome DevTools) WITHOUT executing it, and
// extracts the SiteStripe session (endpoint + headers + cookies). Ported from
// the reference project's siteStripeService.ts.
const { ApiError } = require('./errors');

// Safe suffix allowlist for Amazon storefronts across regions. A host matches
// only if it equals a suffix or ends with ".<suffix>" (so amazon.com.evil.com
// is rejected).
const AMAZON_SUFFIXES = [
  'amazon.in',
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'amazon.ae',
  'amazon.com.au',
  'amazon.ca',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.se',
  'amazon.sg',
  'amazon.co.jp',
  'amazon.com.br',
  'amazon.com.mx',
];

// Amazon short-link hosts (redirect to a full product URL).
const SHORT_LINK_HOSTS = new Set([
  'a.co',
  'www.a.co',
  'amzn.to',
  'www.amzn.to',
  'amzn.in',
  'www.amzn.in',
  'amzn.eu',
  'amzn.com',
  'link.amazon', // Amazon SiteStripe short domain (also what we generate)
  'www.link.amazon',
]);

function isAmazonHost(host) {
  const h = String(host).toLowerCase();
  return AMAZON_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

function isShortLink(host) {
  return SHORT_LINK_HOSTS.has(String(host).toLowerCase());
}

// Third-party deal shorteners that wrap an Amazon link (redirect chain and/or an
// embedded ?url= param). Resolved by following redirects + extracting the
// embedded Amazon URL (see amazon.js resolveDeepLink).
const DEEP_LINK_HOSTS = new Set(['amznn.cc', 'www.amznn.cc']);
function isDeepLink(host) {
  return DEEP_LINK_HOSTS.has(String(host).toLowerCase());
}

// Tokenizer: handles \-newline continuations, '...' (literal), "..." (escapes),
// and bare tokens.
function tokenize(input) {
  const s = input.replace(/\\\r?\n/g, ' ');
  const n = s.length;
  const tokens = [];
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    let token = '';
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      if (c === "'") {
        i++;
        while (i < n && s[i] !== "'") token += s[i++];
        i++; // skip closing quote
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < n) {
            token += s[i + 1];
            i += 2;
            continue;
          }
          token += s[i++];
        }
        i++; // skip closing quote
        continue;
      }
      token += c;
      i++;
    }
    tokens.push(token);
  }
  return tokens;
}

function addHeader(headers, raw) {
  const idx = raw.indexOf(':');
  if (idx === -1) return;
  const name = raw.slice(0, idx).trim().toLowerCase();
  const value = raw.slice(idx + 1).trim();
  if (name) headers[name] = value;
}

// If the -b arg has no "=", cURL treats it as a cookie FILE path — deliberately
// ignored (we never read local files); cookies then come from the cookie header.
function parseCookies(cookieArg, headers) {
  const cookies = {};
  const source = cookieArg && cookieArg.includes('=') ? cookieArg : headers.cookie || '';
  if (!source) return cookies;
  for (const part of source.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (k) cookies[k] = v;
  }
  return cookies;
}

const NO_VALUE_FLAGS = new Set([
  '--compressed',
  '--silent',
  '-s',
  '--location',
  '-L',
  '--insecure',
  '-k',
]);

function parseCurl(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'Paste a cURL command.');
  }
  const tokens = tokenize(raw.trim());
  if (tokens.length && /^curl$/i.test(tokens[0])) tokens.shift();

  const headers = {};
  let url = null;
  let method = null;
  let cookieArg = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (NO_VALUE_FLAGS.has(t)) continue;
    if (t === '--url') {
      url = tokens[++i];
      continue;
    }
    if (t.startsWith('--url=')) {
      url = t.slice(6);
      continue;
    }
    if (t === '-H' || t === '--header') {
      const h = tokens[++i];
      if (h) addHeader(headers, h);
      continue;
    }
    if (t === '-b' || t === '--cookie') {
      cookieArg = tokens[++i];
      continue;
    }
    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase();
      continue;
    }
    if (t === '-d' || t === '--data' || t.startsWith('--data')) {
      i++; // consume and discard the body
      continue;
    }
    if (!url && /^https?:\/\//i.test(t)) {
      url = t;
      continue;
    }
    // Anything else: skip safely.
  }

  if (!url) throw new ApiError(400, 'No URL found in the cURL command.');
  if (!method) method = 'GET';

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ApiError(400, 'The cURL URL is invalid.');
  }

  const query = {};
  for (const [k, v] of parsedUrl.searchParams.entries()) query[k] = v;

  const cookies = parseCookies(cookieArg, headers);

  return {
    method,
    url: parsedUrl.toString(),
    hostname: parsedUrl.hostname,
    pathname: parsedUrl.pathname,
    query,
    headers,
    cookies,
    longUrl: query.longUrl || null,
    marketplaceId: query.marketplaceId || null,
    storeId: query.storeId || null,
  };
}

// The endpoint must be the Amazon SiteStripe getShortUrl request.
function validateSiteStripeEndpoint(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Invalid SiteStripe endpoint URL.');
  }
  if (u.protocol !== 'https:') {
    throw new ApiError(400, 'SiteStripe endpoint must be https.');
  }
  if (!isAmazonHost(u.hostname)) {
    throw new ApiError(400, 'SiteStripe endpoint host is not an allowed Amazon domain.');
  }
  if (!/\/associates\/sitestripe\/getShortUrl$/.test(u.pathname)) {
    throw new ApiError(
      400,
      'The cURL must be the SiteStripe getShortUrl request (copy it from the Amazon Associates SiteStripe bar).'
    );
  }
  return u;
}

function validateParsedCurl(parsed) {
  if (parsed.method !== 'GET') {
    throw new ApiError(400, 'The SiteStripe cURL must be a GET request.');
  }
  validateSiteStripeEndpoint(parsed.url);
}

module.exports = {
  parseCurl,
  validateParsedCurl,
  validateSiteStripeEndpoint,
  isAmazonHost,
  isShortLink,
  isDeepLink,
};
