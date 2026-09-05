'use strict';

// Price-change tracker — a configurable store of products that were posted to a
// channel, so a daily check can re-read their current price and re-post a drop
// alert when the price fell further than the stored snapshot.
//
// STORAGE: a tenant-scoped config blob `pricechange = { items: [...] }`. Each
// item holds one product URL with the price + date it was stored at (baseline).
// Items are pruned by TTL (ttlDays, default 7) — enforced on read and in the
// daily check — so the store never grows unbounded.
//
// CAP: at most `maxPerDay` (default 50) NEW products are stored per IST day.
// Re-posting an already-stored product is skipped, so one product never fills
// the daily budget or resets its snapshot.
//
// HOW IT IS FED: every real "post to a channel" funnels through
// telegram.publishToChannels, which calls storeFromMessage(text) best-effort.
// This covers website-generated links, listener/automation posts, MTProto
// ingest, bot user replies and custom broadcasts.
//
// DAILY CHECK: run from the cron tick, once per IST day (gated on lastRunDate).
// For each stored product it re-fetches the current price; if it dropped below
// the baseline it posts "was ₹X on <date> → now ₹Y" to the merchant's channels
// and ratchets the baseline down so further drops alert again.
const crypto = require('crypto');
const { getConfig, setConfig } = require('./store');
const { getProductPrice, round2 } = require('./price');
const { activeLinks } = require('./links');
const { getActivePlatforms } = require('./affiliate');
const { logAudit } = require('./audit');

const BLOB_KEY = 'pricechange';
const CONFIG_KEY = 'pricechange_config';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  enabled: true,
  maxPerDay: 50,
  ttlDays: 7,
  lastRunDate: null,
};

function istDay(offsetMs) {
  return new Date(Date.now() + (offsetMs || IST_OFFSET_MS)).toISOString().slice(0, 10);
}

function clampInt(n, def, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(v, min), max);
}

// ── Config ───────────────────────────────────────────────────────────────────
async function getPCConfig() {
  const c = (await getConfig(CONFIG_KEY)) || {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    maxPerDay: clampInt(c.maxPerDay, DEFAULT_CONFIG.maxPerDay, 1, 200),
    ttlDays: clampInt(c.ttlDays, DEFAULT_CONFIG.ttlDays, 1, 30),
  };
}

async function setPCConfig({ enabled, maxPerDay, ttlDays }) {
  const cur = await getPCConfig();
  const next = {
    enabled: typeof enabled === 'boolean' ? enabled : cur.enabled,
    maxPerDay: clampInt(maxPerDay, cur.maxPerDay, 1, 200),
    ttlDays: clampInt(ttlDays, cur.ttlDays, 1, 30),
    lastRunDate: cur.lastRunDate || null,
  };
  await setConfig(CONFIG_KEY, next);
  return next;
}

// ── Blob helpers (prune by TTL on every read) ────────────────────────────────
async function loadItems() {
  const blob = await getConfig(BLOB_KEY);
  return prune((blob && Array.isArray(blob.items) ? blob.items : []), (await getPCConfig()).ttlDays);
}

async function saveItems(items) {
  await setConfig(BLOB_KEY, { items });
}

// Drop products whose storedDate is older than ttlDays. Returns a new array.
function prune(items, ttlDays) {
  const days = clampInt(ttlDays, 7, 1, 30);
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).getTime();
  return (items || []).filter((it) => it && it.createdAt && Date.parse(it.createdAt) >= cutoff);
}

async function counts() {
  const items = await loadItems();
  const today = istDay();
  const storedToday = items.filter((it) => it.storedDay === today).length;
  return { total: items.length, storedToday, dropped: items.reduce((s, it) => s + (it.drops || 0), 0) };
}

function getById(items, url) {
  const key = String(url || '').toLowerCase();
  return items.find((it) => it && String(it.url).toLowerCase() === key) || null;
}

// Record a product from a message that was just posted to a channel. Best-effort
// and short-circuits cheaply when the feature is off, the message has no active
// product link, or the daily cap is already reached.
async function storeFromMessage(text) {
  const cfg = await getPCConfig();
  if (!cfg.enabled) return { stored: 0, reason: 'disabled' };

  const urls = activeLinks(String(text || '').match(/https?:\/\/[^\s]+/gi) || [], await getActivePlatforms());
  if (!urls.length) return { stored: 0, reason: 'no-link' };

  const today = istDay();
  const items = await loadItems();
  const already = getById(items, urls[0]);

  // Already-stored product: skip the re-store so the original snapshot (and its
  // drop detection) is preserved without consuming a daily slot.
  if (already) {
    return { stored: 1, reason: 'updated', id: already.id };
  }

  const storedToday = items.filter((it) => it.storedDay === today).length;
  if (storedToday >= cfg.maxPerDay) return { stored: 0, reason: 'cap' };

  const url = urls[0];
  let snap;
  try {
    snap = await getProductPrice(url); // auto-detect amazon/flipkart
  } catch {
    return { stored: 0, reason: 'fetch-failed' };
  }
  const price = round2(snap.price);
  if (price == null || price <= 0) return { stored: 0, reason: 'no-price' };

  const now = new Date().toISOString();
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    url: snap.productUrl || snap.canonicalUrl || url,
    affiliateUrl: null,
    title: snap.title || null,
    marketplace: snap.marketplace,
    currency: snap.currency || '',
    price,
    priceDate: today,
    storedDay: today,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    drops: 0,
  };
  items.push(item);
  await saveItems(items);

  await logAudit('pricechange', `Stored product "${item.title || item.url}" at ${snap.currency || ''}${price} (${today}).`);
  return { stored: 1, reason: 'stored', id: item.id };
}

// ── Daily check (once per IST day) ───────────────────────────────────────────
async function runDailyCheck(deadline) {
  const cfg = await getPCConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  const today = istDay();
  if (cfg.lastRunDate === today) return { skipped: 'already-run' };

  const items = await loadItems(); // prunes expired
  // Stamp the run date immediately so a second tick the same day won't re-run.
  await setConfig(CONFIG_KEY, { ...cfg, lastRunDate: today });
  await saveItems(items);

  if (!items.length) return { checked: 0, dropped: 0 };

  let checked = 0;
  let dropped = 0;
  for (const it of items) {
    if (deadline && Date.now() > deadline - 3000) break;
    checked += 1;
    let snap;
    try {
      snap = await getProductPrice(it.url);
    } catch {
      continue; // transient fetch failure — try again next day
    }
    const cur = round2(snap.price);
    if (cur != null && cur > 0 && cur < it.price) {
      const prevPrice = it.price;
      const prevDate = it.priceDate;
      const title = it.title || snap.title || 'tracked product';
      const currency = it.currency || snap.currency || '';
      const link = it.affiliateUrl || snap.canonicalUrl || snap.productUrl || it.url;
      const text = `📉 Price drop!\n\n${title}\n\nWas: ${currency}${prevPrice} (${prevDate})\nNow: ${currency}${cur}\n\n${link}`;
      // eslint-disable-next-line global-require
      const tg = require('./telegram');
      try {
        // Best-effort publish to the merchant's channels; `store:false` keeps
        // this alert from being siphoned back into the store.
        const n = await tg.publishToChannels(text, { store: false });
        if (n > 0) dropped += 1;
      } catch {
        /* publish failed — still ratchet below so we don't spam it */
      }
      it.price = cur;
      it.priceDate = today;
      it.drops = (it.drops || 0) + 1;
    }
    it.lastCheckedAt = new Date().toISOString();
  }
  await saveItems(items);

  await logAudit('pricechange', `Daily check: ${checked} product(s), ${dropped} price drop(s) posted.`);
  return { checked, dropped };
}

module.exports = { BLOB_KEY, CONFIG_KEY, getPCConfig, setPCConfig, counts, storeFromMessage, runDailyCheck, prune };
