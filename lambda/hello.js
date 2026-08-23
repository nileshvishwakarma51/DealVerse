'use strict';

const fs = require('fs');
const path = require('path');
const { ApiError } = require('./lib/errors');
const { getConfig, setConfig } = require('./lib/store');
const { isValidSecret, expectedToken, checkBearer } = require('./lib/auth');
const { parseCurl, validateParsedCurl } = require('./lib/curl');
const {
  generateAmazonLink,
  SITESTRIPE_KEY,
  AMAZON_KEY,
  DEFAULT_AMAZON,
} = require('./lib/affiliate');

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
};

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

    // ── Public: affiliate link generation ─────────────────────────────────
    if (method === 'POST' && reqPath.endsWith('/api/affiliate/generate-link')) {
      const { url } = parseBody(event);
      if (typeof url !== 'string' || url.trim() === '') {
        return respond(400, { success: false, error: 'Paste an amazon.in product link.' });
      }
      const result = await generateAmazonLink(url.trim());
      return respond(200, result);
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
