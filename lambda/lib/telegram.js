'use strict';

// Telegram bot integration. The bot token is dynamic admin config (stored in
// DynamoDB under the "telegram" key), never returned in responses or logged.
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');
const { generateLink } = require('./affiliate');
const { logAudit } = require('./audit');

const TELEGRAM_KEY = 'telegram';
const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 10000;

// Update types the webhook must receive. `callback_query` is required for the
// price-tracker inline buttons; without it Telegram silently drops the presses.
const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'callback_query'];

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
const sendMessage = (token, chatId, text, extra) =>
  tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: false,
    ...(extra || {}),
  });

// Publish the bot's command menu (the "/" autocomplete list). Best-effort — a
// failure here must never block webhook setup.
async function registerCommands(token) {
  try {
    await tgCall(token, 'setMyCommands', {
      commands: [
        { command: 'pricetracker', description: 'Track a product price / manage trackers' },
        { command: 'my_trackers', description: 'View, edit, stop or delete your trackers' },
        { command: 'help', description: 'How to use this bot' },
      ],
    });
  } catch {
    /* best-effort */
  }
}

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
  // Accept both the bare path (default merchant) and the per-tenant suffix.
  if (!/^https:\/\/.+\/telegram\/webhook(?:\/[^/]+)?$/.test(webhookUrl)) {
    throw new ApiError(400, 'Invalid webhook URL.');
  }
  const me = await getMe(token); // throws if the token is wrong
  const secret = crypto.randomBytes(24).toString('hex');
  await tgCall(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    // Start clean — don't replay messages queued while the bot was disconnected.
    drop_pending_updates: true,
  });
  await registerCommands(token);

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
      // Drop the queue so a later re-add doesn't replay old messages.
      await tgCall(cfg.token, 'deleteWebhook', { drop_pending_updates: true });
    } catch {
      /* ignore */
    }
  }
  await setConfig(TELEGRAM_KEY, {});
  return {};
}

// Silence the bot WITHOUT forgetting it: delete the Telegram webhook but keep
// the stored token/config, so it can be restored on reactivation. Used when a
// merchant is deactivated by the super-admin.
async function silenceBot() {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (cfg && cfg.token) {
    try {
      await tgCall(cfg.token, 'deleteWebhook', { drop_pending_updates: true });
    } catch {
      /* best-effort */
    }
  }
}

// Re-register the stored bot's webhook (used on reactivation). Best-effort; a
// missing token is a no-op. Reuses the stored secret when present.
async function restoreBot(webhookUrl) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) return;
  const secret = cfg.webhookSecret || crypto.randomBytes(24).toString('hex');
  try {
    await tgCall(cfg.token, 'setWebhook', {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: true,
    });
    await registerCommands(cfg.token);
    cfg.webhookSecret = secret;
    cfg.webhookUrl = webhookUrl;
    await setConfig(TELEGRAM_KEY, cfg);
  } catch {
    /* best-effort */
  }
}

// Re-register the CURRENT bot's webhook without losing any stored config. Used by
// the admin "Register bot" button to activate newly-added update permissions
// (callback_query) on an already-connected bot. Channels and all other config are
// preserved (they live in DynamoDB and are never touched here).
async function reregisterBot(webhookUrl) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) throw new ApiError(400, 'Connect a bot first.');
  const secret = cfg.webhookSecret || crypto.randomBytes(24).toString('hex');
  await tgCall(cfg.token, 'deleteWebhook', { drop_pending_updates: false });
  await tgCall(cfg.token, 'setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });
  await registerCommands(cfg.token);
  cfg.webhookSecret = secret;
  cfg.webhookUrl = webhookUrl;
  cfg.reregisteredAt = new Date().toISOString();
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
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
  const prev = (cfg.channels || []).find((c) => String(c.id) === channelId);
  cfg.channels = (cfg.channels || []).filter((c) => String(c.id) !== channelId);
  cfg.channels.push({
    id: channelId,
    title: title || channelId,
    active: prev ? prev.active !== false : true,
    autoPublish: prev ? !!prev.autoPublish : false,
  });
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

// Master on/off for a channel. Inactive channels receive nothing from us.
async function setChannelActive(id, active) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) throw new ApiError(400, 'Connect a bot first.');
  cfg.channels = (cfg.channels || []).map((c) =>
    String(c.id) === String(id) ? { ...c, active: !!active } : c
  );
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

// Clear the last-detected channel so the next "add channel" waits for a fresh
// post instead of showing a previously-added one.
async function clearLastChannel() {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg) return {};
  delete cfg.lastChannel;
  await setConfig(TELEGRAM_KEY, cfg);
  return cfg;
}

// Toggle whether user/website-generated links auto-post to this channel.
async function setChannelAutoPublish(id, autoPublish) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token) throw new ApiError(400, 'Connect a bot first.');
  cfg.channels = (cfg.channels || []).map((c) =>
    String(c.id) === String(id) ? { ...c, autoPublish: !!autoPublish } : c
  );
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

function pinMessage(token, chatId, messageId) {
  return tgCall(token, 'pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

// Publish text to configured channels using the stored bot. Best-effort.
// Inactive channels are always skipped; `autoOnly` further restricts to
// channels with auto-publish on. `pin` pins the message in each channel.
async function publishToChannels(text, { autoOnly = false, pin = false } = {}) {
  const cfg = await getConfig(TELEGRAM_KEY);
  if (!cfg || !cfg.token || !(cfg.channels || []).length) return 0;
  let targets = cfg.channels.filter((c) => c.active !== false); // active only
  if (autoOnly) targets = targets.filter((c) => c.autoPublish);
  let sent = 0;
  for (const ch of targets) {
    try {
      const res = await sendMessage(cfg.token, ch.id, text);
      if (pin && res && res.message_id) {
        try {
          await pinMessage(cfg.token, ch.id, res.message_id);
        } catch {
          /* pin may fail if bot lacks pin rights */
        }
      }
      sent++;
    } catch {
      /* skip a failing channel */
    }
  }
  return sent;
}

// Auto-publish (only active channels with the toggle on) — for user/website links.
const publishAuto = (text) => publishToChannels(text, { autoOnly: true });

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
  'Send me an Amazon or Flipkart product link and I will reply with an affiliate link.\n\n' +
  '• Amazon — amazon.in, amazon.com, a.co, amzn.to …\n' +
  '• Flipkart — flipkart.com, dl.flipkart.com, fkrt.it …\n\n' +
  'Commands:\n' +
  '/pricetracker — track a product price (alerts you when it drops)\n' +
  '/my_trackers — view, edit, stop or delete your trackers\n' +
  '/start — welcome\n/help — this message';

// Process one Telegram update. Never throws (webhook must always 200) and never
// leaks the token.
async function processUpdate(update) {
  try {
    // Channel posts: capture the channel id/title for the "add channel" flow.
    if (update && update.channel_post && update.channel_post.chat) {
      const chat = update.channel_post.chat;
      const cfg = await getConfig(TELEGRAM_KEY);
      if (cfg && cfg.token) {
        cfg.lastChannel = {
          id: chat.id,
          title: chat.title || String(chat.id),
          detectedAt: new Date().toISOString(),
        };
        await setConfig(TELEGRAM_KEY, cfg);
      }
      return;
    }

    // Inline button presses (price-tracker UI).
    if (update && update.callback_query) {
      const cfg = await getConfig(TELEGRAM_KEY);
      if (cfg && cfg.token) {
        // eslint-disable-next-line global-require
        await require('./pricebot').handleCallback(cfg.token, update.callback_query);
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

    // ── Price tracker: commands + mid-flow conversation state ──
    // Lazy-require to avoid a module cycle (pricebot requires telegram).
    // eslint-disable-next-line global-require
    const pricebot = require('./pricebot');
    if (text === '/cancel' || text.startsWith('/cancel')) {
      await pricebot.handleCancel(token, chatId);
      return;
    }
    if (text.startsWith('/pricetracker') || text.startsWith('/price_tracker')) {
      await pricebot.startTrackerFlow(token, chatId, msg.from, text.replace(/^\/price_?tracker(?:@\S+)?\s*/, ''));
      return;
    }
    if (text.startsWith('/my_trackers')) {
      await pricebot.showMyTrackers(token, chatId, msg.from);
      return;
    }
    // If the user is mid-flow (awaiting a product URL), route this message there
    // instead of treating it as a one-off affiliate-link conversion.
    if (await pricebot.maybeHandleState(token, chatId, msg.from, text)) return;

    const url = extractUrl(text);
    if (!url) {
      // Doubles as the setup round-trip confirmation.
      await sendMessage(token, chatId, `👋 Hi from server! I received: ${text || '(no text)'}`);
      return;
    }

    try {
      const result = await generateLink(url);
      const reply = formatAffiliateMessage(result);
      await sendMessage(token, chatId, reply);
      await logAudit('bot', `@${fromName} generated ${result.platform || 'affiliate'} link (${result.asin || 'page'}).`);
      // Also publish to channels that opted in to user-generated links.
      await publishAuto(reply);
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
  tgCall,
  sendMessage,
  connectBot,
  confirmBot,
  removeBot,
  silenceBot,
  restoreBot,
  reregisterBot,
  sendTest,
  addChannel,
  removeChannel,
  clearLastChannel,
  setChannelAutoPublish,
  setChannelActive,
  publishToChannels,
  publishAuto,
  processUpdate,
  maskTelegram,
  formatAffiliateMessage,
};
