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
const AMAZONISH = /(?:amazon\.[a-z.]+|amzn\.[a-z]+|a\.co)\//i;

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

async function fetchMessages(username, limit = 20) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let html;
  try {
    const res = await fetch(`https://t.me/s/${username}`, {
      headers: { 'user-agent': BROWSER_UA },
      signal: controller.signal,
    });
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
    const tm = seg.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!tm) continue;
    const raw = tm[1];
    const links = [...raw.matchAll(/href="([^"]+)"/g)].map((mm) => decodeEntities(mm[1]));
    const text = decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    messages.push({ id, text, links });
  }
  return messages.slice(-limit).reverse(); // newest first
}

function firstAmazonLink(links) {
  return (links || []).find((l) => AMAZONISH.test(l)) || null;
}

// Fetch messages and, for any Amazon link, build a fresh affiliate link.
async function fetchEnriched(username, limit) {
  const messages = await fetchMessages(username, limit);
  return Promise.all(
    messages.map(async (msg) => {
      const sourceUrl = firstAmazonLink(msg.links);
      let affiliate = null;
      if (sourceUrl) {
        try {
          const r = await generateAmazonLink(sourceUrl, { withMeta: false });
          affiliate = { affiliateUrl: r.affiliateUrl, method: r.method, fallback: r.fallback, asin: r.asin };
        } catch (err) {
          affiliate = { error: err.message };
        }
      }
      return { id: msg.id, text: msg.text, sourceUrl, affiliate };
    })
  );
}

async function getListeners() {
  const cfg = await getConfig(LISTENERS_KEY);
  return (cfg && cfg.items) || [];
}

async function addListener(username, title) {
  const items = await getListeners();
  const next = items.filter((c) => c.username.toLowerCase() !== username.toLowerCase());
  next.push({ username, title: title || username });
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
  fetchEnriched,
  getListeners,
  addListener,
  removeListener,
};
