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
  testSiteStripe,
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
  clearLastChannel,
  setChannelAutoPublish,
  setChannelActive,
  publishToChannels,
  publishAuto,
  processUpdate,
  maskTelegram,
  formatAffiliateMessage,
} = require('./lib/telegram');
const { logAudit, listAudit } = require('./lib/audit');
const {
  getBroadcasts,
  saveBroadcast,
  deleteBroadcast,
  sendNow,
  runBroadcasts,
} = require('./lib/broadcast');
const {
  parseUsername,
  fetchMessages,
  fetchEnriched,
  getListeners,
  probePublic,
  addListener,
  removeListener,
  setListenerAutomation,
} = require('./lib/listener');
const { getAutomation, maskAutomation, runAutomation } = require('./lib/automation');
// MTProto (beta). This module is dependency-free at load time — GramJS is
// lazy-required INSIDE its functions — so requiring it here can never affect
// existing routes or the automation tick, even if GramJS is not installed.
const mtproto = require('./lib/mtproto');

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

  // Cache-Control: hashed assets + images can be cached long; index.html must
  // revalidate so new deploys are picked up. Cuts repeat fetches (data transfer,
  // API Gateway requests, Lambda invocations).
  const isImmutable = rel.startsWith('assets/') || BINARY_EXT.has(ext);
  const cacheControl = isImmutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    ...CORS,
  };

  if (BINARY_EXT.has(ext)) {
    return {
      statusCode: 200,
      headers,
      body: fs.readFileSync(filePath).toString('base64'),
      isBase64Encoded: true,
    };
  }
  return { statusCode: 200, headers, body: fs.readFileSync(filePath, 'utf8') };
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
    status: cfg.status || 'ok',
    expiredAt: cfg.expiredAt || null,
    testedAt: cfg.testedAt || null,
  };
}

// With binaryMediaTypes '*/*', API Gateway base64-encodes incoming bodies.
function rawBody(event) {
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body || '';
}

function parseBody(event) {
  try {
    return JSON.parse(rawBody(event) || '{}');
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
  // EventBridge scheduled tick (no HTTP context) → run listener automation and
  // evaluate scheduled custom messages.
  if (!event.httpMethod && !event.requestContext) {
    try {
      const auto = await runAutomation('schedule');
      const bc = await runBroadcasts();
      return { auto, broadcasts: bc };
    } catch (err) {
      return { error: err.message };
    }
  }

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

    // ── Admin: test the SiteStripe session live (protected) ───────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/amazon/sitestripe/test')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const result = await testSiteStripe();
      const cfg = await getConfig(SITESTRIPE_KEY);
      return respond(200, { success: true, result, sitestripe: maskSiteStripe(cfg) });
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

    // ── Admin: reset channel detection before adding a new channel ────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/channel/detect-reset')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      await clearLastChannel();
      return respond(200, { success: true });
    }

    // ── Admin: toggle auto-publish of user links to a channel (protected) ──
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/channel/auto-publish')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { id, autoPublish } = parseBody(event);
      const cfg = await setChannelAutoPublish(id, autoPublish);
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: activate/deactivate a channel (protected) ──────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/telegram/channel/active')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { id, active } = parseBody(event);
      const cfg = await setChannelActive(id, active);
      return respond(200, { success: true, telegram: maskTelegram(cfg) });
    }

    // ── Admin: audit log (protected) ──────────────────────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/audit')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, audit: await listAudit(60) });
    }

    // ── Admin: broadcasts list (protected) ────────────────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/broadcasts')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, broadcasts: await getBroadcasts() });
    }

    // ── Admin: save a broadcast (protected) ───────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/broadcasts/save')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const items = await saveBroadcast(parseBody(event));
      return respond(200, { success: true, broadcasts: items });
    }

    // ── Admin: delete a broadcast (protected) ─────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/broadcasts/delete')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { id } = parseBody(event);
      const items = await deleteBroadcast(id);
      return respond(200, { success: true, broadcasts: items });
    }

    // ── Admin: send a custom message now (protected) ──────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/broadcasts/send-now')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { text, pin } = parseBody(event);
      const result = await sendNow(text, pin);
      return respond(200, { success: true, result });
    }

    // ── Admin: list listener channels (protected) ────────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/listener')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, listeners: await getListeners() });
    }

    // ── Admin: test-read a channel; auto-pick public preview vs MTProto ────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/test')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { channel } = parseBody(event);
      const username = parseUsername(channel);
      if (await probePublic(username)) {
        const messages = await fetchMessages(username, 5);
        return respond(200, { success: true, username, source: 'public', messages });
      }
      // No public preview → it's a group / private / preview-disabled channel.
      const st = await mtproto.status();
      if (!st.loggedIn) {
        return respond(400, {
          success: false,
          error:
            'No public preview for this handle (it looks like a group or private channel). Set up "Logged-in Telegram access" above — log in with a Telegram account that is a member — then try again.',
        });
      }
      const enriched = await mtproto.fetchEnriched(username, 5);
      return respond(200, {
        success: true,
        username,
        source: 'mtproto',
        messages: enriched.map((m) => ({ id: m.id, text: m.text })),
      });
    }

    // ── Admin: add a listener channel (protected) ─────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/add')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { channel, title, source } = parseBody(event);
      const username = parseUsername(channel);
      const listeners = await addListener(username, title, source);
      return respond(200, { success: true, listeners });
    }

    // ── Admin: remove a listener channel (protected) ──────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/remove')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { username } = parseBody(event);
      const listeners = await removeListener(username);
      return respond(200, { success: true, listeners });
    }

    // ── Admin: per-listener automation settings (protected) ──────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/automation')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { username, auto, intervalMinutes, count } = parseBody(event);
      const listeners = await setListenerAutomation(username, { auto, intervalMinutes, count });
      return respond(200, { success: true, listeners });
    }

    // ── Admin: automation status (protected) ──────────────────────────────
    if (method === 'GET' && reqPath.endsWith('/api/admin/automation')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, automation: maskAutomation(await getAutomation()) });
    }

    // ── Admin: run the automation now (protected) ─────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/admin/automation/run')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const result = await runAutomation('manual');
      return respond(200, { success: true, result });
    }

    // ── Admin: read last N messages + fresh affiliate links (protected) ───
    if (method === 'POST' && reqPath.endsWith('/api/admin/listener/messages')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { channel, limit } = parseBody(event);
      const username = parseUsername(channel);
      const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
      const listeners = await getListeners();
      const found = listeners.find((l) => l.username.toLowerCase() === username.toLowerCase());
      const messages =
        found && found.source === 'mtproto'
          ? await mtproto.fetchEnriched(username, n)
          : await fetchEnriched(username, n);
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

    // ── MTProto (BETA): read private groups / preview-disabled channels ───
    // Every route below is Bearer-guarded and delegates to lib/mtproto.js,
    // which lazy-requires GramJS. Errors here NEVER affect other routes.

    // Masked status (never returns api_hash / session).
    if (method === 'GET' && reqPath.endsWith('/api/admin/mtproto')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, mtproto: await mtproto.status() });
    }

    // Save api_id + api_hash.
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/api')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { apiId, apiHash } = parseBody(event);
      const st = await mtproto.saveApi(apiId, apiHash);
      return respond(200, { success: true, mtproto: st });
    }

    // Login step 1 — send the login code to the account.
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/send-code')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { phone } = parseBody(event);
      const st = await mtproto.sendCode(phone);
      return respond(200, { success: true, mtproto: st });
    }

    // Login step 2 — submit the code (+ optional 2FA password).
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/sign-in')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { code, password } = parseBody(event);
      const st = await mtproto.signIn(code, password);
      return respond(200, { success: true, mtproto: st });
    }

    // Log the user account out (revokes the session).
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/logout')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const st = await mtproto.logout();
      return respond(200, { success: true, mtproto: st });
    }

    // Clear ALL MTProto credentials + session (start fresh with a new account).
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/clear')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const st = await mtproto.clearCredentials();
      return respond(200, { success: true, mtproto: st });
    }

    // Read-only: list the account's groups/channels (for picking a source).
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/dialogs')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { limit } = parseBody(event);
      const dialogs = await mtproto.listDialogs(limit);
      return respond(200, { success: true, dialogs });
    }

    // Manage MTProto listener sources (admin bookkeeping only).
    if (method === 'GET' && reqPath.endsWith('/api/admin/mtproto/sources')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      return respond(200, { success: true, sources: await mtproto.getSources() });
    }
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/sources/add')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { peer, title } = parseBody(event);
      const sources = await mtproto.addSource(peer, title);
      return respond(200, { success: true, sources });
    }
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/sources/remove')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { peer } = parseBody(event);
      const sources = await mtproto.removeSource(peer);
      return respond(200, { success: true, sources });
    }

    // Read-only: last N messages from a source + fresh affiliate links.
    // Publishing re-uses the EXISTING /api/admin/listener/publish route.
    if (method === 'POST' && reqPath.endsWith('/api/admin/mtproto/messages')) {
      if (!checkBearer(event)) return respond(401, { success: false, error: 'Unauthorized.' });
      const { peer, limit } = parseBody(event);
      const messages = await mtproto.fetchEnriched(peer, limit);
      return respond(200, { success: true, peer: String(peer), messages });
    }

    // ── Telegram webhook (public; verified by secret header) ──────────────
    if (method === 'POST' && reqPath.endsWith('/telegram/webhook')) {
      const cfg = await getConfig(TELEGRAM_KEY);
      const secretHeader = lowerHeaders(event)['x-telegram-bot-api-secret-token'] || '';
      if (cfg && cfg.webhookSecret && secretHeader === cfg.webhookSecret) {
        let update = null;
        try {
          update = JSON.parse(rawBody(event) || '{}');
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
      await logAudit('website', `Website generated affiliate link (${result.asin || 'page'}).`);
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
