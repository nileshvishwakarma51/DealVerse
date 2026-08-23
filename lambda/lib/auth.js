'use strict';

// Admin auth mirrored from the reference project: the bearer token is simply
// base64(secret). Secret is hardcoded to "abc" (overridable via env).
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'abc';

function expectedToken() {
  return Buffer.from(ADMIN_SECRET, 'utf8').toString('base64');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Login accepts either the raw secret or its base64 form.
function isValidSecret(secret) {
  if (typeof secret !== 'string' || secret === '') return false;
  return safeEqual(secret, ADMIN_SECRET) || safeEqual(secret, expectedToken());
}

// Validate the Authorization: Bearer <token> header on protected routes.
function checkBearer(event) {
  const headers = event.headers || {};
  const auth = headers.Authorization || headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token !== '' && safeEqual(token, expectedToken());
}

module.exports = { expectedToken, isValidSecret, checkBearer };
