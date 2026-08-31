'use strict';

// Per-tenant audit trail in DynamoDB. Each entry is its own item, id-prefixed by
// the tenant, with a `ttl` so DynamoDB auto-deletes it after 2 days. Best-effort.
const crypto = require('crypto');
const {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { getTenant } = require('./store');

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const PREFIX = 'AUDIT#';
const TTL_SECONDS = 2 * 24 * 60 * 60; // 2 days

function tenantPrefix(tid) {
  return `${PREFIX}${tid}#`;
}

async function logAudit(type, message) {
  try {
    const now = Date.now();
    const id = `${tenantPrefix(getTenant())}${now}#${crypto.randomBytes(4).toString('hex')}`;
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          id: { S: id },
          type: { S: String(type || 'info') },
          message: { S: String(message || '').slice(0, 500) },
          at: { S: new Date(now).toISOString() },
          ttl: { N: String(Math.floor(now / 1000) + TTL_SECONDS) },
        },
      })
    );
  } catch {
    /* never let audit logging break the main flow */
  }
}

async function listAudit(limit = 60) {
  try {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(id, :p)',
        ExpressionAttributeValues: { ':p': { S: tenantPrefix(getTenant()) } },
      })
    );
    const items = (res.Items || []).map((it) => ({
      type: it.type ? it.type.S : 'info',
      message: it.message ? it.message.S : '',
      at: it.at ? it.at.S : null,
    }));
    items.sort((a, b) => (a.at < b.at ? 1 : -1)); // newest first
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

// Delete every audit row for a tenant (used when a merchant is deleted).
async function purgeTenant(tid) {
  try {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(id, :p)',
        ExpressionAttributeValues: { ':p': { S: tenantPrefix(tid) } },
        ProjectionExpression: 'id',
      })
    );
    for (const it of res.Items || []) {
      await ddb.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { id: it.id } }));
    }
  } catch {
    /* best-effort */
  }
}

module.exports = { logAudit, listAudit, purgeTenant };
