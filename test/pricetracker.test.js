'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// The stub MUST be installed before requiring anything that touches DynamoDB.
process.env.TABLE_NAME = 'test-table';
require('./support/ddb-stub');
const store = require('../lambda/lib/store');
const tracker = require('../lambda/lib/pricetracker');

const snap = (price) => ({
  marketplace: 'AMAZON',
  price,
  currency: '₹',
  productUrl: 'https://amazon.in/dp/XXXXXXXXXX',
  canonicalUrl: 'https://amazon.in/dp/XXXXXXXXXX',
  title: 'Test Widget',
  asin: 'XXXXXXXXXX',
});

// ── Pure decisions ───────────────────────────────────────────────────────────
test('shouldNotifyDecrease fires only on a strict new low', () => {
  assert.equal(tracker.shouldNotifyDecrease(1599, 1600), true);
  assert.equal(tracker.shouldNotifyDecrease(1600, 1600), false);
  assert.equal(tracker.shouldNotifyDecrease(1601, 1600), false);
  assert.equal(tracker.shouldNotifyDecrease(null, 1600), false);
});

test('evaluate DECREASE: new low notifies and advances baseline only on notify', () => {
  const t = { mode: 'DECREASE', lastNotifiedPrice: 1000, checkCount: 3 };
  const drop = tracker.evaluate(t, 900);
  assert.equal(drop.notify, true);
  assert.equal(drop.basePatch.lastPrice, 900);
  assert.equal(drop.basePatch.checkCount, 4);
  assert.equal(drop.onNotifyPatch.lastNotifiedPrice, 900); // applied only after a successful send

  const noDrop = tracker.evaluate(t, 1000);
  assert.equal(noDrop.notify, false);
  assert.deepEqual(noDrop.onNotifyPatch, {});
});

test('evaluate THRESHOLD: fires once at/below target, re-arms when it rises above', () => {
  const base = { mode: 'THRESHOLD', threshold: 800, checkCount: 0 };

  const above = tracker.evaluate({ ...base, thresholdNotified: false }, 900);
  assert.equal(above.notify, false);

  const hit = tracker.evaluate({ ...base, thresholdNotified: false }, 800); // <= target
  assert.equal(hit.notify, true);
  assert.equal(hit.onNotifyPatch.thresholdNotified, true);

  const stillBelow = tracker.evaluate({ ...base, thresholdNotified: true }, 750);
  assert.equal(stillBelow.notify, false); // no repeat ping while it stays below

  const roseBack = tracker.evaluate({ ...base, thresholdNotified: true }, 850);
  assert.equal(roseBack.notify, false);
  assert.equal(roseBack.basePatch.thresholdNotified, false); // re-armed for the next crossing
});

test('evaluate ignores unreadable / non-positive prices', () => {
  const t = { mode: 'DECREASE', lastNotifiedPrice: 1000, checkCount: 1 };
  const r = tracker.evaluate(t, null);
  assert.equal(r.notify, false);
  assert.equal(r.price, null);
  assert.equal(r.basePatch.checkCount, 2);
  assert.equal(r.basePatch.lastPrice, undefined); // don't record a bogus price
});

// ── Repository ───────────────────────────────────────────────────────────────
test('add / list / update / stop / resume / delete are ownership-scoped', async () => {
  store.setTenant('default');
  const t = await tracker.addTracker({ userId: 111, chatId: 111, snapshot: snap(1000), affiliateUrl: 'https://aff/x', mode: 'DECREASE' });
  assert.ok(t.id && t.id.length === 8, 'short 8-hex id');
  assert.equal(t.status, 'active');
  assert.equal(t.mode, 'DECREASE');
  assert.equal(t.lastNotifiedPrice, 1000);
  assert.equal(t.affiliateUrl, 'https://aff/x');

  assert.equal((await tracker.listTrackers(111)).length, 1);
  assert.equal((await tracker.listTrackers(222)).length, 0);

  // Non-owner cannot mutate.
  assert.equal(await tracker.stopTracker(t.id, 222), null);
  assert.equal(await tracker.updateTracker(t.id, 222, { lastPrice: 5 }), null);
  assert.equal(await tracker.deleteTracker(t.id, 222), false);

  // Owner can stop → paused, resume → active.
  const paused = await tracker.stopTracker(t.id, 111);
  assert.equal(paused.status, 'paused');
  const resumed = await tracker.resumeTracker(t.id, 111);
  assert.equal(resumed.status, 'active');

  // Delete removes it entirely.
  assert.equal(await tracker.deleteTracker(t.id, 111), true);
  assert.equal((await tracker.listTrackers(111)).length, 0);
});

test('addTracker THRESHOLD stores the target; setMode switches modes', async () => {
  store.setTenant('thr');
  const t = await tracker.addTracker({ userId: 5, chatId: 5, snapshot: snap(1000), mode: 'THRESHOLD', threshold: 800 });
  assert.equal(t.mode, 'THRESHOLD');
  assert.equal(t.threshold, 800);

  const dec = await tracker.setMode(t.id, 5, 'DECREASE');
  assert.equal(dec.mode, 'DECREASE');
  assert.equal(dec.lastNotifiedPrice, 1000); // re-baselined to current

  const back = await tracker.setMode(t.id, 5, 'THRESHOLD', 700);
  assert.equal(back.threshold, 700);
  assert.equal(back.thresholdNotified, false);
  store.setTenant('default');
});

test('trackers are isolated per tenant', async () => {
  store.setTenant('acme');
  await tracker.addTracker({ userId: 1, chatId: 1, snapshot: snap(500), mode: 'DECREASE' });
  assert.equal((await tracker.listTrackers(1)).length, 1);
  store.setTenant('other');
  assert.equal((await tracker.listTrackers(1)).length, 0);
  store.setTenant('default');
});

// ── Admin config + cron gating ───────────────────────────────────────────────
test('getPtConfig defaults + setPtConfig clamps and preserves lastRunAt', async () => {
  store.setTenant('cfgtenant');
  const def = await tracker.getPtConfig();
  assert.equal(def.enabled, true);
  assert.equal(def.intervalHours, 6);

  await store.setConfig('pricetracker_config', { enabled: true, intervalHours: 6, lastRunAt: '2020-01-01T00:00:00.000Z' });
  const saved = await tracker.setPtConfig({ enabled: false, intervalHours: 999 });
  assert.equal(saved.enabled, false);
  assert.equal(saved.intervalHours, 168); // clamped to max
  assert.equal(saved.lastRunAt, '2020-01-01T00:00:00.000Z'); // preserved
  store.setTenant('default');
});

test('checkAll is skipped when disabled or inside the interval', async () => {
  store.setTenant('gate');
  await store.setConfig('pricetracker_config', { enabled: false, intervalHours: 6, lastRunAt: null });
  assert.deepEqual(await tracker.checkAll(Date.now() + 5000), { skipped: 'disabled' });

  const recent = new Date().toISOString();
  await store.setConfig('pricetracker_config', { enabled: true, intervalHours: 6, lastRunAt: recent });
  assert.deepEqual(await tracker.checkAll(Date.now() + 5000), { skipped: 'interval' });
  store.setTenant('default');
});

test('counts reflect active vs paused', async () => {
  store.setTenant('counts');
  const a = await tracker.addTracker({ userId: 9, chatId: 9, snapshot: snap(100), mode: 'DECREASE' });
  await tracker.addTracker({ userId: 9, chatId: 9, snapshot: snap(200), mode: 'DECREASE' });
  await tracker.stopTracker(a.id, 9);
  const c = await tracker.counts();
  assert.equal(c.total, 2);
  assert.equal(c.active, 1);
  assert.equal(c.paused, 1);
  store.setTenant('default');
});
