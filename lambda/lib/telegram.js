'use strict';

// Telegram bot integration. The bot token is dynamic admin config (stored in
// DynamoDB under the "telegram" key), never returned in responses or logged.
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');
const { generateAmazonLink } = require('./affiliate');

const TELEGRAM_KEY = 'telegram';
const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 10000;

// ── Low-level Telegram Bot API call. Never logs the token or the request URL. ─
async function tgCall(token, method, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(502, 'Could not reach Telegram.');
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(502, 'Telegram returned an unexpected response.');
  }
  if (!body.ok) {
    // body.description is Telegram's own text and does not contain the token.
    throw new ApiError(502, `Telegram API error: ${body.description || 'unknown error'}`);
  }
  return body.result;
}

const getMe = (token) => tgCall(token, 'getMe', {});
const sendMessage = (token, chatId, text) =>
  tgCall(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: false });

function isValidTokenFormat(token) {
  return typeof token === 'string' && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

// Non-sensitive view — never includes the token or webhook secret.
function maskTelegram(cfg) {
  if (!cfg || !cfg.token) return { configured: false };
  return {
    configured: true,
    confirmed: !!cfg.confirmed,
    username: cfg.username || null,
    webhookUrl: cfg.webhookUrl || null,
    webhookConfigured: !!cfg.webhookSecret,
    channels: cfg.channels || [],
    lastInbound: cfg.lastInbound || null,
    lastChannel: cfg.lastChannel || null,
    configuredAt: cfg.configuredAt || null,
  };
}

// Validate token (getMe) + point Telegram at our webhook with a spoof-protection
// secret. Saves the bot config; setup is finalized later via confirmBot().
async function connectBot(rawToken, webhookUrl) {
  const token = String(rawToken || '').trim();
  if (!isValidTokenFormat(token)) {
    throw new ApiError(400, 'That does not look like a valid Telegram bot token.');
  }
  if (!/^https:\/\/.+\/telegram\/webhook$/.test(webhookUrl)) {
    throw new ApiError(400, 'Invalid webhook URL.');
  }
  const me = await getMe(token); // throws if the token is wrong
  const secret = crypto.randomBytes(24).toString('hex');
  await tgCall(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'channel_post'],
  });

  const existing = (await getConfig(TELEGRAM_KEY)) || {};
  const cfg = {
    ...existing,
    token,
    username: me.username || null,
    botId: me.id || null,
    webhookUrl,
    webhookSecret: secret,
    confirmed: existing.confirmed || false,
    channels: existing.channels || [],
    lastInbound: null,
    configuredAt: new Date().toISOString(),
  };
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

async function confirmBot() {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) throw new ApiError(400, 'Connect a bot first.');
  cfg.confirmed = true;
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

async function removeBot() {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (cfg && cfg.token) {
    try {
      await tgCall(cfg.token, 'deleteWebhook', { drop_pending_updates: false });
    } catch {
      /* ignore */
    }
  }
  await setConfig(TELEGRAM_KEY, {});
  return {};
}

// Send a test message to a chat/channel id using the stored bot.
async function sendTest(chatId, text) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) throw new ApiError(400, 'Connect a bot first.');
  await sendMessage(cfg.token, chatId, text || '✅ Test message from DealVerse.');
  return true;
}

async function addChannel(id, title) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) throw new ApiError(400, 'Connect a bot first.');
  const channelId = String(id).trim();
  if (!channelId) throw new ApiError(400, 'Channel id is required.');
  cfg.channels = (cfg.channels || []).filter((c) => String(c.id) !== channelId);
  cfg.channels.push({ id: channelId, title: title || channelId });
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

async function removeChannel(id) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg) return {};
  cfg.channels = (cfg.channels || []).filter((c) => String(c.id) !== String(id));
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

// Publish text to every configured channel using the stored bot. Best-effort.
async function publishToChannels(text) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token || !(cfg.channels || []).length) return 0;
  let sent = 0;
  for (const ch of cfg.channels) {
    try {
      await sendMessage(cfg.token, ch.id, text);
      sent++;
    } catch {
      /* skip a failing channel */
    }
  }
  return sent;
}

function extractUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

function formatAffiliateMessage(result) {
  const parts = [];
  if (result.product && result.product.title) parts.push(result.product.title);
  if (result.product && result.product.price) parts.push(`Price: ${result.product.price}`);
  parts.push(result.affiliateUrl);
  if (result.fallback) parts.push('(via affiliate-tag fallback)');
  return parts.join('\n');
}

const HELP_TEXT =
  'Send me an Amazon product link (amazon.in, amazon.com, a.co, amzn.to …) and ' +
  'I will reply with an affiliate link.\n\nCommands:\n/start — welcome\n/help — this message';

// Process one Telegram update. Never throws (webhook must always 200) and never
// leaks the token.
async function processUpdate(update) {
  try {
    // Channel posts: capture the channel id/title for the "add channel" flow.
    if (update && update.channel_post && update.channel_post.chat) {
      const chat = update.channel_post.chat;
      const cfg = await getConfig(TELEGRAM_KEY);
      if (cfg && cfg.token) {
        cfg.lastChannel = { id: chat.id, title: chat.title || String(chat.id) };
        await setConfig(TELEGRAM_KEY, cfg);
      }
      return;
    }

    const msg = update && (update.message || update.edited_message);
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    const cfg = await getConfig(TELEGRAM_KEY);
    if (!cfg || !cfg.token) return; // cannot reply without a token
    const token = cfg.token;

    // Record last inbound message (used by the admin "round-trip" check).
    const fromName =
      (msg.from && (msg.from.username || msg.from.first_name)) || String(chatId);
    cfg.lastInbound = { chatId, name: fromName, text, date: new Date().toISOString() };
    await setConfig(TELEGRAM_KEY, cfg);

    if (text === '/start' || text.startsWith('/start')) {
      await sendMessage(token, chatId, `👋 Hi from server! Welcome to DealVerse.\n\n${HELP_TEXT}`);
      return;
    }
    if (text === '/help' || text.startsWith('/help')) {
      await sendMessage(token, chatId, HELP_TEXT);
      return;
    }

    const url = extractUrl(text);
    if (!url) {
      // Doubles as the setup round-trip confirmation.
      await sendMessage(token, chatId, `👋 Hi from server! I received: ${text || '(no text)'}`);
      return;
    }

    try {
      const result = await generateAmazonLink(url);
      const reply = formatAffiliateMessage(result);
      await sendMessage(token, chatId, reply);
      // Also publish to configured channels so all subscribers see the deal.
      await publishToChannels(reply);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Sorry, I could not process that link.';
      await sendMessage(token, chatId, message);
    }
  } catch {
    // Swallow everything — the webhook must never fail out (and never leak).
  }
}

module.exports = {
  TELEGRAM_KEY,
  connectBot,
  confirmBot,
  removeBot,
  sendTest,
  addChannel,
  removeChannel,
  publishToChannels,
  processUpdate,
  maskTelegram,
  formatAffiliateMessage,
};
