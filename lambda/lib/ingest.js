'use strict';

// Real-time ingest: a local MTProto listener (see /local-mtproto) pushes each new
// source-channel message here, and this runs the SAME convert + publish pipeline
// the 5-minute cron uses — just instantly instead of on a poll. Tenant-scoped
// (the caller authenticates as a merchant, so store calls are already scoped).
const { getConfig, setConfig } = require('./store');
const { generateLink, getActivePlatforms } = require('./affiliate');
const { activeLinks } = require('./links');
const { publishToChannels } = require('./telegram');
const { getListeners, saveListeners } = require('./listener');
const { logAudit } = require('./audit');

const SEEN_KEY = 'ingest_seen';
const SEEN_CAP = 1000;

// Replace each source link in the text with its affiliate link (same shape as
// automation.composeMessage); append any that weren't inline.
function compose(text, items) {
  let out = text || '';
  const appended = [];
  for (const it of items) {
    if (out.includes(it.source)) out = out.split(it.source).join(it.affiliateUrl);
    else appended.push(it.affiliateUrl);
  }
  return (out + (appended.length ? '\n' + appended.join('\n') : '')).trim();
}

async function ingestMessage(payload) {
  const { sourceChatId, sourceUsername, sourceTitle, msgId, text } = payload || {};
  const links = Array.isArray(payload && payload.links) ? payload.links : [];
  const dedupId = `${sourceChatId || sourceUsername || '?'}:${msgId}`;

  // De-dup so a listener reconnect / overlap with the cron never double-posts.
  const seen = (await getConfig(SEEN_KEY)) || { ids: [] };
  if (seen.ids.includes(dedupId)) return { skipped: 'duplicate', dedupId };

  const active = await getActivePlatforms();
  const textUrls = String(text || '').match(/https?:\/\/[^\s]+/gi) || [];
  const urls = activeLinks([...links, ...textUrls], active);

  const trace = [
    `source: ${sourceTitle || ''} (@${sourceUsername || ''}, id ${sourceChatId || ''})`,
    `msg ${msgId}`,
    `platforms active: Amazon=${active.amazon ? 'on' : 'OFF'}, Flipkart=${active.flipkart ? 'on' : 'OFF'}`,
    `deal links (active): ${urls.length}`,
  ];

  const items = [];
  for (const url of urls) {
    try {
      const r = await generateLink(url, { withMeta: false });
      items.push({ source: url, affiliateUrl: r.affiliateUrl });
      trace.push(`  ${url} → ${r.affiliateUrl}`);
    } catch (err) {
      trace.push(`  ${url} → FAILED: ${err.message}`);
    }
  }

  let posted = 0;
  if (items.length) {
    posted = await publishToChannels(compose(text, items), { autoOnly: true });
    trace.push(posted > 0 ? `published to ${posted} channel(s)` : 'not published (no auto-publish channel enabled)');
  } else {
    trace.push('nothing to publish (no convertible active links)');
  }

  // Advance the matching listener's lastProcessed so the 5-min cron won't re-post
  // what the real-time push already handled.
  const numId = Number(msgId);
  if (sourceUsername && Number.isFinite(numId)) {
    try {
      const uname = String(sourceUsername).replace(/^@/, '').toLowerCase();
      const listeners = await getListeners();
      let changed = false;
      for (const l of listeners) {
        if (l.username && l.username.toLowerCase() === uname && (l.lastProcessed || 0) < numId) {
          l.lastProcessed = numId;
          changed = true;
        }
      }
      if (changed) await saveListeners(listeners);
    } catch {
      /* best-effort */
    }
  }

  // Record as seen (rolling cap).
  seen.ids.push(dedupId);
  if (seen.ids.length > SEEN_CAP) seen.ids = seen.ids.slice(-SEEN_CAP);
  await setConfig(SEEN_KEY, seen);

  await logAudit(
    'ingest',
    `Real-time: ${sourceTitle || sourceUsername || sourceChatId} msg ${msgId} → ${items.length} link(s), posted ${posted}.`,
    trace.join('\n')
  );

  return { posted, linksFound: urls.length, converted: items.length };
}

module.exports = { ingestMessage, SEEN_KEY };
