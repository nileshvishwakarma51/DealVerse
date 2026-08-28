'use strict';

// Per-listener automation. On each EventBridge tick (or manual "Run now"), each
// listener with automation enabled runs on ITS OWN interval and message count.
// A single DynamoDB lock prevents overlapping sweeps; per-listener lastProcessed
// de-dups so nothing is posted twice.
const { getConfig, setConfig } = require('./store');
const { getListeners, saveListeners, fetchAmazonMessages, allAmazonLinks } = require('./listener');
const { generateAmazonLink } = require('./affiliate');
const { publishToChannels } = require('./telegram');
const { logAudit } = require('./audit');
// Safe to require (dependency-free at load; GramJS is lazy-loaded inside).
const mtproto = require('./mtproto');

const AUTOMATION_KEY = 'automation'; // holds only the run lock + last summary
const MAX_RUN_MS = 4 * 60 * 1000;

async function getAutomation() {
  return (await getConfig(AUTOMATION_KEY)) || {};
}

function maskAutomation(a) {
  return { running: !!a.running, lastResult: a.lastResult || null };
}

function composeMessage(text, items) {
  let out = text || '';
  const appended = [];
  for (const it of items) {
    if (out.includes(it.source)) out = out.split(it.source).join(it.affiliateUrl);
    else appended.push(it.affiliateUrl);
  }
  return (out + (appended.length ? '\n' + appended.join('\n') : '')).trim();
}

async function processListener(l) {
  const count = Math.min(Math.max(l.count || 5, 1), 20);
  // Dispatch by source: public channels via the t.me reader, groups/private via
  // the logged-in MTProto account. Both return {numId, text, links}.
  const msgs =
    l.source === 'mtproto'
      ? await mtproto.fetchRaw(l.username, count)
      : await fetchAmazonMessages(l.username, count);
  const prev = l.lastProcessed || 0;
  const fresh = msgs.filter((m) => m.numId > prev).sort((x, y) => x.numId - y.numId);
  let maxId = prev;
  let posted = 0;

  for (const m of fresh) {
    const items = [];
    for (const url of allAmazonLinks(m.links)) {
      try {
        const r = await generateAmazonLink(url, { withMeta: false });
        items.push({ source: url, affiliateUrl: r.affiliateUrl });
      } catch {
        /* skip a link that can't be affiliated */
      }
    }
    if (items.length) {
      const sent = await publishToChannels(composeMessage(m.text, items), { autoOnly: true });
      if (sent > 0) posted++;
    }
    if (m.numId > maxId) maxId = m.numId;
  }

  l.lastProcessed = maxId;
  l.lastRunAt = new Date().toISOString();
  return posted;
}

function isDue(l, trigger) {
  if (!l.auto) return false;
  if (trigger === 'manual') return true;
  const iv = (l.intervalMinutes || 60) * 60 * 1000;
  if (iv <= 0) return true; // 0 = run every tick
  return !l.lastRunAt || Date.now() - Date.parse(l.lastRunAt) >= iv;
}

// trigger: 'schedule' (each listener respects its own interval) | 'manual'
// (runs every enabled listener now). Cheap on idle: a tick with nothing due does
// a single read and no writes — no lock churn.
async function runAutomation(trigger) {
  const items = await getListeners(); // 1 read
  const due = items.filter((l) => isDue(l, trigger));
  if (!due.length) return { skipped: 'none-due' };

  const a = await getAutomation();
  if (a.running && a.runningSince && Date.now() - Date.parse(a.runningSince) < MAX_RUN_MS) {
    return { skipped: 'locked' };
  }
  a.running = true;
  a.runningSince = new Date().toISOString();
  await setConfig(AUTOMATION_KEY, a);

  let posted = 0;
  let ran = 0;
  try {
    for (const l of due) {
      ran++;
      try {
        const p = await processListener(l); // mutates l (a ref into items)
        posted += p;
        await logAudit('cron', `Read @${l.username} (${l.count || 5} latest) → posted ${p} new deal(s).`);
      } catch (err) {
        // One listener failing (e.g. MTProto flood/offline) must not abort the run.
        await logAudit('cron', `@${l.username} skipped: ${err.message}`);
      }
    }
    await saveListeners(items);
    a.lastResult = { trigger, ran, posted, at: new Date().toISOString() };
    return a.lastResult;
  } finally {
    a.running = false;
    a.runningSince = null;
    await setConfig(AUTOMATION_KEY, a);
  }
}

module.exports = { AUTOMATION_KEY, getAutomation, maskAutomation, runAutomation };
