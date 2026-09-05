'use strict';

// Price-tracker repository + alert engine.
//
// STORAGE: one tenant-scoped config blob `pricetrackers = { items: [...] }`
// (a merchant has a handful of trackers, so no GSI). Admin cron settings live in a
// separate `pricetracker_config` item.
//
// TWO ALERT MODES per tracker:
//   DECREASE  — trailing: alert when the price hits a new low vs the last price we
//               alerted on (lastNotifiedPrice), which then ratchets down. One ping
//               per new low.
//   THRESHOLD — alert once when the price first reaches <= a user-set target, then
//               stay quiet until it rises back above the target (re-arm) so it does
//               not ping every cron tick while it sits below.
//
// CONCURRENCY: a short-lived DynamoDB lock (`pricelock`) serialises every
// read-modify-write of the blob and the cron "claim" step. Slow network fetches
// happen OUTSIDE the lock.
const crypto = require('crypto');
const {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { getConfig, setConfig, getTenant } = require('./store');
const { getProductPrice, round2 } = require('./price');
const { logAudit } = require('./audit');

const BLOB_KEY = 'pricetrackers';
const CONFIG_KEY = 'pricetracker_config';
const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

const LOCK_TTL_SEC = 70;
const LOCK_RETRIES = 8;
const LOCK_RETRY_MS = 300;

const MAX_PER_RUN = Number(process.env.PRICE_MAX_PER_RUN) || 20; // trackers per cron sweep
const MAX_TRACKERS_PER_USER = Number(process.env.PRICE_MAX_PER_USER) || 25;

const DEFAULT_CONFIG = { enabled: true, intervalHours: 6, lastRunAt: null };

function clampHours(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_CONFIG.intervalHours;
  return Math.min(Math.max(v, 1), 168); // 1h … 7 days
}

// ── Trailing / threshold decisions (pure; exported for tests) ────────────────
function shouldNotifyDecrease(newPrice, lastNotifiedPrice) {
  const a = round2(newPrice);
  const b = round2(lastNotifiedPrice);
  if (a == null || b == null) return false;
  return a < b;
}

// Evaluate a tracker against a freshly-fetched price. Returns whether to notify,
// the patch to persist ALWAYS (basePatch), and the patch to persist ONLY after a
// successful send (onNotifyPatch — so a failed delivery is retried next time).
function evaluate(tracker, rawPrice) {
  const price = round2(rawPrice);
  const cc = (tracker.checkCount || 0) + 1;
  if (price == null || price <= 0) {
    return { price: null, notify: false, basePatch: { checkCount: cc }, onNotifyPatch: {} };
  }
  const basePatch = { lastPrice: price, checkCount: cc };

  if (tracker.mode === 'THRESHOLD') {
    const thr = round2(tracker.threshold);
    const below = thr != null && price <= thr;
    if (below && !tracker.thresholdNotified) {
      return { price, notify: true, basePatch, onNotifyPatch: { thresholdNotified: true } };
    }
    if (!below && tracker.thresholdNotified) {
      // Rose back above target → re-arm for the next crossing.
      return { price, notify: false, basePatch: { ...basePatch, thresholdNotified: false }, onNotifyPatch: {} };
    }
    return { price, notify: false, basePatch, onNotifyPatch: {} };
  }

  // DECREASE (trailing new-low)
  if (shouldNotifyDecrease(price, tracker.lastNotifiedPrice)) {
    return { price, notify: true, basePatch, onNotifyPatch: { lastNotifiedPrice: price } };
  }
  return { price, notify: false, basePatch, onNotifyPatch: {} };
}

// ── Lock ─────────────────────────────────────────────────────────────────────
function lockId() {
  return `pricelock#${getTenant()}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock() {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: { id: { S: lockId() }, ttl: { N: String(nowSec + LOCK_TTL_SEC) }, at: { S: new Date().toISOString() } },
        ConditionExpression: 'attribute_not_exists(id) OR #t < :now',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: { ':now': { N: String(nowSec) } },
      })
    );
    return true;
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
async function releaseLock() {
  try {
    await ddb.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { id: { S: lockId() } } }));
  } catch {
    /* lock TTL-expires on its own */
  }
}
async function withLock(fn) {
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await acquireLock()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await fn();
        return { acquired: true, result };
      } finally {
        await releaseLock();
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(LOCK_RETRY_MS);
  }
  return { acquired: false };
}

// ── Blob helpers ─────────────────────────────────────────────────────────────
// Read one tracker written by any version into the current shape. Keeps upgrades
// non-breaking (v1 used `active` bool + a single trailing mode).
function normalize(t) {
  if (!t || typeof t !== 'object') return t;
  const status = t.status || (t.active === false ? 'paused' : 'active');
  return {
    thresholdNotified: false,
    mode: 'DECREASE',
    threshold: null,
    affiliateUrl: t.affiliateUrl || t.canonicalUrl || t.productUrl,
    ...t,
    status,
  };
}
async function loadItems() {
  const blob = await getConfig(BLOB_KEY);
  const arr = blob && Array.isArray(blob.items) ? blob.items : [];
  return arr.map(normalize);
}
async function saveItems(items) {
  await setConfig(BLOB_KEY, { items });
}

// ── Config (admin cron settings) ─────────────────────────────────────────────
async function getPtConfig() {
  const c = (await getConfig(CONFIG_KEY)) || {};
  return { ...DEFAULT_CONFIG, ...c, intervalHours: clampHours(c.intervalHours ?? DEFAULT_CONFIG.intervalHours) };
}
// Admin update — preserves lastRunAt.
async function setPtConfig({ enabled, intervalHours }) {
  const cur = await getPtConfig();
  const next = { enabled: !!enabled, intervalHours: clampHours(intervalHours), lastRunAt: cur.lastRunAt || null };
  await setConfig(CONFIG_KEY, next);
  return next;
}
async function counts() {
  const items = await loadItems();
  return {
    total: items.length,
    active: items.filter((t) => t.status === 'active').length,
    paused: items.filter((t) => t.status === 'paused').length,
  };
}

// ── Reads (no lock) ──────────────────────────────────────────────────────────
async function listTrackers(userId) {
  const items = await loadItems();
  return items.filter((t) => String(t.userId) === String(userId));
}
async function getTracker(id) {
  const items = await loadItems();
  return items.find((t) => t.id === id) || null;
}

// ── Mutations (locked) ───────────────────────────────────────────────────────
async function addTracker({ userId, chatId, snapshot, affiliateUrl, mode, threshold }) {
  const now = new Date().toISOString();
  const price = round2(snapshot.price);
  const m = mode === 'THRESHOLD' ? 'THRESHOLD' : 'DECREASE';
  const outcome = await withLock(async () => {
    const items = await loadItems();
    const mine = items.filter((t) => String(t.userId) === String(userId));
    if (mine.length >= MAX_TRACKERS_PER_USER) return { limit: true };
    // Short, collision-free id (callback_data must stay under 64 bytes).
    let id;
    do {
      id = crypto.randomBytes(4).toString('hex');
    } while (items.some((t) => t.id === id));
    const tracker = {
      id,
      userId: String(userId),
      chatId,
      marketplace: snapshot.marketplace,
      title: snapshot.title || null,
      productUrl: snapshot.productUrl,
      canonicalUrl: snapshot.canonicalUrl || snapshot.productUrl,
      affiliateUrl: affiliateUrl || snapshot.canonicalUrl || snapshot.productUrl,
      currency: snapshot.currency || '',
      mode: m,
      threshold: m === 'THRESHOLD' ? round2(threshold) : null,
      startPrice: price,
      lastPrice: price,
      lastNotifiedPrice: price,
      thresholdNotified: false,
      status: 'active',
      checkCount: 0,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: now,
    };
    items.push(tracker);
    await saveItems(items);
    return { tracker };
  });
  if (!outcome.acquired) throw new Error('Could not save the tracker right now. Please try again.');
  if (outcome.result.limit) {
    const err = new Error(`You already have ${MAX_TRACKERS_PER_USER} trackers. Delete one first.`);
    err.limit = true;
    throw err;
  }
  return outcome.result.tracker;
}

async function updateTracker(id, userId, patch) {
  const outcome = await withLock(async () => {
    const items = await loadItems();
    const idx = items.findIndex((t) => t.id === id && String(t.userId) === String(userId));
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...patch, updatedAt: new Date().toISOString() };
    await saveItems(items);
    return items[idx];
  });
  return outcome.acquired ? outcome.result : null;
}

async function setStatus(id, userId, status) {
  return updateTracker(id, userId, { status });
}
const stopTracker = (id, userId) => setStatus(id, userId, 'paused');
const resumeTracker = (id, userId) => setStatus(id, userId, 'active');

async function deleteTracker(id, userId) {
  const outcome = await withLock(async () => {
    const items = await loadItems();
    const idx = items.findIndex((t) => t.id === id && String(t.userId) === String(userId));
    if (idx === -1) return false;
    items.splice(idx, 1);
    await saveItems(items);
    return true;
  });
  return outcome.acquired ? outcome.result : false;
}

// Switch an existing tracker's mode (from the Edit flow). Re-baselines DECREASE to
// the current price and clears the threshold arm state.
async function setMode(id, userId, mode, threshold) {
  const t = await getTracker(id);
  if (!t || String(t.userId) !== String(userId)) return null;
  if (mode === 'THRESHOLD') {
    return updateTracker(id, userId, { mode: 'THRESHOLD', threshold: round2(threshold), thresholdNotified: false });
  }
  return updateTracker(id, userId, { mode: 'DECREASE', lastNotifiedPrice: t.lastPrice != null ? t.lastPrice : t.startPrice });
}

// ── Cron sweep ───────────────────────────────────────────────────────────────
// Claim the sweep (gate by admin interval, stamp lastRunAt, claim active trackers).
async function claimSweep() {
  return withLock(async () => {
    const cfg = await getPtConfig();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    const now = Date.now();
    if (cfg.lastRunAt && now - Date.parse(cfg.lastRunAt) < cfg.intervalHours * 3600e3) {
      return { ok: false, reason: 'interval' };
    }
    const stampedAt = new Date(now).toISOString();
    await setConfig(CONFIG_KEY, { enabled: cfg.enabled, intervalHours: cfg.intervalHours, lastRunAt: stampedAt });
    const items = await loadItems();
    const due = items.filter((t) => t.status === 'active').slice(0, MAX_PER_RUN);
    const ids = new Set(due.map((t) => t.id));
    for (const t of items) if (ids.has(t.id)) t.lastCheckedAt = stampedAt;
    await saveItems(items);
    return { ok: true, due: due.map((t) => ({ ...t })) };
  });
}

async function checkAll(deadline) {
  const claim = await claimSweep();
  if (!claim.acquired) return { skipped: 'locked' };
  if (!claim.result.ok) return { skipped: claim.result.reason };
  const claimed = claim.result.due;
  if (!claimed.length) return { checked: 0, notified: 0 };

  const tg = require('./telegram');
  const botCfg = await getConfig(tg.TELEGRAM_KEY);
  const token = botCfg && botCfg.token;

  let checked = 0;
  let notified = 0;
  for (const t of claimed) {
    if (deadline && Date.now() > deadline - 3000) break;
    checked += 1;
    // eslint-disable-next-line no-await-in-loop
    const didNotify = await checkOne(t, token).catch(() => false);
    if (didNotify) notified += 1;
  }
  return { checked, notified };
}

async function checkOne(t, token) {
  let snap;
  try {
    snap = await getProductPrice(t.canonicalUrl || t.productUrl, t.marketplace);
  } catch {
    return false; // transient fetch failure — retry next sweep
  }
  const ev = evaluate(t, snap.price);
  let sent = false;
  if (ev.notify && token) {
    try {
      await notify(token, t, ev.price, snap);
      sent = true;
    } catch {
      sent = false;
    }
  }
  const patch = { ...ev.basePatch, lastCheckedAt: new Date().toISOString() };
  if (sent) Object.assign(patch, ev.onNotifyPatch);
  await updateTracker(t.id, t.userId, patch);
  return sent;
}

async function notify(token, t, newPrice, snap) {
  const tg = require('./telegram');
  const cur = t.currency || snap.currency || '';
  const title = t.title || snap.title || 'your tracked product';
  const link = t.affiliateUrl || t.canonicalUrl || t.productUrl; // affiliate link in the alert
  const was = t.mode === 'THRESHOLD' ? null : t.lastNotifiedPrice;
  const dropTxt =
    was != null && was > newPrice
      ? `\nDown from ${cur}${round2(was)} (${Math.round(((was - newPrice) / was) * 100)}% off)`
      : '';
  const head = t.mode === 'THRESHOLD' ? `🎯 Target hit! (≤ ${cur}${round2(t.threshold)})` : '📉 Price drop!';
  const text = `${head}\n\n${title}\n\nNow: ${cur}${newPrice}${dropTxt}\n\n${link}`;
  await tg.sendMessage(token, t.chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: '📋 My trackers', callback_data: 'tracker:list' }]],
    },
  });
  await logAudit('price', `Price alert sent for ${title} (${cur}${newPrice}).`, {
    trackerId: t.id,
    mode: t.mode,
    now: newPrice,
  });
}

module.exports = {
  // decisions (pure) — tests
  shouldNotifyDecrease,
  evaluate,
  // repository
  addTracker,
  listTrackers,
  getTracker,
  updateTracker,
  stopTracker,
  resumeTracker,
  deleteTracker,
  setMode,
  // cron + admin
  checkAll,
  getPtConfig,
  setPtConfig,
  counts,
  // constants
  MAX_TRACKERS_PER_USER,
};
