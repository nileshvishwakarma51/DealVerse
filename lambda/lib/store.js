'use strict';

// DynamoDB-backed key/value config store. @aws-sdk/client-dynamodb ships with
// the Node.js 20+ Lambda runtime, so no packaged dependencies are needed.
//
// MULTI-TENANT: every config item is scoped to the "current tenant" (merchant),
// set once per request via setTenant(). Keys map through tenantKey(): the DEFAULT
// tenant keeps the original bare keys (so the pre-existing single-tenant data is
// untouched); other tenants get `t#<tid>#<key>`. Lambda handles one event per
// instance, so a module-level currentTenant is safe (concurrent invocations are
// separate processes; the cron sets the tenant sequentially per tenant).
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const DEFAULT_TENANT = 'default';

let currentTenant = DEFAULT_TENANT;
function setTenant(tid) {
  currentTenant = tid || DEFAULT_TENANT;
}
function getTenant() {
  return currentTenant;
}
// DEFAULT tenant → bare key (preserves existing data). Others → namespaced.
function tenantKey(id) {
  return currentTenant === DEFAULT_TENANT ? id : `t#${currentTenant}#${id}`;
}

// ── Tenant-scoped config (keyed through the current tenant) ─────────────────
async function getConfig(id) {
  return getRaw(tenantKey(id));
}
async function setConfig(id, value) {
  return setRaw(tenantKey(id), value);
}
async function deleteConfig(id) {
  return deleteRaw(tenantKey(id));
}

// ── Global (non-tenant) items: merchants registry, signing secret ───────────
async function getGlobal(id) {
  return getRaw(id);
}
async function setGlobal(id, value) {
  return setRaw(id, value);
}

// ── Raw item access (exact id, no tenant mapping) ───────────────────────────
async function getRaw(id) {
  const res = await ddb.send(
    new GetItemCommand({ TableName: TABLE_NAME, Key: { id: { S: id } } })
  );
  if (!res.Item || !res.Item.value) return null;
  try {
    return JSON.parse(res.Item.value.S);
  } catch {
    return null;
  }
}
async function setRaw(id, value) {
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        id: { S: id },
        value: { S: JSON.stringify(value) },
        updatedAt: { S: new Date().toISOString() },
      },
    })
  );
}
async function deleteRaw(id) {
  await ddb.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { id: { S: id } } }));
}

module.exports = {
  DEFAULT_TENANT,
  setTenant,
  getTenant,
  getConfig,
  setConfig,
  deleteConfig,
  getGlobal,
  setGlobal,
  deleteRaw,
};
