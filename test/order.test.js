// A request's answers leave in order: a desk decision made while the queued answer waits goes after it (25 Nov 2026).
const test = require('node:test');
const assert = require('node:assert');
const { orderedDelay } = require('../src/server/app');

test('orderedDelay: a decision due before the queued answer waits until just after it', () => {
  assert.strictEqual(orderedDelay(1000, 0, 1000 + 9606), 9706);
});
test('orderedDelay: nothing earlier is due, the delay stands', () => {
  assert.strictEqual(orderedDelay(1000, 500, undefined), 500);
  assert.strictEqual(orderedDelay(1000, 5000, 3000), 5000);
});
test('orderedDelay: a negative or missing delay is zero', () => {
  assert.strictEqual(orderedDelay(1000, -5, null), 0);
  assert.strictEqual(orderedDelay(1000, undefined, null), 0);
});
