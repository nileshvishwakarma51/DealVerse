'use strict';

// MTProto (BETA) — read PRIVATE groups / preview-disabled channels via a
// logged-in Telegram USER account, using GramJS (the `telegram` npm package).
//
// ISOLATION CONTRACT (do not break):
//   * GramJS is a real npm dependency that ships in the Lambda asset. It is
//     ONLY ever `require`d lazily, inside the functions that need it (never at
//     module load). So requiring THIS module is cheap and dependency-free; if
//     GramJS is missing or throws, only MTProto routes fail — every existing
//     route and the automation tick keep working.
//   * All GramJS use is READ-ONLY here (login, list dialogs, read messages).
//     Publishing re-uses the existing bot publish path (telegram.js) via the
//     existing /api/admin/listener/publish route — nothing is auto-posted.
//
// Sensitive values (api_hash, the StringSession, phoneCodeHash) live in
// DynamoDB under the "mtproto" key and are NEVER returned to the client or
// logged. Only maskStatus() output leaves this module.
const { ApiError } = require('./errors');
const { getConfig, setConfig } = require('./store');
const { generateAmazonLink } = require('./affiliate');
const { allAmazonLinks } = require('./listener');
const { logAudit } = require('./audit');

const MTPROTO_KEY = 'mtproto';
const CONNECT_RETRIES = 3;

// ── GramJS is loaded lazily so the rest of the app never depends on it. ──────
function requireGram() {
  try {
    // eslint-disable-next-line global-require
    const telegram = require('telegram');
    // eslint-disable-next-line global-require
    const { StringSession } = require('telegram/sessions');
    return { TelegramClient: telegram.TelegramClient, Api: telegram.Api, StringSession };
  } catch (err) {
    throw new ApiError(
      503,
      'MTProto (beta) is unavailable: the Telegram MTProto library is not installed in this deployment.'
    );
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

// Show only the tail of a phone number so status never reveals the full value.
function maskPhone(phone) {
  const s = String(phone || '').replace(/[^\d+]/g, '');
  if (s.length <= 4) return s ? `••${s.slice(-2)}` : null;
  return `${s.slice(0, 3)}••••${s.slice(-2)}`;
}

// Non-sensitive view. NEVER includes api_hash, the session string, or the
// phoneCodeHash. api_id is an app identifier (not a secret) and is returned so
// the UI can show it.
function maskStatus(cfg) {
  if (!cfg) {
    return { configured: false, apiConfigured: false, loggedIn: false, awaitingCode: false, sources: [] };
  }
  const apiConfigured = !!(cfg.apiId && cfg.apiHash);
  return {
    configured: apiConfigured,
    apiConfigured,
    apiId: cfg.apiId ? String(cfg.apiId) : null,
    loggedIn: !!cfg.session,
    awaitingCode: !!(cfg.login && cfg.login.phoneCodeHash),
    pendingPhone: cfg.login ? maskPhone(cfg.login.phone) : null,
    user: cfg.session && cfg.user ? cfg.user : null,
    loggedInAt: cfg.loggedInAt || null,
    sources: (cfg.sources || []).map((s) => ({ peer: s.peer, title: s.title })),
  };
}

async function readCfg() {
  return (await getConfig(MTPROTO_KEY)) || {};
}

// Build + connect a GramJS client from stored credentials and a session string
// ('' for a brand-new login). Callers MUST disconnect via safeDisconnect().
async function connectClient(cfg, sessionStr) {
  const { TelegramClient, StringSession, Api } = requireGram();
  const apiId = parseInt(cfg.apiId, 10);
  const apiHash = cfg.apiHash;
  if (!apiId || !apiHash) throw new ApiError(400, 'Set your api_id and api_hash first.');
  const client = new TelegramClient(new StringSession(sessionStr || ''), apiId, apiHash, {
    connectionRetries: CONNECT_RETRIES,
  });
  // Silence GramJS's default console logger (best-effort across versions).
  try {
    if (typeof client.setLogLevel === 'function') client.setLogLevel('none');
    else if (client.logger && typeof client.logger.setLevel === 'function') client.logger.setLevel('none');
  } catch {
    /* ignore */
  }
  await client.connect();
  return { client, Api };
}

async function safeDisconnect(client) {
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    /* ignore */
  }
  try {
    if (typeof client.destroy === 'function') await client.destroy();
  } catch {
    /* ignore */
  }
}

// ── API credentials ──────────────────────────────────────────────────────────
async function saveApi(apiId, apiHash) {
  const id = parseInt(apiId, 10);
  const hash = String(apiHash || '').trim();
  if (!Number.isFinite(id) || id <= 0) throw new ApiError(400, 'api_id must be a number (from my.telegram.org).');
  if (!/^[a-f0-9]{16,}$/i.test(hash)) throw new ApiError(400, 'api_hash does not look valid (a long hex string).');
  const cfg = await readCfg();
  cfg.apiId = id;
  cfg.apiHash = hash;
  await setConfig(MTPROTO_KEY, cfg);
  return maskStatus(cfg);
}

// ── Login step 1: request a login code (persists interim session + hash) ─────
// Telegram sends a code to the account. The interim GramJS session (which
// remembers the DC + temp auth key used for THIS code request) is saved so the
// NEXT invocation can complete sign-in — Lambda invocations are separate
// processes, so this cross-invocation persistence is essential.
async function sendCode(phoneRaw) {
  const phone = String(phoneRaw || '').trim();
  if (!/^\+?\d{6,15}$/.test(phone)) {
    throw new ApiError(400, 'Enter a valid phone number in international format, e.g. +9198XXXXXXXX.');
  }
  const cfg = await readCfg();
  if (!cfg.apiId || !cfg.apiHash) throw new ApiError(400, 'Set your api_id and api_hash first.');

  const { client } = await connectClient(cfg, ''); // fresh session for a new login
  try {
    let result;
    try {
      result = await client.sendCode({ apiId: parseInt(cfg.apiId, 10), apiHash: cfg.apiHash }, phone);
    } catch (err) {
      throw mapRpcError(err, 'Could not send the login code.');
    }
    const interim = client.session.save();
    cfg.login = {
      phone,
      phoneCodeHash: result.phoneCodeHash,
      session: interim,
      at: new Date().toISOString(),
    };
    await setConfig(MTPROTO_KEY, cfg);
    return maskStatus(cfg);
  } finally {
    await safeDisconnect(client);
  }
}

// ── Login step 2: submit the code (+ optional 2FA password) ──────────────────
// Restores the interim session persisted by sendCode(), completes sign-in, then
// stores the FINAL long-lived session string.
async function signIn(codeRaw, passwordRaw) {
  const cfg = await readCfg();
  const login = cfg.login;
  if (!login || !login.session || !login.phoneCodeHash) {
    throw new ApiError(400, 'Request a login code first.');
  }
  const code = String(codeRaw || '').trim();
  if (!code) throw new ApiError(400, 'Enter the login code Telegram sent you.');

  const { client, Api } = await connectClient(cfg, login.session);
  try {
    let signedIn = false;
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: login.phone,
          phoneCodeHash: login.phoneCodeHash,
          phoneCode: code,
        })
      );
      signedIn = true;
    } catch (err) {
      const msg = rpcMessage(err);
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        // Two-step verification (2FA) is enabled — complete with the password.
        const password = String(passwordRaw || '');
        if (!password) {
          throw new ApiError(401, 'Two-step verification is enabled. Enter your Telegram password and submit again.');
        }
        let computeCheck;
        try {
          // eslint-disable-next-line global-require
          const pw = require('telegram/Password');
          computeCheck = pw.computeCheck || pw.computePasswordSrpCheck;
        } catch {
          throw new ApiError(503, 'MTProto (beta) is unavailable for 2FA in this deployment.');
        }
        try {
          const pwdInfo = await client.invoke(new Api.account.GetPassword());
          const check = await computeCheck(pwdInfo, password);
          await client.invoke(new Api.auth.CheckPassword({ password: check }));
          signedIn = true;
        } catch (perr) {
          throw mapRpcError(perr, 'Two-step verification password was not accepted.');
        }
      } else {
        throw mapRpcError(err, 'Sign in failed.');
      }
    }
    if (!signedIn) throw new ApiError(401, 'Sign in failed.');

    const me = await client.getMe();
    cfg.session = client.session.save(); // long-lived session — sensitive
    cfg.user = {
      id: me && me.id !== undefined ? String(me.id) : null,
      username: (me && me.username) || null,
      firstName: (me && me.firstName) || null,
      phone: me && me.phone ? maskPhone(me.phone) : maskPhone(login.phone),
    };
    cfg.loggedInAt = new Date().toISOString();
    delete cfg.login;
    await setConfig(MTPROTO_KEY, cfg);
    await logAudit('mtproto', 'MTProto user account logged in (beta).');
    return maskStatus(cfg);
  } finally {
    await safeDisconnect(client);
  }
}

// ── Logout: revoke the session remotely (best-effort) + clear it locally. ────
async function logout() {
  const cfg = await readCfg();
  if (cfg.session) {
    try {
      const { client, Api } = await connectClient(cfg, cfg.session);
      try {
        await client.invoke(new Api.auth.LogOut());
      } catch {
        /* best-effort remote revoke */
      } finally {
        await safeDisconnect(client);
      }
    } catch {
      /* GramJS unavailable or connect failed — still clear locally */
    }
  }
  delete cfg.session;
  delete cfg.user;
  delete cfg.login;
  delete cfg.loggedInAt;
  await setConfig(MTPROTO_KEY, cfg);
  await logAudit('mtproto', 'MTProto user account logged out (beta).');
  return maskStatus(cfg);
}

async function status() {
  return maskStatus(await readCfg());
}

// ── Read-only: list the account's groups/channels (dialogs). ─────────────────
async function listDialogs(limitRaw) {
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const limit = clampInt(limitRaw, 1, 100, 50);
  const { client } = await connectClient(cfg, cfg.session);
  try {
    let dialogs;
    try {
      dialogs = await client.getDialogs({ limit });
    } catch (err) {
      throw mapRpcError(err, 'Could not list your chats.');
    }
    return dialogs
      .map((d) => ({
        id: d && d.id !== undefined && d.id !== null ? String(d.id) : null,
        title: (d && (d.title || d.name)) || '(untitled)',
        username: (d && d.entity && d.entity.username) || null,
        isChannel: !!(d && d.isChannel),
        isGroup: !!(d && d.isGroup),
        isUser: !!(d && d.isUser),
      }))
      .filter((d) => !d.isUser); // groups + channels only
  } finally {
    await safeDisconnect(client);
  }
}

// Accepts @username, a t.me link, a bare username, or a numeric id.
function normalizePeer(input) {
  if (input === undefined || input === null || String(input).trim() === '') {
    throw new ApiError(400, 'Enter a group/channel @username or id.');
  }
  let s = String(input).trim();
  const m = s.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  s = s.replace(/^@/, '');
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^[A-Za-z0-9_]{3,}$/.test(s)) return s;
  throw new ApiError(400, 'Enter a group/channel @username or numeric id.');
}

// Pull URLs out of a GramJS message: plain URLs in the text plus any hidden
// URLs carried by text_url entities.
function extractLinks(msg) {
  const out = [];
  const text = (msg && msg.message) || '';
  for (const mm of text.matchAll(/https?:\/\/[^\s]+/gi)) out.push(mm[0]);
  for (const e of (msg && msg.entities) || []) {
    if (e && e.url) out.push(e.url);
  }
  return out;
}

// ── Read-only: last N messages from a source, with fresh affiliate links. ────
// Mirrors listener.fetchEnriched()'s output shape so the UI can reuse it.
async function fetchEnriched(peerRaw, limitRaw) {
  const peer = normalizePeer(peerRaw);
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const limit = clampInt(limitRaw, 1, 30, 10);

  const { client } = await connectClient(cfg, cfg.session);
  try {
    let entity;
    try {
      entity = await client.getEntity(peer);
    } catch (err) {
      throw mapRpcError(
        err,
        'Could not resolve that group/channel. Use its @username, or make sure this account is a member.'
      );
    }
    let messages;
    try {
      messages = await client.getMessages(entity, { limit });
    } catch (err) {
      throw mapRpcError(err, 'Could not read messages from that source.');
    }

    const out = [];
    for (const m of messages) {
      const text = (m && m.message) || '';
      const links = allAmazonLinks(extractLinks(m));
      const items = [];
      for (const url of links) {
        try {
          const r = await generateAmazonLink(url, { withMeta: false });
          items.push({
            sourceUrl: url,
            affiliate: { affiliateUrl: r.affiliateUrl, method: r.method, fallback: r.fallback, asin: r.asin },
          });
        } catch (e) {
          items.push({ sourceUrl: url, affiliate: { error: e.message } });
        }
      }
      out.push({ id: m && m.id !== undefined ? String(m.id) : String(out.length), text, items });
    }
    return out;
  } finally {
    await safeDisconnect(client);
  }
}

// Read-only raw messages (no affiliate generation) for the automation tick's
// de-dup — mirrors listener.fetchAmazonMessages()'s shape: {id, numId, text, links}.
async function fetchRaw(peerRaw, limitRaw) {
  const peer = normalizePeer(peerRaw);
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const limit = clampInt(limitRaw, 1, 30, 10);
  const { client } = await connectClient(cfg, cfg.session);
  try {
    const entity = await client.getEntity(peer).catch((err) => {
      throw mapRpcError(err, 'Could not resolve that group/channel.');
    });
    const messages = await client.getMessages(entity, { limit }).catch((err) => {
      throw mapRpcError(err, 'Could not read messages from that source.');
    });
    return messages.map((m) => ({
      id: m && m.id !== undefined ? String(m.id) : '0',
      numId: m && Number.isFinite(Number(m.id)) ? Number(m.id) : 0,
      text: (m && m.message) || '',
      links: allAmazonLinks(extractLinks(m)),
    }));
  } finally {
    await safeDisconnect(client);
  }
}

// Wipe ALL MTProto config (api creds, session, login, sources) so the admin can
// start fresh with a different account. Best-effort remote logout first.
async function clearCredentials() {
  try {
    await logout();
  } catch {
    /* ignore — we clear locally regardless */
  }
  await setConfig(MTPROTO_KEY, {});
  return maskStatus({});
}

// ── Sources (just admin bookkeeping in DynamoDB; no network) ──────────────────
async function getSources() {
  const cfg = await readCfg();
  return (cfg.sources || []).map((s) => ({ peer: s.peer, title: s.title }));
}

async function addSource(peerRaw, title) {
  const peerNorm = normalizePeer(peerRaw);
  const peer = String(peerNorm);
  const cfg = await readCfg();
  const items = (cfg.sources || []).filter((s) => String(s.peer).toLowerCase() !== peer.toLowerCase());
  items.push({ peer, title: (title && String(title).trim()) || peer });
  cfg.sources = items;
  await setConfig(MTPROTO_KEY, cfg);
  return items.map((s) => ({ peer: s.peer, title: s.title }));
}

async function removeSource(peerRaw) {
  const peer = String(peerRaw == null ? '' : peerRaw);
  const cfg = await readCfg();
  cfg.sources = (cfg.sources || []).filter((s) => String(s.peer).toLowerCase() !== peer.toLowerCase());
  await setConfig(MTPROTO_KEY, cfg);
  return cfg.sources.map((s) => ({ peer: s.peer, title: s.title }));
}

// ── Error helpers ─────────────────────────────────────────────────────────────
function rpcMessage(err) {
  return String((err && (err.errorMessage || err.message)) || '');
}

// Translate common Telegram RPC errors into friendly, non-leaking messages.
function mapRpcError(err, fallback) {
  if (err instanceof ApiError) return err;
  const m = rpcMessage(err).toUpperCase();
  const map = {
    PHONE_CODE_INVALID: 'That login code is incorrect.',
    PHONE_CODE_EXPIRED: 'That login code expired. Request a new one.',
    PHONE_CODE_EMPTY: 'Enter the login code Telegram sent you.',
    PHONE_NUMBER_INVALID: 'That phone number is not valid.',
    PHONE_NUMBER_UNOCCUPIED: 'No Telegram account exists for that phone number.',
    PHONE_NUMBER_BANNED: 'That phone number is banned from Telegram.',
    PASSWORD_HASH_INVALID: 'The two-step verification password is incorrect.',
    API_ID_INVALID: 'The api_id / api_hash pair is invalid.',
    API_ID_PUBLISHED_FLOOD: 'This api_id is rate-limited by Telegram. Try again later.',
    AUTH_KEY_UNREGISTERED: 'The session is no longer valid. Log in again.',
    USERNAME_NOT_OCCUPIED: 'No such group/channel username.',
    CHANNEL_PRIVATE: 'This account cannot access that channel (not a member, or private).',
  };
  for (const key of Object.keys(map)) {
    if (m.includes(key)) return new ApiError(400, map[key]);
  }
  const floodM = m.match(/FLOOD_WAIT_(\d+)/);
  if (floodM) return new ApiError(429, `Telegram rate limit — wait ${floodM[1]}s and try again.`);
  return new ApiError(502, fallback || 'MTProto request failed.');
}

module.exports = {
  MTPROTO_KEY,
  maskStatus,
  status,
  saveApi,
  sendCode,
  signIn,
  logout,
  clearCredentials,
  listDialogs,
  fetchEnriched,
  fetchRaw,
  getSources,
  addSource,
  removeSource,
  // exported for tests / reuse
  normalizePeer,
  extractLinks,
};
