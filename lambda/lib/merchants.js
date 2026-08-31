'use strict';

// Merchant (tenant) registry — a single global item `merchants` holding the list.
// Passwords are salted-scrypt hashes (no dependency; crypto is built in).
// The existing single-tenant config is seeded as merchant "poras" mapped to the
// DEFAULT tenant, so its data (bare keys) keeps working with no migration.
const crypto = require('crypto');
const { ApiError } = require('./errors');
const { getGlobal, setGlobal, DEFAULT_TENANT } = require('./store');

const MERCHANTS_KEY = 'merchants';

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 32).toString('hex');
  return { salt: s, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
    const a = Buffer.from(h);
    const b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Read the registry, seeding the default merchant (poras/1234) once.
async function getMerchants() {
  let cfg = await getGlobal(MERCHANTS_KEY);
  if (!cfg || !Array.isArray(cfg.items) || cfg.items.length === 0) {
    const { salt, hash } = hashPassword(process.env.ADMIN_SECRET || '1234');
    cfg = {
      items: [
        {
          id: DEFAULT_TENANT,
          name: 'poras',
          active: true,
          salt,
          hash,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await setGlobal(MERCHANTS_KEY, cfg);
  }
  return cfg.items;
}

// Public view — never leak salt/hash.
function mask(m) {
  return { id: m.id, name: m.name, active: m.active !== false, createdAt: m.createdAt || null };
}
async function listMerchants() {
  return (await getMerchants()).map(mask);
}

async function findById(id) {
  return (await getMerchants()).find((m) => m.id === id) || null;
}

// Returns { id, active } on success, or null.
async function verifyLogin(name, password) {
  const items = await getMerchants();
  const m = items.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!m) return null;
  if (!verifyPassword(password, m.salt, m.hash)) return null;
  return { id: m.id, active: m.active !== false };
}

async function addMerchant(name, password) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9 _-]{2,40}$/.test(clean)) {
    throw new ApiError(400, 'Name must be 2–40 chars (letters, numbers, space, _ or -).');
  }
  if (String(password || '').length < 4) throw new ApiError(400, 'Password must be at least 4 characters.');
  const items = await getMerchants();
  if (items.some((m) => m.name.toLowerCase() === clean.toLowerCase())) {
    throw new ApiError(400, 'A merchant with that name already exists.');
  }
  const { salt, hash } = hashPassword(password);
  const id = `m_${crypto.randomBytes(5).toString('hex')}`;
  items.push({ id, name: clean, active: true, salt, hash, createdAt: new Date().toISOString() });
  await setGlobal(MERCHANTS_KEY, { items });
  return mask(items[items.length - 1]);
}

async function setActive(id, active) {
  const items = await getMerchants();
  const m = items.find((x) => x.id === id);
  if (!m) throw new ApiError(404, 'Merchant not found.');
  m.active = !!active;
  await setGlobal(MERCHANTS_KEY, { items });
  return mask(m);
}

async function removeMerchant(id) {
  const items = (await getMerchants()).filter((m) => m.id !== id);
  await setGlobal(MERCHANTS_KEY, { items });
  return items.map(mask);
}

module.exports = {
  MERCHANTS_KEY,
  getMerchants,
  listMerchants,
  findById,
  verifyLogin,
  addMerchant,
  setActive,
  removeMerchant,
};
