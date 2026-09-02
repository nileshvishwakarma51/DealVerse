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
const { getConfig, setConfig, getTenant } = require('./store');
const { generateLink, getActivePlatforms } = require('./affiliate');
const { activeLinks, dealLinks } = require('./links');
const { logAudit } = require('./audit');

const MTPROTO_KEY = 'mtproto';
const CONNECT_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// SENSITIVE: return the stored session + api creds so the LOCAL listener (see
// /local-mtproto) can reuse the account already logged in via the admin
// "Telegram login" tab — no second phone login. Merchant-authed; only ever sent
// to the merchant's own tool over HTTPS. Never logged.
async function exportSession() {
  const cfg = await readCfg();
  if (!cfg.session) {
    throw new ApiError(400, 'No Telegram account is logged in. Log in under "Telegram login" first.');
  }
  return {
    apiId: cfg.apiId ? String(cfg.apiId) : null,
    apiHash: cfg.apiHash || null,
    session: cfg.session,
  };
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
      .map((d) => {
        const ent = (d && d.entity) || {};
        // creator or having adminRights means this account can manage members.
        const admin = !!(ent.creator || ent.adminRights);
        return {
          id: d && d.id !== undefined && d.id !== null ? String(d.id) : null,
          title: (d && (d.title || d.name)) || '(untitled)',
          username: ent.username || null,
          isChannel: !!(d && d.isChannel),
          isGroup: !!(d && d.isGroup),
          isUser: !!(d && d.isUser),
          admin,
        };
      })
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

// Pull URLs out of a GramJS message: plain URLs in the text, hidden URLs from
// text_url entities, and any inline-keyboard button URLs (conversion bots often
// return the affiliate link as a button).
function extractLinks(msg) {
  const out = [];
  const text = (msg && msg.message) || '';
  for (const mm of text.matchAll(/https?:\/\/[^\s]+/gi)) out.push(mm[0]);
  for (const e of (msg && msg.entities) || []) {
    if (e && e.url) out.push(e.url);
  }
  const rows = (msg && msg.replyMarkup && msg.replyMarkup.rows) || [];
  for (const row of rows) {
    for (const b of (row && row.buttons) || []) {
      if (b && b.url) out.push(b.url);
    }
  }
  return out;
}

// Send a message to a bot (or any peer) as the logged-in USER and wait for the
// reply. Used by Flipkart conversion (bots can't message bots). Returns
// { text, links } gathered from the reply message(s). Requires an active session.
async function sendToBot(peerRaw, messageText, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs, 3000, 60000, 18000);
  const pollMs = clampInt(opts.pollMs, 500, 5000, 1500);
  const cfg = await readCfg();
  if (!cfg.session) {
    throw new ApiError(400, 'Telegram login is required for Flipkart conversion. Log in under "Telegram login" first.');
  }
  const peer = normalizePeer(peerRaw);
  const { client } = await connectClient(cfg, cfg.session);
  try {
    let entity;
    try {
      entity = await client.getEntity(peer);
    } catch (err) {
      throw mapRpcError(err, 'Could not find the conversion bot. Check its @username and that this account can message it.');
    }

    let sentId = 0;
    try {
      const sent = await client.sendMessage(entity, { message: String(messageText) });
      sentId = sent && sent.id ? Number(sent.id) : 0;
    } catch (err) {
      throw mapRpcError(err, 'Could not message the conversion bot.');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let msgs;
      try {
        msgs = await client.getMessages(entity, { limit: 6 });
      } catch (err) {
        throw mapRpcError(err, 'Could not read the conversion bot reply.');
      }
      const replies = (msgs || [])
        .filter((m) => m && !m.out && Number(m.id) > sentId && ((m.message && m.message.trim()) || (m.entities && m.entities.length) || (m.replyMarkup && m.replyMarkup.rows)))
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (replies.length) {
        const text = replies.map((r) => r.message || '').join('\n').trim();
        const links = [];
        for (const r of replies) for (const l of extractLinks(r)) links.push(l);
        return { text, links };
      }
    }
    throw new ApiError(504, 'The conversion bot did not reply in time. Try again.');
  } finally {
    await safeDisconnect(client);
  }
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

    const active = await getActivePlatforms();
    const out = [];
    for (const m of messages) {
      const text = (m && m.message) || '';
      const links = activeLinks(extractLinks(m), active);
      const items = [];
      for (const url of links) {
        try {
          const r = await generateLink(url, { withMeta: false });
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
    // Return ALL deal links (both platforms, unfiltered) so the automation trace
    // can explain per-link decisions (e.g. "Flipkart is off" vs conversion error).
    return messages.map((m) => ({
      id: m && m.id !== undefined ? String(m.id) : '0',
      numId: m && Number.isFinite(Number(m.id)) ? Number(m.id) : 0,
      text: (m && m.message) || '',
      links: dealLinks(extractLinks(m)).map((d) => d.url),
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

// ── Import users (BETA, ToS-risky) — two phases ───────────────────────────────
// Telegram treats bulk-adding scraped members as spam: most adds fail with a
// privacy error and the account gets flood-limited after only a few. So the
// flow is split:
//   1) FETCH — read members of a source group (relatively safe, read-only) and
//      persist the minimal data needed to add them later (id + access_hash) to a
//      single DynamoDB pool item.
//   2) ADD  — later, add a small, capped, paced batch from the saved pool to a
//      target channel, updating each candidate's status and logging per-user
//      results to CloudWatch. Stops immediately on a flood limit.
const IMPORT_POOL_KEY = 'import_pool'; // tenant-scoped candidate pool
const IMPORTAUTO_KEY = 'importauto'; // tenant-scoped daily auto-add config
const IMPORT_AUTO_MAX = 5; // hard cap per day for the scheduled auto-add (flood-safe)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IMPORT_PER_RUN_MAX = 15;
const IMPORT_PER_DAY_MAX = 30;
const IMPORT_MSG_PER_DAY_MAX = 20; // separate cap for direct messages
const IMPORT_FETCH_MAX = 500; // members read per fetch call
const IMPORT_POOL_CAP = 2000; // keep the DynamoDB item well under its size limit
const IMPORT_PACE_MS = 3000; // gap between adds to reduce flood risk
const IMPORT_BUDGET_MS = 45000; // stay well under the 60s Lambda timeout

async function readPool() {
  const p = (await getConfig(IMPORT_POOL_KEY)) || {};
  return {
    users: p.users || [],
    source: p.source || null,
    target: p.target || null,
    fetchedAt: p.fetchedAt || null,
    message: p.message || '',
    addedTotal: p.addedTotal || 0,
    addedIds: p.addedIds || [], // ids ever added — so re-fetch never re-adds them
  };
}

function poolCounts(pool) {
  // `added` is cumulative (added members are removed from the pool), so it comes
  // from a running tally; the rest are counted from the members still in the pool.
  const c = { total: 0, pending: 0, added: (pool && pool.addedTotal) || 0, privacy: 0, failed: 0 };
  for (const u of (pool && pool.users) || []) {
    c.total++;
    if (u.status === 'pending') c.pending++;
    else if (u.status === 'privacy') c.privacy++;
    else if (u.status === 'failed') c.failed++;
  }
  return c;
}

// Client-safe view. Includes the user id (needed to target a single add) but
// NEVER the access_hash, which is the sensitive part that stays server-side.
function maskPool(pool) {
  const users = ((pool && pool.users) || []).slice(0, 500).map((u) => ({
    id: String(u.id),
    username: u.username || null,
    firstName: u.firstName || null,
    status: u.status,
    lastError: u.lastError || null,
    at: u.at || null,
    messagedAt: u.messagedAt || null,
    messageError: u.messageError || null,
  }));
  return {
    source: (pool && pool.source) || null,
    target: (pool && pool.target) || null,
    fetchedAt: (pool && pool.fetchedAt) || null,
    message: (pool && pool.message) || '',
    counts: poolCounts(pool),
    users,
  };
}

// One-time self-heal: members added under the OLD code kept status 'added' in
// the pool. Fold any such legacy rows into the running tally and drop them, so
// added members never linger in Step 2.
async function normalizePool() {
  const pool = await readPool();
  const users = pool.users || [];
  const legacy = users.filter((u) => u.status === 'added');
  if (legacy.length) {
    pool.users = users.filter((u) => u.status !== 'added');
    pool.addedTotal = (pool.addedTotal || 0) + legacy.length;
    pool.addedIds = pool.addedIds || [];
    for (const u of legacy) if (!pool.addedIds.includes(String(u.id))) pool.addedIds.push(String(u.id));
    await setConfig(IMPORT_POOL_KEY, pool);
  }
  return pool;
}

async function importStatus() {
  return maskPool(await normalizePool());
}

async function importClear() {
  // Keep addedIds so cleared-then-refetched pools still won't re-add past members.
  const prev = await readPool();
  await setConfig(IMPORT_POOL_KEY, {
    users: [], source: null, target: null, fetchedAt: null, message: prev.message || '',
    addedTotal: prev.addedTotal || 0, addedIds: prev.addedIds || [],
  });
  await logAudit('mtproto', 'Cleared the import pool.');
  return maskPool(await readPool());
}

// Phase 1: read members from a source group into the pool (dedup by id).
async function importFetch(sourceRaw, limitRaw) {
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const limit = clampInt(limitRaw, 1, IMPORT_FETCH_MAX, 100);
  const pool = await readPool();
  const byId = new Map((pool.users || []).map((u) => [String(u.id), u]));
  const alreadyAdded = new Set((pool.addedIds || []).map(String)); // never re-fetch these

  const { client } = await connectClient(cfg, cfg.session);
  try {
    let source;
    try {
      source = await client.getEntity(normalizePeer(sourceRaw));
    } catch (err) {
      throw mapRpcError(err, 'Could not resolve the source group. Make sure this account is a member.');
    }
    let participants;
    try {
      participants = await client.getParticipants(source, { limit });
    } catch (err) {
      throw mapRpcError(err, 'Could not read the source members (it may hide its member list, or this account lacks access).');
    }

    let added = 0;
    let skippedNoHash = 0;
    for (const u of participants || []) {
      if (!u || u.bot || u.self || u.deleted) continue;
      if (!u.accessHash) { skippedNoHash++; continue; } // cannot be added later without it
      const id = String(u.id);
      if (byId.has(id) || alreadyAdded.has(id)) continue; // skip existing + already-added
      if (byId.size >= IMPORT_POOL_CAP) break;
      byId.set(id, {
        id,
        accessHash: String(u.accessHash),
        username: u.username || null,
        firstName: u.firstName || null,
        status: 'pending',
        attempts: 0,
        lastError: null,
        at: null,
      });
      added++;
    }

    pool.users = Array.from(byId.values());
    pool.source = String(sourceRaw).trim();
    pool.fetchedAt = new Date().toISOString();
    await setConfig(IMPORT_POOL_KEY, pool);
    console.log('import.fetch', JSON.stringify({
      tenant: getTenant(), source: pool.source, read: (participants || []).length,
      newPending: added, skippedNoHash, poolTotal: pool.users.length,
    }));
    await logAudit('mtproto', `Fetched members from ${pool.source}: +${added} new (pool ${pool.users.length}).`);
    return maskPool(pool);
  } finally {
    await safeDisconnect(client);
  }
}

// Phase 2: add a capped, paced batch of pending pool members to a target channel.
async function importAdd(targetRaw, countRaw) {
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const requested = clampInt(countRaw, 1, IMPORT_PER_RUN_MAX, 5);

  const today = new Date().toISOString().slice(0, 10);
  const dlog = cfg.importLog && cfg.importLog.date === today ? cfg.importLog : { date: today, added: 0 };
  if (dlog.added >= IMPORT_PER_DAY_MAX) {
    throw new ApiError(429, `Daily add limit reached (${IMPORT_PER_DAY_MAX}). Try again tomorrow.`);
  }
  const room = Math.min(requested, IMPORT_PER_DAY_MAX - dlog.added);

  const pool = await readPool();
  const pending = (pool.users || []).filter((u) => u.status === 'pending');
  if (!pending.length) throw new ApiError(400, 'No pending members in the pool. Fetch members first.');

  // eslint-disable-next-line global-require
  const bigInt = require('big-integer');
  const { client, Api } = await connectClient(cfg, cfg.session);
  try {
    let target;
    try {
      target = await client.getEntity(normalizePeer(targetRaw));
    } catch (err) {
      throw mapRpcError(err, 'Could not resolve your target channel. Make sure this account is an admin there.');
    }

    let added = 0;
    let privacy = 0;
    let failed = 0;
    let flooded = false;
    const deadline = Date.now() + IMPORT_BUDGET_MS;

    for (const u of pending) {
      if (added >= room || Date.now() > deadline) break;
      u.attempts = (u.attempts || 0) + 1;
      try {
        const inputUser = new Api.InputUser({ userId: bigInt(u.id), accessHash: bigInt(u.accessHash) });
        await client.invoke(new Api.channels.InviteToChannel({ channel: target, users: [inputUser] }));
        u.status = 'added';
        u.at = new Date().toISOString();
        u.lastError = null;
        added++;
        console.log('import.add ok', JSON.stringify({ tenant: getTenant(), user: u.username || u.id }));
        await sleep(IMPORT_PACE_MS);
      } catch (err) {
        const raw = rpcMessage(err);
        const m = raw.toUpperCase();
        if (m.includes('ALREADY_PARTICIPANT')) {
          u.status = 'added';
          u.at = new Date().toISOString();
          u.lastError = null;
          console.log('import.add already', JSON.stringify({ tenant: getTenant(), user: u.username || u.id }));
        } else if (m.includes('USER_PRIVACY') || m.includes('NOT_MUTUAL') || m.includes('USER_CHANNELS_TOO_MUCH') || m.includes('USER_BOT') || m.includes('USER_KICKED')) {
          u.status = 'privacy';
          u.lastError = raw;
          privacy++;
          console.warn('import.add skip', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: raw }));
        } else if (m.includes('PEER_FLOOD') || m.includes('FLOOD_WAIT')) {
          flooded = true;
          u.lastError = floodMessage(err);
          console.error('import.add FLOOD', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: u.lastError }));
          break; // stop immediately to protect the account
        } else {
          u.status = 'failed';
          u.lastError = raw;
          failed++;
          console.error('import.add fail', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: raw }));
        }
      }
    }

    dlog.added += added;
    cfg.importLog = dlog;
    await setConfig(MTPROTO_KEY, cfg);
    pool.target = String(targetRaw).trim();
    await setConfig(IMPORT_POOL_KEY, pool);
    await logAudit('mtproto', `Import add → ${pool.target}: +${added} (privacy ${privacy}, failed ${failed}${flooded ? ', flood-stopped' : ''}).`);
    return { added, privacy, failed, flooded, dailyAdded: dlog.added, dailyMax: IMPORT_PER_DAY_MAX, counts: poolCounts(pool) };
  } finally {
    await safeDisconnect(client);
  }
}

// Add ONE specific pool member (by user id) to a target channel — used by the
// manual, click-each-row flow. Returns the outcome + the refreshed pool.
async function importAddOne(targetRaw, userIdRaw) {
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const userId = String(userIdRaw || '').trim();
  if (!userId) throw new ApiError(400, 'Missing member.');

  const pool = await readPool();
  const u = (pool.users || []).find((x) => String(x.id) === userId);
  if (!u) throw new ApiError(404, 'That member is not in the pool.');
  if (u.status === 'added') return { status: 'added', already: true, pool: maskPool(pool) };

  const today = new Date().toISOString().slice(0, 10);
  const dlog = cfg.importLog && cfg.importLog.date === today ? cfg.importLog : { date: today, added: 0 };
  if (dlog.added >= IMPORT_PER_DAY_MAX) {
    throw new ApiError(429, `Daily add limit reached (${IMPORT_PER_DAY_MAX}). Try again tomorrow.`);
  }

  // eslint-disable-next-line global-require
  const bigInt = require('big-integer');
  const { client, Api } = await connectClient(cfg, cfg.session);
  try {
    let target;
    try {
      target = await client.getEntity(normalizePeer(targetRaw));
    } catch (err) {
      throw mapRpcError(err, 'Could not resolve your target channel. Make sure this account is an admin there.');
    }

    u.attempts = (u.attempts || 0) + 1;
    let outcome;
    try {
      const inputUser = new Api.InputUser({ userId: bigInt(u.id), accessHash: bigInt(u.accessHash) });
      await client.invoke(new Api.channels.InviteToChannel({ channel: target, users: [inputUser] }));
      u.status = 'added';
      u.at = new Date().toISOString();
      u.lastError = null;
      dlog.added += 1;
      cfg.importLog = dlog;
      await setConfig(MTPROTO_KEY, cfg);
      outcome = { status: 'added' };
      console.log('import.addone ok', JSON.stringify({ tenant: getTenant(), user: u.username || u.id }));
    } catch (err) {
      const raw = rpcMessage(err);
      const m = raw.toUpperCase();
      if (m.includes('ALREADY_PARTICIPANT')) {
        u.status = 'added';
        u.at = new Date().toISOString();
        u.lastError = null;
        outcome = { status: 'added', already: true };
      } else if (m.includes('USER_PRIVACY') || m.includes('NOT_MUTUAL') || m.includes('USER_CHANNELS_TOO_MUCH') || m.includes('USER_BOT') || m.includes('USER_KICKED')) {
        u.status = 'privacy';
        u.lastError = raw;
        outcome = { status: 'privacy', error: raw };
        console.warn('import.addone skip', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: raw }));
      } else if (m.includes('PEER_FLOOD') || m.includes('FLOOD_WAIT')) {
        u.lastError = floodMessage(err); // leave status pending so it can be retried after the wait
        outcome = { status: 'flood', error: u.lastError };
        console.error('import.addone FLOOD', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: u.lastError }));
      } else {
        u.status = 'failed';
        u.lastError = raw;
        outcome = { status: 'failed', error: raw };
        console.error('import.addone fail', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: raw }));
      }
    }

    // Once a member is in the channel (freshly added OR already a participant),
    // drop them from the pool so they never show again in Step 2. Keep a running
    // tally so the stats bar can still report how many were added.
    if (outcome.status === 'added') {
      pool.users = (pool.users || []).filter((x) => String(x.id) !== userId);
      pool.addedTotal = (pool.addedTotal || 0) + 1;
      pool.addedIds = pool.addedIds || [];
      if (!pool.addedIds.includes(userId)) pool.addedIds.push(userId); // so re-fetch skips them
    }
    pool.target = String(targetRaw).trim();
    await setConfig(IMPORT_POOL_KEY, pool);
    await logAudit('mtproto', `Import add-one → ${pool.target}: ${u.username || u.id} = ${outcome.status}.`);
    return { ...outcome, dailyAdded: dlog.added, dailyMax: IMPORT_PER_DAY_MAX, pool: maskPool(pool) };
  } finally {
    await safeDisconnect(client);
  }
}

// Save the invite/DM message template (stored on the pool item).
async function importSaveMessage(text) {
  const pool = await readPool();
  pool.message = String(text || '').slice(0, 4000);
  await setConfig(IMPORT_POOL_KEY, pool);
  return maskPool(pool);
}

// Send the invite message as a DM to ONE pool member. Cold-DMing strangers is
// spammy too, so it shares the flood handling and has its own daily cap.
async function importSendOne(userIdRaw, messageOverride) {
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const userId = String(userIdRaw || '').trim();
  if (!userId) throw new ApiError(400, 'Missing member.');

  const pool = await readPool();
  const u = (pool.users || []).find((x) => String(x.id) === userId);
  if (!u) throw new ApiError(404, 'That member is not in the pool.');
  const text = (messageOverride && String(messageOverride).trim()) || pool.message || '';
  if (!text) throw new ApiError(400, 'Write the invite message first.');

  const today = new Date().toISOString().slice(0, 10);
  const mlog = cfg.msgLog && cfg.msgLog.date === today ? cfg.msgLog : { date: today, sent: 0 };
  if (mlog.sent >= IMPORT_MSG_PER_DAY_MAX) {
    throw new ApiError(429, `Daily message limit reached (${IMPORT_MSG_PER_DAY_MAX}). Try again tomorrow.`);
  }

  // eslint-disable-next-line global-require
  const bigInt = require('big-integer');
  const { client, Api } = await connectClient(cfg, cfg.session);
  try {
    const peer = new Api.InputPeerUser({ userId: bigInt(u.id), accessHash: bigInt(u.accessHash) });
    let outcome;
    try {
      await client.sendMessage(peer, { message: text });
      u.messagedAt = new Date().toISOString();
      u.messageError = null;
      mlog.sent += 1;
      cfg.msgLog = mlog;
      await setConfig(MTPROTO_KEY, cfg);
      outcome = { status: 'sent' };
      console.log('import.msg ok', JSON.stringify({ tenant: getTenant(), user: u.username || u.id }));
    } catch (err) {
      const raw = rpcMessage(err);
      const m = raw.toUpperCase();
      const isFlood = m.includes('PEER_FLOOD') || m.includes('FLOOD_WAIT');
      u.messageError = isFlood ? floodMessage(err) : raw;
      outcome = { status: isFlood ? 'flood' : 'failed', error: u.messageError };
      console.error('import.msg fail', JSON.stringify({ tenant: getTenant(), user: u.username || u.id, reason: u.messageError }));
    }
    await setConfig(IMPORT_POOL_KEY, pool);
    await logAudit('mtproto', `Import DM → ${u.username || u.id} = ${outcome.status}.`);
    return { ...outcome, dailySent: mlog.sent, dailyMax: IMPORT_MSG_PER_DAY_MAX, pool: maskPool(pool) };
  } finally {
    await safeDisconnect(client);
  }
}

// Remove pool members who are ALREADY in the target channel (so they don't show
// as addable). Reads the target's participants (this account must be admin).
async function importSyncTarget(targetRaw) {
  const cfg = await readCfg();
  if (!cfg.session) throw new ApiError(400, 'Log in with a Telegram account first.');
  const pool = await readPool();
  const { client } = await connectClient(cfg, cfg.session);
  try {
    let target;
    try {
      target = await client.getEntity(normalizePeer(targetRaw));
    } catch (err) {
      throw mapRpcError(err, 'Could not resolve your target channel. Make sure this account is an admin there.');
    }
    let members;
    try {
      members = await client.getParticipants(target, { limit: 2000 });
    } catch (err) {
      throw mapRpcError(err, 'Could not read the target channel members (this account must be an admin there).');
    }
    const inTarget = new Set((members || []).map((u) => String(u.id)));
    const before = (pool.users || []).length;
    pool.users = (pool.users || []).filter((u) => !inTarget.has(String(u.id)));
    const removed = before - pool.users.length;
    pool.target = String(targetRaw).trim();
    await setConfig(IMPORT_POOL_KEY, pool);
    console.log('import.sync', JSON.stringify({ tenant: getTenant(), target: pool.target, targetMembers: inTarget.size, removed, poolTotal: pool.users.length }));
    await logAudit('mtproto', `Synced pool with ${pool.target}: removed ${removed} already-member(s).`);
    return { removed, pool: maskPool(pool) };
  } finally {
    await safeDisconnect(client);
  }
}

// ── Daily import automation ───────────────────────────────────────────────────
// Once a day at a set IST time, add up to N (≤5, flood-safe) pending members to
// a target channel, remove them from the pool, then post a welcome message to
// that channel. Driven by the same 5-minute cron as listener automation.
function istNow() {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
function hhmmToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

async function getImportAuto() {
  const c = (await getConfig(IMPORTAUTO_KEY)) || {};
  // Backward-compat: an older single `time` becomes a one-entry `times` list.
  const times = Array.isArray(c.times) && c.times.length ? c.times : [c.time || '08:00'];
  return {
    enabled: !!c.enabled,
    times,
    count: Math.min(Math.max(c.count || IMPORT_AUTO_MAX, 1), IMPORT_AUTO_MAX),
    target: c.target || '',
    welcome: c.welcome || '',
    firedSlots: c.firedSlots || [], // "<date> <HH:MM>" slots already run (per-slot de-dup)
    lastResult: c.lastResult || null,
    history: c.history || [], // recent runs (newest last), capped
  };
}

async function saveImportAuto({ enabled, times, time, count, target, welcome }) {
  const cfg = await getImportAuto();
  if (typeof enabled === 'boolean') cfg.enabled = enabled;
  const rawTimes = times !== undefined ? times : (time !== undefined ? time : undefined);
  if (rawTimes !== undefined) {
    const arr = (Array.isArray(rawTimes) ? rawTimes : String(rawTimes).split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    for (const t of arr) {
      if (hhmmToMinutes(t) == null) throw new ApiError(400, `Invalid time "${t}". Use HH:MM (24-hour), e.g. 08:00.`);
    }
    // de-dupe + sort, cap to 4 slots/day
    cfg.times = Array.from(new Set(arr)).sort().slice(0, 4);
    if (!cfg.times.length) cfg.times = ['08:00'];
  }
  if (count !== undefined) cfg.count = Math.min(Math.max(parseInt(count, 10) || IMPORT_AUTO_MAX, 1), IMPORT_AUTO_MAX);
  if (target !== undefined) cfg.target = String(target || '').trim();
  if (welcome !== undefined) cfg.welcome = String(welcome || '').slice(0, 3500);
  if (cfg.enabled && !cfg.target) throw new ApiError(400, 'Select a target channel before enabling automation.');
  await setConfig(IMPORTAUTO_KEY, cfg);
  return cfg;
}

// Cron entry: run once/day at/after the scheduled IST time. Best-effort; never
// throws (the cron must survive one tenant's failure).
async function runImportAuto() {
  const auto = await getImportAuto();
  if (!auto.enabled || !auto.target) return { skipped: 'off' };
  const cfg = await readCfg();
  if (!cfg.session) return { skipped: 'no-session' };
  const ist = istNow();

  // Fire the earliest due, not-yet-run slot for today (one slot per tick).
  const fired = new Set(auto.firedSlots || []);
  let slot = null;
  for (const t of auto.times) {
    const min = hhmmToMinutes(t);
    if (min == null) continue;
    const s = `${ist.date} ${t}`;
    if (ist.minutes >= min && !fired.has(s)) { slot = s; break; }
  }
  if (!slot) return { skipped: 'not-due' };

  // Claim the slot up-front so an overlapping tick can't double-run it. Keep only
  // recent slots so the list can't grow forever.
  fired.add(slot);
  auto.firedSlots = Array.from(fired).slice(-12);
  await setConfig(IMPORTAUTO_KEY, auto);

  const pool = await readPool();
  const want = Math.min(Math.max(auto.count || IMPORT_AUTO_MAX, 1), IMPORT_AUTO_MAX);
  const pending = (pool.users || []).filter((u) => u.status === 'pending');
  if (!pending.length) {
    const res = { added: 0, note: 'no pending members' };
    const entry = { ...res, slot, at: new Date().toISOString() };
    auto.lastResult = entry;
    auto.history = [...(auto.history || []), entry].slice(-10);
    await setConfig(IMPORTAUTO_KEY, auto);
    await logAudit('mtproto', 'Import automation: no pending members to add.');
    return res;
  }

  // eslint-disable-next-line global-require
  const bigInt = require('big-integer');
  const { client, Api } = await connectClient(cfg, cfg.session);
  try {
    let target;
    try {
      target = await client.getEntity(normalizePeer(auto.target));
    } catch (err) {
      await logAudit('mtproto', `Import automation: could not resolve target ${auto.target} — ${rpcMessage(err)}`);
      return { error: 'bad-target' };
    }

    const addedIds = new Set((pool.addedIds || []).map(String));
    let added = 0;
    let privacy = 0;
    let failed = 0;
    let flooded = false;
    for (const u of pending) {
      if (added >= want) break;
      try {
        const inputUser = new Api.InputUser({ userId: bigInt(u.id), accessHash: bigInt(u.accessHash) });
        await client.invoke(new Api.channels.InviteToChannel({ channel: target, users: [inputUser] }));
        added++;
        addedIds.add(String(u.id));
        pool.users = pool.users.filter((x) => String(x.id) !== String(u.id));
        pool.addedTotal = (pool.addedTotal || 0) + 1;
        await sleep(IMPORT_PACE_MS);
      } catch (err) {
        const raw = rpcMessage(err);
        const m = raw.toUpperCase();
        if (m.includes('ALREADY_PARTICIPANT')) {
          addedIds.add(String(u.id));
          pool.users = pool.users.filter((x) => String(x.id) !== String(u.id));
          pool.addedTotal = (pool.addedTotal || 0) + 1;
        } else if (m.includes('USER_PRIVACY') || m.includes('NOT_MUTUAL') || m.includes('USER_CHANNELS_TOO_MUCH') || m.includes('USER_BOT') || m.includes('USER_KICKED')) {
          u.status = 'privacy'; u.lastError = raw; privacy++;
        } else if (m.includes('PEER_FLOOD') || m.includes('FLOOD_WAIT')) {
          flooded = true; u.lastError = floodMessage(err); break;
        } else {
          u.status = 'failed'; u.lastError = raw; failed++;
        }
      }
    }
    pool.addedIds = Array.from(addedIds);
    pool.target = auto.target;
    await setConfig(IMPORT_POOL_KEY, pool);

    // Post the welcome message to the same channel (via the user account).
    let welcomeSent = false;
    if (added > 0 && auto.welcome && auto.welcome.trim()) {
      try {
        await client.sendMessage(target, { message: auto.welcome });
        welcomeSent = true;
      } catch (err) {
        console.warn('import.auto welcome failed', rpcMessage(err));
      }
    }

    const res = { added, privacy, failed, flooded, welcomeSent };
    const entry = { ...res, slot, at: new Date().toISOString() };
    auto.lastResult = entry;
    auto.history = [...(auto.history || []), entry].slice(-10);
    await setConfig(IMPORTAUTO_KEY, auto);
    console.log('import.auto', JSON.stringify({ tenant: getTenant(), target: auto.target, slot, ...res }));
    await logAudit('mtproto', `Import automation → ${auto.target}: added ${added}${welcomeSent ? ' + welcome sent' : ''} (privacy ${privacy}, failed ${failed}${flooded ? ', flood-stopped' : ''}).`);
    return res;
  } finally {
    await safeDisconnect(client);
  }
}

// ── Error helpers ─────────────────────────────────────────────────────────────
function rpcMessage(err) {
  return String((err && (err.errorMessage || err.message)) || '');
}

// Build a rich, human-readable flood message. FLOOD_WAIT_x carries an exact
// seconds count; PEER_FLOOD does NOT (Telegram gives no duration for it).
function floodMessage(err) {
  const raw = rpcMessage(err);
  const code = err && err.code ? ` (code ${err.code})` : '';
  let secs = err && Number.isFinite(Number(err.seconds)) ? Number(err.seconds) : null;
  const mm = raw.match(/FLOOD_WAIT_(\d+)/i);
  if (secs == null && mm) secs = Number(mm[1]);
  if (secs != null) {
    const mins = Math.ceil(secs / 60);
    return `FLOOD_WAIT${code}: Telegram says wait ${secs}s (~${mins} min) before trying again. [raw: ${raw}]`;
  }
  if (/PEER_FLOOD/i.test(raw)) {
    return (
      `PEER_FLOOD${code}: Telegram has temporarily restricted this account from adding members. ` +
      `This error carries NO wait time from Telegram — there is no exact duration in the API. ` +
      `To check how long / when it lifts, message @SpamBot in Telegram from this account (it reports your ` +
      `limitation status and lets you appeal). Stop adding until then — retrying extends the restriction. [raw: ${raw}]`
    );
  }
  return raw;
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
  exportSession,
  saveApi,
  sendCode,
  signIn,
  logout,
  clearCredentials,
  listDialogs,
  fetchEnriched,
  fetchRaw,
  sendToBot,
  importFetch,
  importAdd,
  importAddOne,
  importSaveMessage,
  importSendOne,
  importSyncTarget,
  importStatus,
  importClear,
  getImportAuto,
  saveImportAuto,
  runImportAuto,
  getSources,
  addSource,
  removeSource,
  // exported for tests / reuse
  normalizePeer,
  extractLinks,
};
