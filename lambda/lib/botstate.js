'use strict';

// Per-chat bot conversation state (Lambda is stateless). Stored as its own
// DynamoDB item with a TTL so an abandoned flow auto-expires. Tenant-scoped so
// the same Telegram user id can't collide across different merchants' bots.
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { getTenant } = require('./store');

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const TTL_SECONDS = 10 * 60; // 10 minutes

function stateId(chatId) {
  return `botstate#${getTenant()}#${chatId}`;
}

async function setState(chatId, state, data) {
  const now = Date.now();
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        id: { S: stateId(chatId) },
        value: { S: JSON.stringify({ state, data: data || null, at: new Date(now).toISOString() }) },
        ttl: { N: String(Math.floor(now / 1000) + TTL_SECONDS) },
      },
    })
  );
}

async function getState(chatId) {
  try {
    const res = await ddb.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { id: { S: stateId(chatId) } } }));
    if (!res.Item || !res.Item.value) return null;
    const parsed = JSON.parse(res.Item.value.S);
    // Guard against DynamoDB TTL lag (it can lag minutes past expiry).
    if (res.Item.ttl && Number(res.Item.ttl.N) * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearState(chatId) {
  try {
    await ddb.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { id: { S: stateId(chatId) } } }));
  } catch {
    /* best-effort */
  }
}

module.exports = {
  setState,
  getState,
  clearState,
  // Conversation steps for the price-tracker flow.
  WAITING_FOR_TRACKER_URL: 'WAITING_FOR_TRACKER_URL', // expecting a product link
  WAITING_FOR_MODE: 'WAITING_FOR_MODE', // link resolved; showing the two mode buttons
  WAITING_FOR_THRESHOLD: 'WAITING_FOR_THRESHOLD', // expecting a numeric target price
};
