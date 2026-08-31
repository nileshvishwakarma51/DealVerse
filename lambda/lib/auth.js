'use strict';

// Multi-tenant auth. Login (name + password) is verified against the merchants
// registry; on success we issue an HMAC-signed token that carries the tenant id.
// A separate super-admin token (password SUPER_SECRET, default "pulsar") gates
// the /api/super/* routes.
const crypto = require('crypto');
const { getGlobal, setGlobal, setTenant } = require('./store');
const merchants = require('./merchants');

const SUPER_SECRET = process.env.SUPER_SECRET || 'pulsar';
const SECRET_KEY = 'authsecret';

let SIGNING_SECRET = null;
// Load (or generate once) the HMAC signing secret. Call once per invocation
// before any sync token check.
async function ensureSecret() {
  if (SIGNING_SECRET) return;
  const existing = await getGlobal(SECRET_KEY);
  if (existing && existing.secret) {
    SIGNING_SECRET = existing.secret;
  } else {
    SIGNING_SECRET = crypto.randomBytes(32).toString('hex');
    await setGlobal(SECRET_KEY, { secret: SIGNING_SECRET });
  }
}

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hmac(data) {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('hex');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !SIGNING_SECRET) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function bearer(event) {
  const h = event.headers || {};
  const auth = h.Authorization || h.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

// Sync merchant-token signature check (used inside routes; active-status is
// enforced once at the top of the handler by authMerchant).
function checkBearer(event) {
  const p = verifyToken(bearer(event));
  return !!(p && p.t);
}

// Full merchant auth: verify token, confirm merchant active, set the tenant.
// Returns { ok, tenant } | { ok:false, inactive:true } | { ok:false }.
async function authMerchant(event) {
  const p = verifyToken(bearer(event));
  if (!p || !p.t) return { ok: false };
  const m = await merchants.findById(p.t);
  if (!m) return { ok: false };
  if (m.active === false) return { ok: false, inactive: true };
  setTenant(m.id);
  return { ok: true, tenant: m.id };
}

function authSuper(event) {
  const p = verifyToken(bearer(event));
  return !!(p && p.s === true);
}
function verifySuper(password) {
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(SUPER_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  ensureSecret,
  signToken,
  verifyToken,
  checkBearer,
  authMerchant,
  authSuper,
  verifySuper,
};
