'use strict';

// Amazon affiliate link generation with mode toggle + fallback, ported from the
// reference project's affiliateService.ts. Shared by the HTTP route and the
// Telegram webhook so both behave identically.
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');
const { buildCleanProductUrl, requestShortUrl, buildTagUrl, appendTag } = require('./amazon');
const { fetchProductMeta } = require('./productMeta');

const SITESTRIPE_KEY = 'sitestripe';
const AMAZON_KEY = 'amazon';
const DEFAULT_AMAZON = { mode: 'TAG', tag: '' };
const TEST_PRODUCT_URL = 'https://www.amazon.in/dp/B0CHN2YDPG';

// Persist the SiteStripe session health so the dashboard can show it.
// Best-effort — never let a status write break link generation.
async function flagSiteStripe(siteStripe, status) {
  try {
    if (!siteStripe || siteStripe.status === status) return;
    await setConfig(SITESTRIPE_KEY, {
      ...siteStripe,
      status,
      ...(status === 'expired'
        ? { expiredAt: new Date().toISOString() }
        : { expiredAt: null }),
    });
  } catch {
    /* ignore */
  }
}

// Core: rawUrl -> { success, platform, method, fallback, affiliateUrl, resolvedUrl, asin }
async function buildLink(rawUrl) {
  const amazon = (await getConfig(AMAZON_KEY)) || DEFAULT_AMAZON;
  const { cleanUrl, asin, hostname } = await buildCleanProductUrl(rawUrl);
  // TAG URL works for products (/dp/ASIN) and non-product pages alike.
  const tagUrl = (tag) => (asin ? buildTagUrl(hostname, asin, tag) : appendTag(cleanUrl, tag));

  // SITE_STRIPE mode: try the live call, fall back to TAG on any error.
  if (amazon.mode === 'SITE_STRIPE') {
    const siteStripe = await getConfig(SITESTRIPE_KEY);
    if (siteStripe) {
      try {
        const shortUrl = await requestShortUrl(siteStripe, cleanUrl);
        await flagSiteStripe(siteStripe, 'ok'); // clears any prior "expired"
        return { success: true, platform: 'amazon', method: 'sitestripe', fallback: false, affiliateUrl: shortUrl, resolvedUrl: cleanUrl, asin };
      } catch (err) {
        // A 401/403 means the session is dead — flag it so the dashboard shows it.
        if (err instanceof ApiError && err.status === 401) {
          await flagSiteStripe(siteStripe, 'expired');
        }
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
    return { success: true, platform: 'amazon', method: 'tag', fallback: true, affiliateUrl: tagUrl(amazon.tag), resolvedUrl: cleanUrl, asin };
  }

  // TAG mode: pure rewrite.
  if (!amazon.tag) {
    throw new ApiError(400, 'No affiliate tag configured. Ask an admin to set it up.');
  }
  return { success: true, platform: 'amazon', method: 'tag', fallback: false, affiliateUrl: tagUrl(amazon.tag), resolvedUrl: cleanUrl, asin };
}

// Public: build the link and best-effort attach product title + price.
async function generateAmazonLink(rawUrl, { withMeta = true } = {}) {
  const result = await buildLink(rawUrl);
  if (withMeta) {
    result.product = await fetchProductMeta(result.resolvedUrl);
  }
  return result;
}

// On-demand: run one live SiteStripe call and record whether it works.
async function testSiteStripe() {
  const siteStripe = await getConfig(SITESTRIPE_KEY);
  if (!siteStripe) throw new ApiError(400, 'No SiteStripe session configured yet.');
  try {
    const shortUrl = await requestShortUrl(siteStripe, TEST_PRODUCT_URL);
    await setConfig(SITESTRIPE_KEY, {
      ...siteStripe,
      status: 'ok',
      expiredAt: null,
      testedAt: new Date().toISOString(),
    });
    return { working: true, shortUrl };
  } catch (err) {
    const expired = err instanceof ApiError && err.status === 401;
    await setConfig(SITESTRIPE_KEY, {
      ...siteStripe,
      status: expired ? 'expired' : siteStripe.status || 'ok',
      ...(expired ? { expiredAt: new Date().toISOString() } : {}),
      testedAt: new Date().toISOString(),
    });
    return { working: false, expired, error: err.message };
  }
}

module.exports = { generateAmazonLink, testSiteStripe, SITESTRIPE_KEY, AMAZON_KEY, DEFAULT_AMAZON };
