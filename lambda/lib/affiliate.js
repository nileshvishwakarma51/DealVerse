'use strict';

// Amazon affiliate link generation with mode toggle + fallback, ported from the
// reference project's affiliateService.ts. Shared by the HTTP route and the
// Telegram webhook so both behave identically.
const { ApiError } = require('./errors');
const { getConfig } = require('./store');
const { buildCleanProductUrl, requestShortUrl, buildTagUrl } = require('./amazon');
const { fetchProductMeta } = require('./productMeta');

const SITESTRIPE_KEY = 'sitestripe';
const AMAZON_KEY = 'amazon';
const DEFAULT_AMAZON = { mode: 'TAG', tag: '' };

// Core: rawUrl -> { success, platform, method, fallback, affiliateUrl, resolvedUrl, asin }
async function buildLink(rawUrl) {
  const amazon = (await getConfig(AMAZON_KEY)) || DEFAULT_AMAZON;
  const { cleanUrl, asin, hostname } = await buildCleanProductUrl(rawUrl);

  // SITE_STRIPE mode: try the live call, fall back to TAG on any error.
  if (amazon.mode === 'SITE_STRIPE') {
    const siteStripe = await getConfig(SITESTRIPE_KEY);
    if (siteStripe) {
      try {
        const shortUrl = await requestShortUrl(siteStripe, cleanUrl);
        return { success: true, platform: 'amazon', method: 'sitestripe', fallback: false, affiliateUrl: shortUrl, resolvedUrl: cleanUrl, asin };
      } catch (err) {
        if (!amazon.tag) {
          throw new ApiError(
            err instanceof ApiError ? err.status : 502,
            `${err.message} No affiliate tag is configured for fallback.`
          );
        }
      }
    } else if (!amazon.tag) {
      throw new ApiError(400, 'SiteStripe session is not configured and there is no tag to fall back to.');
    }
    // Fallback (or no session): TAG mode.
    return { success: true, platform: 'amazon', method: 'tag', fallback: true, affiliateUrl: buildTagUrl(hostname, asin, amazon.tag), resolvedUrl: cleanUrl, asin };
  }

  // TAG mode: pure rewrite.
  if (!amazon.tag) {
    throw new ApiError(400, 'No affiliate tag configured. Ask an admin to set it up.');
  }
  return { success: true, platform: 'amazon', method: 'tag', fallback: false, affiliateUrl: buildTagUrl(hostname, asin, amazon.tag), resolvedUrl: cleanUrl, asin };
}

// Public: build the link and best-effort attach product title + price.
async function generateAmazonLink(rawUrl, { withMeta = true } = {}) {
  const result = await buildLink(rawUrl);
  if (withMeta) {
    result.product = await fetchProductMeta(result.resolvedUrl);
  }
  return result;
}

module.exports = { generateAmazonLink, SITESTRIPE_KEY, AMAZON_KEY, DEFAULT_AMAZON };
