'use strict';

// Pure link classification for the supported affiliate platforms. No config, no
// other module dependencies — safe to require from anywhere. Whether a platform
// is currently ON/OFF is decided by callers using affiliate.getActivePlatforms().

// Amazon: full domains, short links, and the amznn.cc / a.co shorteners.
const AMAZON_RE = /(?:amazon\.[a-z.]+|amzn\.[a-z]+|link\.amazon|amznn\.cc|a\.co)\//i;
// Flipkart: any *.flipkart.com plus the fkrt.* short links.
const FLIPKART_RE = /(?:(?:[a-z0-9-]+\.)?flipkart\.com|fkrt\.[a-z]+)\//i;

function classify(url) {
  const s = String(url || '');
  if (AMAZON_RE.test(s)) return 'amazon';
  if (FLIPKART_RE.test(s)) return 'flipkart';
  return null;
}

// Deduped [{ url, platform }] for every supported link found (any platform).
function dealLinks(links) {
  const out = [];
  const seen = new Set();
  for (const l of links || []) {
    const platform = classify(l);
    if (platform && !seen.has(l)) {
      seen.add(l);
      out.push({ url: l, platform });
    }
  }
  return out;
}

// URLs whose platform is currently active. active = { amazon: bool, flipkart: bool }.
function activeLinks(links, active) {
  return dealLinks(links)
    .filter((d) => active && active[d.platform])
    .map((d) => d.url);
}

module.exports = { AMAZON_RE, FLIPKART_RE, classify, dealLinks, activeLinks };
