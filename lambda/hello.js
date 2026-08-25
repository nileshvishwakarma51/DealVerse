'use strict';

const fs = require('fs');
const path = require('path');
const { ApiError } = require('./lib/errors');
const { getConfig, setConfig } = require('./lib/store');
const { isValidSecret, expectedToken, checkBearer } = require('./lib/auth');
const { parseCurl, validateParsedCurl } = require('./lib/curl');
const { verifyAffiliate } = require('./lib/amazon');
const {
  generateAmazonLink,
  SITESTRIPE_KEY,
  AMAZON_KEY,
  DEFAULT_AMAZON,
} = require('./lib/affiliate');
const {
  TELEGRAM_KEY,
  connectBot,
  confirmBot,
  removeBot,
  sendTest,
  addChannel,
  removeChannel,
  setChannelAutoPublish,
  publishToChannels,
  publishAuto,
  processUpdate,
  maskTelegram,
  formatAffiliateMessage,
} = require('./lib/telegram');
const {
  parseUsername,
  fetchMessages,
  fetchEnriched,
  getListeners,
  addListener,
  removeListener,
} = require('./lib/listener');

// ── Static React build (copied into lambda/public at build time) ────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Extensions returned as base64 (binary) — API Gateway has these in
// binaryMediaTypes, so it decodes them back to bytes for the client.
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

function serveStatic(reqPath) {
  let rel = decodeURIComponent(reqPath).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  let filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return { statusCode: 403, headers: { ...CORS }, body: 'Forbidden' };
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  }
  if (!fs.existsSync(filePath)) {
    return { statusCode: 404, headers: { ...CORS }, body: 'Not found' };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXT.has(ext)) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS },
      body: fs.readFileSync(filePath).toString('base64'),
      isBase64Encoded: true,
    };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS },
    body: fs.readFileSync(filePath, 'utf8'),
  };
}

// Masked, non-sensitive view of the stored SiteStripe session.
function maskSiteStripe(cfg) {
  if (!cfg) return { configured: false };
  const cookieCount = cfg.cookies ? Object.keys(cfg.cookies).length : 0;
  return {
    configured: true,
    endpoint: cfg.url ? cfg.url.split('?')[0] : null,
    hasCookies: cookieCount > 0,
    cookieCount,
    configuredAt: cfg.configuredAt || null,
  };
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.');
  }
}

function lowerHeaders(event) {
  const out = {};
  const h = event.headers || {};
  for (const k in h) out[k.toLowerCase()] = h[k];
  return out;
}

// This API's own public base URL (e.g. https://<id>.execute-api…/prod).
function selfBaseUrl(event) {
  const h = lowerHeaders(event);
  const host = h.host || '';
  const stage = (event.requestContext && event.requestContext.stage) || '';
  return `https://${host}/${stage}`;
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const reqPath = (event.path || '/').replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') return respond(200, {});

  try {
    // ── Admin: login ──────────────────────────────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/login')) {
      const { secret } = parseBody(event);
      if (!isValidSecret(secret)) {
        return respond(401, { success: false, error: 'Incorrect password.' });
      }
      return respond(200, { success: true, token: expectedToken() });
    }

    // ── Admin: read current config (mode/tag + session status) (protected) ─
    if (method === 'GET' && reqPath.endsWith('/api/admin/config')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const amazon = (await getConfig(AMAZON_KEY)) || DEFAULT_AMAZON;
      const sitestripe = await getConfig(SITESTRIPE_KEY);
      return respond(200, {
        success: true,
        amazon: { mode: amazon.mode, tag: amazon.tag || '' },
        sitestripe: maskSiteStripe(sitestripe),
      });
    }

    // ── Admin: save Amazon mode + tag (protected) ─────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/amazon')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { mode, tag } = parseBody(event);
      if (mode !== 'TAG' && mode !== 'SITE_STRIPE') {
        return respond(400, { success: false, error: 'mode must be "TAG" or "SITE_STRIPE".' });
      }
      const cleanTag = typeof tag === 'string' ? tag.trim() : '';
      if (mode === 'TAG' && cleanTag === '') {
        return respond(400, { success: false, error: 'An affiliate tag is required for TAG mode.' });
      }
      const value = { mode, tag: cleanTag };
      await setConfig(AMAZON_KEY, value);
      return respond(200, { success: true, amazon: value });
    }

    // ── Admin: read current SiteStripe status (protected) ─────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/amazon/sitestripe')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const cfg = await getConfig(SITESTRIPE_KEY);
      return respond(200, { success: true, sitestripe: maskSiteStripe(cfg) });
    }

    // ── Admin: save SiteStripe curl (protected) ───────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/amazon/sitestripe')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { curl } = parseBody(event);
      const parsed = parseCurl(curl);
      validateParsedCurl(parsed);
      const value = { ...parsed, configuredAt: new Date().toISOString() };
      await setConfig(SITESTRIPE_KEY, value);
      return respond(200, { success: true, sitestripe: maskSiteStripe(value) });
    }

    // ── Admin: Telegram bot status (protected) ────────────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/telegram')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const cfg = await getConfig(TELEGRAM_KEY);
      return respond(200, {
        success: true,
        telegram: maskTelegram(cfg),
        suggestedBaseUrl: selfBaseUrl(event),
      });
    }

    // ── Admin: connect a bot (validate + register webhook) (protected) ─────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/connect')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { token, baseUrl } = parseBody(event);
      const base = (typeof baseUrl === 'string' && baseUrl.trim()) || selfBaseUrl(event);
      const webhookUrl = `${base.replace(/\/+$/, '')}/telegram/webhook`;
      const cfg = await connectBot(token, webhookUrl);
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: finalize bot setup (protected) ─────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/save')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const cfg = await confirmBot();
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: remove the bot (protected) ─────────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/remove')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      await removeBot();
      return respond(200, { success: true, telegram: { configured: false } });
    }

    // ── Admin: send a test message to a chat/channel (protected) ──────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/test-message')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { chatId, text } = parseBody(event);
      if (chatId === undefined || chatId === null || String(chatId).trim() === '') {
        return respond(400, { success: false, error: 'chatId is required.' });
      }
      await sendTest(chatId, text);
      return respond(200, { success: true });
    }

    // ── Admin: add a channel (protected) ──────────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/channel/add')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { id, title } = parseBody(event);
      const cfg = await addChannel(id, title);
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: remove a channel (protected) ───────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/channel/remove')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { id } = parseBody(event);
      const cfg = await removeChannel(id);
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: toggle auto-publish of user links to a channel (protected) ──
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/channel/auto-publish')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { id, autoPublish } = parseBody(event);
      const cfg = await setChannelAutoPublish(id, autoPublish);
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: list listener channels (protected) ────────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/listener')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, listeners: await getListeners() });
    }

    // ── Admin: test-read a public channel (last 5) (protected) ────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/test')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { channel } = parseBody(event);
      const username = parseUsername(channel);
      const messages = await fetchMessages(username, 5);
      return respond(200, { success: true, username, messages });
    }

    // ── Admin: add a listener channel (protected) ─────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/add')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { channel, title } = parseBody(event);
      const username = parseUsername(channel);
      const listeners = await addListener(username, title);
      return respond(200, { success: true, listeners });
    }

    // ── Admin: remove a listener channel (protected) ──────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/remove')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { username } = parseBody(event);
      const listeners = await removeListener(username);
      return respond(200, { success: true, listeners });
    }

    // ── Admin: read last N messages + fresh affiliate links (protected) ───
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/messages')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { channel, limit } = parseBody(event);
      const username = parseUsername(channel);
      const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
      const messages = await fetchEnriched(username, n);
      return respond(200, { success: true, username, messages });
    }

    // ── Admin: publish a message to the bot's channels (protected) ────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/publish')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { text } = parseBody(event);
      if (typeof text !== 'string' || text.trim() === '') {
        return respond(400, { success: false, error: 'Nothing to publish.' });
      }
      const sent = await publishToChannels(text);
      if (sent === 0) {
        return respond(400, { success: false, error: 'No channel configured. Add a bot channel first.' });
      }
      return respond(200, { success: true, sent });
    }

    // ── Telegram webhook (public; verified by secret header) ──────────────
    if (method === 'POST' && reqPath.endsWith('/telegram/webhook')) {
      const cfg = await getConfig(TELEGRAM_KEY);
      const secretHeader = lowerHeaders(event)['x-telegram-bot-api-secret-token'] || '';
      if (cfg && cfg.webhookSecret && secretHeader === cfg.webhookSecret) {
        let update = null;
        try {
          update = JSON.parse(event.body || '{}');
        } catch {
          update = null;
        }
        if (update) await processUpdate(update);
      }
      return respond(200, { ok: true }); // always 200 so Telegram does not retry
    }

    // ── Public: affiliate link generation ─────────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/affiliate/generate-link')) {
      const { url } = parseBody(event);
      if (typeof url !== 'string' || url.trim() === '') {
        return respond(400, { success: false, error: 'Paste an Amazon product link.' });
      }
      const result = await generateAmazonLink(url.trim());
      // Publish to channels that opted in to user/website-generated links.
      try {
        await publishAuto(formatAffiliateMessage(result));
      } catch {
        /* channel publish is best-effort */
      }
      return respond(200, result);
    }

    // ── Admin: verify an affiliate link carries our tag (protected) ───────
    if (method === 'POST' && reqPath.endsWith('/api/admin/affiliate/verify')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { url } = parseBody(event);
      if (typeof url !== 'string' || url.trim() === '') {
        return respond(400, { success: false, error: 'No URL to verify.' });
      }
      const amazon = (await getConfig(AMAZON_KEY)) || DEFAULT_AMAZON;
      const { finalUrl, tag, sitestripe } = await verifyAffiliate(url.trim());
      let ok = false;
      let status;
      if (tag) {
        ok = !!amazon.tag && tag.toLowerCase() === String(amazon.tag).toLowerCase();
        status = ok ? `Your tag (${tag})` : `Different tag (${tag})`;
      } else if (sitestripe) {
        ok = true;
        status = 'SiteStripe attributed (your session)';
      } else {
        status = 'No affiliate attribution found';
      }
      return respond(200, { success: true, finalUrl, tag, sitestripe, configuredTag: amazon.tag || null, ok, status });
    }

    // ── Public: is the affiliate service configured? ──────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/affiliate/status')) {
      const cfg = await getConfig(SITESTRIPE_KEY);
      return respond(200, { configured: !!cfg });
    }

    // ── Health check ──────────────────────────────────────────────────────
    if (method === 'GET' && reqPath.endsWith('/hello')) {
      return respond(200, { message: 'Hello World from dealverse-lambda!' });
    }

    // ── Unknown API route ─────────────────────────────────────────────────
    if (reqPath.startsWith('/api/')) {
      return respond(404, { success: false, error: 'Not found.' });
    }

    // ── Everything else: serve the React app (SPA) ────────────────────────
    if (method === 'GET') {
      if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
        return serveStatic(reqPath);
      }
      return respond(200, { message: 'Hello World from dealverse-lambda! (frontend not built yet)' });
    }

    return respond(404, { success: false, error: 'Not found.' });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    return respond(status, { success: false, error: err.message || 'Internal error.' });
  }
};
