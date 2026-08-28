'use strict';

// Public Telegram channel reader (no login) via the t.me/s/<username> web
// preview. Extracts recent messages + their links and generates fresh affiliate
// links for any Amazon URLs found.
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');
const { generateAmazonLink } = require('./affiliate');

const LISTENERS_KEY = 'listeners';
const TIMEOUT_MS = 10000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const AMAZONISH = /(?:amazon\.[a-z.]+|amzn\.[a-z]+|link\.amazon|amznn\.cc|a\.co)\//i;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Accepts @name, t.me/name, t.me/s/name, or a bare username.
function parseUsername(input) {
  if (!input) throw new ApiError(400, 'Channel is required.');
  let s = String(input).trim().replace(/^@/, '');
  const m = s.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_]{3,}$/.test(s)) return s;
  throw new ApiError(400, 'Enter a public channel @username or t.me link.');
}

// Fetch + parse one preview page (messages in document order: oldest → newest).
// `before` = a numeric message id to page backwards from (older messages).
async function fetchMessagesPage(username, before) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let html;
  try {
    const url = `https://t.me/s/${username}` + (before ? `?before=${before}` : '');
    const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA }, signal: controller.signal });
    if (res.status === 404) throw new ApiError(404, 'Channel not found or not public.');
    if (!res.ok) throw new ApiError(502, `Could not read the channel (${res.status}).`);
    html = await res.text();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'Could not reach Telegram.');
  } finally {
    clearTimeout(timer);
  }

  const segments = html.split('data-post="').slice(1);
  const messages = [];
  for (const seg of segments) {
    const id = seg.slice(0, seg.indexOf('"'));
    const numId = parseInt((id.split('/')[1] || '0'), 10) || 0;
    const tm = seg.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!tm) continue;
    const raw = tm[1];
    const links = [...raw.matchAll(/href="([^"]+)"/g)].map((mm) => decodeEntities(mm[1]));
    const text = decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    messages.push({ id, numId, text, links });
  }
  return messages;
}

function allAmazonLinks(links) {
  const out = [];
  const seen = new Set();
  for (const l of links || []) {
    if (AMAZONISH.test(l) && !seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

// Plain read for the "test read" preview — last N messages of any kind.
async function fetchMessages(username, limit = 5) {
  const messages = await fetchMessagesPage(username);
  return messages.slice(-limit).reverse();
}

// Collect the newest `count` messages that contain an Amazon link, paging
// backwards through the preview until we have enough (or run out / hit the cap).
async function fetchAmazonMessages(username, count) {
  const MAX_PAGES = 10;
  const seen = new Set();
  const collected = [];
  let before = null;
  for (let page = 0; page < MAX_PAGES && collected.length < count; page++) {
    const msgs = await fetchMessagesPage(username, before);
    if (!msgs.length) break;
    for (const m of msgs) {
      if (!seen.has(m.id) && allAmazonLinks(m.links).length) {
        seen.add(m.id);
        collected.push(m);
      }
    }
    const oldest = msgs[0].numId; // document order: first = oldest on the page
    if (!oldest || oldest === before) break; // no further pages
    before = oldest;
  }
  collected.sort((a, b) => b.numId - a.numId); // newest first
  return collected.slice(0, count);
}

// Run async fn over items with bounded concurrency (avoids hammering Amazon).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Fetch the newest `count` Amazon-link messages and build a fresh affiliate link
// for EVERY Amazon link in each message (a message may contain several).
async function fetchEnriched(username, count) {
  const messages = await fetchAmazonMessages(username, count);

  // Flatten every (message, link) pair so concurrency is bounded across all.
  const tasks = [];
  for (const m of messages) {
    for (const url of allAmazonLinks(m.links)) tasks.push({ id: m.id, url });
  }
  const done = await mapLimit(tasks, 5, async (t) => {
    let affiliate;
    try {
      const r = await generateAmazonLink(t.url, { withMeta: false });
      affiliate = { affiliateUrl: r.affiliateUrl, method: r.method, fallback: r.fallback, asin: r.asin };
    } catch (err) {
      affiliate = { error: err.message };
    }
    return { id: t.id, sourceUrl: t.url, affiliate };
  });

  return messages.map((m) => ({
    id: m.id,
    text: m.text,
    items: done.filter((d) => d.id === m.id),
  }));
}

async function getListeners() {
  const cfg = await getConfig(LISTENERS_KEY);
  return (cfg && cfg.items) || [];
}

async function saveListeners(items) {
  await setConfig(LISTENERS_KEY, { items });
  return items;
}

// True when t.me/s/<username> is a public CHANNEL with a readable message
// preview (vs a group / private / preview-disabled handle, which has none).
async function probePublic(username) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://t.me/s/${username}`, {
      headers: { 'user-agent': BROWSER_UA },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const html = await res.text();
    return /tgme_widget_message\b|tgme_channel_info\b/.test(html);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function addListener(username, title, source) {
  const items = await getListeners();
  const prev = items.find((c) => c.username.toLowerCase() === username.toLowerCase());
  const next = items.filter((c) => c.username.toLowerCase() !== username.toLowerCase());
  next.push({
    username,
    title: title || username,
    source: source === 'mtproto' ? 'mtproto' : (prev && prev.source) || 'public',
    auto: prev ? !!prev.auto : false,
    intervalMinutes: prev ? prev.intervalMinutes || 60 : 60,
    count: prev ? prev.count || 5 : 5,
    lastRunAt: prev ? prev.lastRunAt || null : null,
    lastProcessed: prev ? prev.lastProcessed || 0 : 0,
  });
  await setConfig(LISTENERS_KEY, { items: next });
  return next;
}

// Per-listener automation settings (enable, interval, message count).
async function setListenerAutomation(username, { auto, intervalMinutes, count }) {
  const items = await getListeners();
  const next = items.map((c) => {
    if (c.username.toLowerCase() !== String(username).toLowerCase()) return c;
    const updated = { ...c };
    if (typeof auto === 'boolean') updated.auto = auto;
    if (intervalMinutes !== undefined) {
      const n = parseInt(intervalMinutes, 10);
      updated.intervalMinutes = Math.min(Math.max(Number.isFinite(n) ? n : 60, 0), 1440);
    }
    if (count !== undefined) {
      const n = parseInt(count, 10);
      updated.count = Math.min(Math.max(Number.isFinite(n) ? n : 5, 1), 20);
    }
    return updated;
  });
  await setConfig(LISTENERS_KEY, { items: next });
  return next;
}

async function removeListener(username) {
  const items = await getListeners();
  const next = items.filter((c) => c.username.toLowerCase() !== String(username).toLowerCase());
  await setConfig(LISTENERS_KEY, { items: next });
  return next;
}

module.exports = {
  LISTENERS_KEY,
  parseUsername,
  fetchMessages,
  fetchMessagesPage,
  fetchAmazonMessages,
  fetchEnriched,
  allAmazonLinks,
  getListeners,
  saveListeners,
  probePublic,
  addListener,
  removeListener,
  setListenerAutomation,
};
