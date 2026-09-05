'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parsePrice, round2 } = require('../lambda/lib/price');

test('parsePrice handles common Amazon/Flipkart formats', () => {
  assert.equal(parsePrice('₹1,600.00'), 1600);
  assert.equal(parsePrice('$239.99'), 239.99);
  assert.equal(parsePrice('1,299'), 1299);
  assert.equal(parsePrice('  ₹ 2,49,900 '), 249900); // Indian digit grouping
  assert.equal(parsePrice('£19.5'), 19.5);
});

test('parsePrice rejects junk / missing prices', () => {
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice('Currently unavailable'), null);
  assert.equal(parsePrice('0'), null); // a zero price is not a real price
});

test('round2 rounds to 2 decimals and guards non-numbers', () => {
  assert.equal(round2(1599.994), 1599.99);
  assert.equal(round2(10.126), 10.13);
  assert.equal(round2(10.124), 10.12);
  assert.equal(round2('abc'), null);
  assert.equal(round2(undefined), null);
});
