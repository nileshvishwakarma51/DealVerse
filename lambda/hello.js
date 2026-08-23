'use strict';

// @aws-sdk/client-dynamodb ships with the Node.js 20+ Lambda runtime, so the
// asset stays dependency-free (no node_modules to package).
const fs = require('fs');
const path = require('path');
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

// Static React build (copied into lambda/public at build time).
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

// Serve a file from the static build, falling back to index.html (SPA routing).
function serveStatic(reqPath) {
  let rel = decodeURIComponent(reqPath).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  // Resolve safely inside PUBLIC_DIR (block path traversal).
  let filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return { statusCode: 403, headers: { ...CORS }, body: 'Forbidden' };
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback — let the client-side app handle the route.
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    return { statusCode: 404, headers: { ...CORS }, body: 'Not found' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  return {
    statusCode: 200,
    headers: { 'Content-Type': contentType, ...CORS },
    body: fs.readFileSync(filePath, 'utf8'),
  };
}

// Single fixed record: every save overwrites this one item.
const CONFIG_ID = 'latest';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const reqPath = (event.path || '/').replace(/\/+$/, '') || '/';

  // CORS preflight
  if (method === 'OPTIONS') {
    return respond(200, {});
  }

  try {
    // Save (overwrite) the config.
    if (method === 'POST' && reqPath.endsWith('/config')) {
      let parsed;
      try {
        parsed = JSON.parse(event.body || '{}');
      } catch {
        return respond(400, { error: 'Request body must be valid JSON.' });
      }

      const curl = parsed.curl;
      if (typeof curl !== 'string' || curl.trim() === '') {
        return respond(400, { error: 'Field "curl" is required and must be a non-empty string.' });
      }

      const updatedAt = new Date().toISOString();
      await ddb.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: {
            id: { S: CONFIG_ID },
            curl: { S: curl },
            updatedAt: { S: updatedAt },
          },
        })
      );

      return respond(200, { message: 'Config saved.', config: { id: CONFIG_ID, curl, updatedAt } });
    }

    // Read the saved config.
    if (method === 'GET' && reqPath.endsWith('/config')) {
      const res = await ddb.send(
        new GetItemCommand({
          TableName: TABLE_NAME,
          Key: { id: { S: CONFIG_ID } },
        })
      );

      if (!res.Item) {
        return respond(200, { config: null });
      }

      return respond(200, {
        config: {
          id: res.Item.id.S,
          curl: res.Item.curl ? res.Item.curl.S : '',
          updatedAt: res.Item.updatedAt ? res.Item.updatedAt.S : null,
        },
      });
    }

    // Explicit hello / health check.
    if (method === 'GET' && reqPath.endsWith('/hello')) {
      return respond(200, { message: 'Hello World from dealverse-lambda!' });
    }

    // Everything else: serve the React app if it's been built into the asset,
    // otherwise fall back to the hello response (infra-only deploys).
    if (method === 'GET') {
      if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
        return serveStatic(reqPath);
      }
      return respond(200, { message: 'Hello World from dealverse-lambda! (frontend not built yet)' });
    }

    return respond(404, { error: 'Not found' });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};
