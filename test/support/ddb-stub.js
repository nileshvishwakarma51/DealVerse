'use strict';

// In-memory stand-in for @aws-sdk/client-dynamodb (which is provided by the Lambda
// runtime and not installed locally). Installs a Module._load hook so any module
// that requires '@aws-sdk/client-dynamodb' gets this fake. Supports the single
// conditional-put shape our lock uses: "attribute_not_exists(id) OR #t < :now".
const Module = require('module');

const store = new Map(); // id -> DynamoDB attribute-value item

class PutItemCommand {
  constructor(input) {
    this.input = input;
    this.__type = 'Put';
  }
}
class GetItemCommand {
  constructor(input) {
    this.input = input;
    this.__type = 'Get';
  }
}
class DeleteItemCommand {
  constructor(input) {
    this.input = input;
    this.__type = 'Delete';
  }
}

function conditionPasses(input) {
  if (!input.ConditionExpression) return true;
  const id = input.Item.id.S;
  const existing = store.get(id);
  if (input.ConditionExpression.includes('attribute_not_exists(id)')) {
    if (!existing) return true;
    const now = Number(input.ExpressionAttributeValues[':now'].N);
    const ttl = existing.ttl ? Number(existing.ttl.N) : Infinity;
    return ttl < now; // live lock only if not yet expired
  }
  return true;
}

class DynamoDBClient {
  // eslint-disable-next-line class-methods-use-this
  async send(cmd) {
    const { input } = cmd;
    if (cmd.__type === 'Put') {
      if (!conditionPasses(input)) {
        const e = new Error('The conditional request failed');
        e.name = 'ConditionalCheckFailedException';
        throw e;
      }
      store.set(input.Item.id.S, input.Item);
      return {};
    }
    if (cmd.__type === 'Get') {
      return { Item: store.get(input.Key.id.S) };
    }
    if (cmd.__type === 'Delete') {
      store.delete(input.Key.id.S);
      return {};
    }
    return {};
  }
}

const fake = { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === '@aws-sdk/client-dynamodb') return fake;
  return originalLoad.call(this, request, ...rest);
};

module.exports = { store, fake };
