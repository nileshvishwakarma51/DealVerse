'use strict';

// Flipkart affiliate support.
//
// Unlike Amazon (converted inside this Lambda via SiteStripe / tag), Flipkart
// links are converted by an EXTERNAL Telegram "conversion bot" (e.g. an EarnKaro
// bot). Telegram bots cannot message other bots, so we drive the conversion
// through the merchant's logged-in USER account (MTProto): we DM the bot the raw
// link and read the affiliate link out of its reply. Flipkart therefore REQUIRES
// MTProto login. All config lives under the tenant "flipkart" key.
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');

const FLIPKART_KEY = 'flipkart';
const DEFAULT_FLIPKART = { active: false, botUsername: '' };

async function getFlipkart() {
  return { ...DEFAULT_FLIPKART, ...((await getConfig(FLIPKART_KEY)) || {}) };
}

// Non-sensitive view for the UI.
function maskFlipkart(cfg) {
  const c = { ...DEFAULT_FLIPKART, ...(cfg || {}) };
  return { active: !!c.active, botUsername: c.botUsername || '', configuredAt: c.configuredAt || null };
}

function normalizeBotUsername(input) {
  return String(input || '')
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '');
}

async function saveFlipkart({ active, botUsername }) {
  const cfg = await getFlipkart();
  if (botUsername !== undefined) {
    const u = normalizeBotUsername(botUsername);
    if (u && !/^[A-Za-z0-9_]{3,}$/.test(u)) {
      throw new ApiError(400, 'Enter a valid conversion-bot @username.');
    }
    cfg.botUsername = u;
  }
  if (typeof active === 'boolean') cfg.active = active;
  if (cfg.active && !cfg.botUsername) {
    throw new ApiError(400, 'Set the conversion-bot @username before turning Flipkart on.');
  }
  cfg.configuredAt = new Date().toISOString();
  await setConfig(FLIPKART_KEY, cfg);
  return maskFlipkart(cfg);
}

// Pick the affiliate link out of the bot's reply: prefer a Flipkart/short link
// that differs from what we sent.
function pickAffiliate(inputUrl, text, links) {
  const all = [...(links || [])];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s]+/gi)) all.push(m[0]);
  const norm = (u) => String(u).replace(/[).,\s]+$/, '');
  const cleaned = all.map(norm).filter(Boolean);
  const isFk = (u) => /(?:[a-z0-9-]+\.)?flipkart\.com\/|fkrt\.[a-z]+\/|ekaro\.in\/|earnkaro\.com\//i.test(u);
  const fk = cleaned.filter(isFk);
  return fk.find((u) => u !== inputUrl) || fk[0] || cleaned.find((u) => u !== inputUrl) || null;
}

// Convert one Flipkart URL. Requires Flipkart active + a configured bot + an
// MTProto session (checked downstream). Returns the same shape as the Amazon
// engine so all callers treat platforms uniformly.
async function convert(rawUrl) {
  const cfg = await getFlipkart();
  if (!cfg.active) throw new ApiError(400, 'Flipkart link support is turned off.');
  if (!cfg.botUsername) throw new ApiError(400, 'No Flipkart conversion bot is configured.');
  // Lazy require breaks the static cycle affiliate → flipkart → mtproto → affiliate.
  // eslint-disable-next-line global-require
  const mtproto = require('./mtproto');
  const { text, links } = await mtproto.sendToBot(cfg.botUsername, rawUrl, { timeoutMs: 18000 });
  const affiliateUrl = pickAffiliate(rawUrl, text, links);
  if (!affiliateUrl) {
    throw new ApiError(502, 'The conversion bot replied but no affiliate link could be read from it.');
  }
  return {
    success: true,
    platform: 'flipkart',
    method: 'bot',
    fallback: false,
    affiliateUrl,
    resolvedUrl: rawUrl,
    asin: null,
  };
}

// On-demand test from the admin UI (the merchant pastes a real product link).
async function testConversion(url) {
  const sample = String(url || '').trim();
  if (!sample) throw new ApiError(400, 'Paste a Flipkart product link to test.');
  const r = await convert(sample);
  return { working: true, affiliateUrl: r.affiliateUrl };
}

module.exports = {
  FLIPKART_KEY,
  DEFAULT_FLIPKART,
  getFlipkart,
  maskFlipkart,
  saveFlipkart,
  convert,
  testConversion,
};
