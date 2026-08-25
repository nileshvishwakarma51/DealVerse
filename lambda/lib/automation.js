'use strict';

// Listener automation: on each EventBridge tick (or a manual "Run now"), sweep
// the enabled listener channels, generate fresh affiliate links for NEW messages
// only, and publish them to the auto-post channels. Runtime-configurable
// interval + a DynamoDB lock so runs never overlap.
const { getConfig, setConfig } = require('./store');
const { getListeners, fetchAmazonMessages, allAmazonLinks } = require('./listener');
const { generateAmazonLink } = require('./affiliate');
const { publishToChannels } = require('./telegram');

const AUTOMATION_KEY = 'automation';
const DEFAULT = { enabled: false, intervalMinutes: 60 };
const MAX_RUN_MS = 4 * 60 * 1000; // stale-lock threshold
const PER_LISTENER_LIMIT = 8; // newest Amazon-link messages scanned per run

async function getAutomation() {
  return (await getConfig(AUTOMATION_KEY)) || { ...DEFAULT };
}

function maskAutomation(a) {
  return {
    enabled: !!a.enabled,
    intervalMinutes: a.intervalMinutes || DEFAULT.intervalMinutes,
    lastRunAt: a.lastRunAt || null,
    lastResult: a.lastResult || null,
    running: !!a.running,
  };
}

async function saveAutomation({ enabled, intervalMinutes }) {
  const a = await getAutomation();
  if (typeof enabled === 'boolean') a.enabled = enabled;
  if (intervalMinutes !== undefined) {
    const n = parseInt(intervalMinutes, 10);
    a.intervalMinutes = Math.min(Math.max(Number.isFinite(n) ? n : 60, 5), 1440);
  }
  await setConfig(AUTOMATION_KEY, a);
  return a;
}

function composeMessage(text, items) {
  let out = text || '';
  const appended = [];
  for (const it of items) {
    if (it.text && out.includes(it.source)) out = out.split(it.source).join(it.affiliateUrl);
    else appended.push(it.affiliateUrl);
  }
  const extra = appended.length ? '\n' + appended.join('\n') : '';
  return (out + extra).trim();
}

// trigger: 'schedule' (respects enable + interval) | 'manual' (ignores both).
async function runAutomation(trigger) {
  const a = await getAutomation();

  if (trigger === 'schedule') {
    if (!a.enabled) return { skipped: 'disabled' };
    const interval = (a.intervalMinutes || DEFAULT.intervalMinutes) * 60 * 1000;
    if (a.lastRunAt && Date.now() - Date.parse(a.lastRunAt) < interval) {
      return { skipped: 'interval' };
    }
  }

  // Overlap guard.
  if (a.running && a.runningSince && Date.now() - Date.parse(a.runningSince) < MAX_RUN_MS) {
    return { skipped: 'locked' };
  }
  a.running = true;
  a.runningSince = new Date().toISOString();
  await setConfig(AUTOMATION_KEY, a);

  let posted = 0;
  let scanned = 0;
  try {
    const listeners = (await getListeners()).filter((l) => l.auto);
    const lastProcessed = a.lastProcessed || {};

    for (const l of listeners) {
      const msgs = await fetchAmazonMessages(l.username, PER_LISTENER_LIMIT);
      const prev = lastProcessed[l.username] || 0;
      // Only messages newer than what we've already posted, oldest first.
      const fresh = msgs.filter((m) => m.numId > prev).sort((x, y) => x.numId - y.numId);
      let maxId = prev;

      for (const m of fresh) {
        scanned++;
        const items = [];
        for (const url of allAmazonLinks(m.links)) {
          try {
            const r = await generateAmazonLink(url, { withMeta: false });
            items.push({ source: url, affiliateUrl: r.affiliateUrl, text: true });
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
      lastProcessed[l.username] = maxId;
    }

    a.lastProcessed = lastProcessed;
    a.lastRunAt = new Date().toISOString();
    a.lastResult = { trigger, posted, scanned, listeners: listeners.length, at: a.lastRunAt };
    return a.lastResult;
  } finally {
    a.running = false;
    a.runningSince = null;
    await setConfig(AUTOMATION_KEY, a);
  }
}

module.exports = { AUTOMATION_KEY, getAutomation, saveAutomation, maskAutomation, runAutomation };
