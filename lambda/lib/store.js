'use strict';

// DynamoDB-backed key/value config store. @aws-sdk/client-dynamodb ships with
// the Node.js 20+ Lambda runtime, so no packaged dependencies are needed.
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

// Each config lives in one item keyed by `id`; saving overwrites it.
async function getConfig(id) {
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

async function setConfig(id, value) {
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

module.exports = { getConfig, setConfig };
