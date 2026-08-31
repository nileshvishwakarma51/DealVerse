'use strict';

// Per-listener automation. On each EventBridge tick (or manual "Run now"), each
// listener with automation enabled runs on ITS OWN interval and message count.
// A single DynamoDB lock prevents overlapping sweeps; per-listener lastProcessed
// de-dups so nothing is posted twice.
const { getConfig, setConfig } = require('./store');
const { getListeners, saveListeners, fetchAmazonMessages } = require('./listener');
const { generateLink, getActivePlatforms } = require('./affiliate');
const { dealLinks } = require('./links');
const { publishToChannels } = require('./telegram');
const { logAudit } = require('./audit');
// Safe to require (dependency-free at load; GramJS is lazy-loaded inside).
const mtproto = require('./mtproto');

const AUTOMATION_KEY = 'automation'; // holds only the run lock + last summary
const MAX_RUN_MS = 4 * 60 * 1000;
// Stop converting once we near the Lambda deadline. Flipkart conversions each
// wait on an external bot reply, so a busy tick could otherwise time out
// mid-run and leave progress unsaved (→ re-posts). We save partial progress
// (per-message lastProcessed) and pick up the rest on the next tick.
const RUN_BUDGET_MS = 50 * 1000;

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

async function processListener(l, deadline) {
  const active = await getActivePlatforms();
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

  // A human-readable trace of the full flow, saved as the audit row's detail so
  // the admin can expand it and see exactly why each link did or didn't post.
  const trace = [];
  trace.push(`Source: @${l.username} (${l.source === 'mtproto' ? 'logged-in account' : 'public channel'}), read ${msgs.length} latest, ${fresh.length} new since last run.`);
  trace.push(`Platforms active: Amazon=${active.amazon ? 'on' : 'OFF'}, Flipkart=${active.flipkart ? 'on' : 'OFF'}.`);
  if (!fresh.length) trace.push('No new messages — nothing to post (all were processed on a previous run).');

  for (const m of fresh) {
    // Budget guard: leave the rest for the next tick (maxId already reflects the
    // last fully-processed message, so nothing is skipped or double-posted).
    if (deadline && Date.now() > deadline) {
      trace.push('⏱ Stopped early (time budget) — remaining messages run next tick.');
      break;
    }
    const snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const all = dealLinks(m.links);
    trace.push('');
    trace.push(`Message ${m.numId}: "${snippet || '(no text)'}"`);
    if (!all.length) trace.push('  • No Amazon/Flipkart links found in this message.');

    const items = [];
    for (const { url, platform } of all) {
      if (!active[platform]) {
        trace.push(`  • ${platform}: ${url}\n      → skipped — ${platform} is turned OFF in Affiliate settings.`);
        continue;
      }
      try {
        const r = await generateLink(url, { withMeta: false });
        items.push({ source: url, affiliateUrl: r.affiliateUrl });
        trace.push(`  • ${platform}: ${url}\n      → converted via ${r.method}${r.fallback ? ' (fallback)' : ''} → ${r.affiliateUrl}`);
      } catch (err) {
        trace.push(`  • ${platform}: ${url}\n      → CONVERSION FAILED: ${err.message}`);
      }
    }

    if (items.length) {
      const sent = await publishToChannels(composeMessage(m.text, items), { autoOnly: true });
      if (sent > 0) {
        posted++;
        trace.push(`  → Published to ${sent} channel(s).`);
      } else {
        trace.push('  → NOT published: no channel has "auto-post user/website links" enabled (check Telegram bot → channels).');
      }
    } else if (all.length) {
      trace.push('  → Not published: none of this message\'s links could be converted (see reasons above).');
    }
    if (m.numId > maxId) maxId = m.numId;
  }

  l.lastProcessed = maxId;
  l.lastRunAt = new Date().toISOString();
  return { posted, trace: trace.join('\n') };
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
async function runAutomation(trigger, deadlineArg) {
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
  // A caller (the multi-tenant cron) may pass a SHARED deadline so all tenants
  // together stay under the Lambda timeout; otherwise use our own budget.
  const deadline = deadlineArg || Date.now() + RUN_BUDGET_MS;
  try {
    for (const l of due) {
      if (Date.now() > deadline) break; // out of budget — remaining listeners run next tick
      ran++;
      try {
        const { posted: p, trace } = await processListener(l, deadline); // mutates l (a ref into items)
        posted += p;
        await logAudit('cron', `Read @${l.username} (${l.count || 5} latest) → posted ${p} new deal(s).`, trace);
      } catch (err) {
        // One listener failing (e.g. MTProto flood/offline) must not abort the run.
        await logAudit('cron', `@${l.username} skipped: ${err.message}`, err && err.stack ? String(err.stack) : null);
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
