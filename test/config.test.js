'use strict';
// The HIMS under test is configuration: fake defaults, env overrides, and no default path into any HIMS's files.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const config = require('../src/server/config');

const ROOT = path.join(__dirname, '..');
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PMJAY_')));

function loadWith(env) {
  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./src/server/config").load()))'],
    { cwd: ROOT, env: Object.assign({}, CLEAN, env) });
  return JSON.parse(out);
}

test('unit: provider defaults are clearly fake, callbacks go to localhost:8081, no HIMS cert or policy file by default', () => {
  const c = loadWith({});
  assert.strictEqual(c.providerCode, '1000000001@hcx');
  assert.strictEqual(c.providerRegistryId, 'IN0000000000');
  assert.strictEqual(c.providerId, '10001');
  assert.strictEqual(c.callbackBase, 'http://localhost:8081');
  assert.strictEqual(c.himsCertPath, '');
  assert.strictEqual(c.policiesPath, '');
  assert.strictEqual(c.payerCode, '1518@hcx');
  assert.strictEqual(c.dummyPayerCode, '1000003538@hcx');
});

test('unit: provider settings come from the environment', () => {
  const c = loadWith({ PMJAY_PROVIDER_PARTICIPANT_CODE: '1000000042@hcx', PMJAY_PROVIDER_REGISTRY_ID: 'IN9999999999',
    PMJAY_PROVIDER_ID: '77777', PMJAY_HIMS_CERT: '/tmp/hims.crt', PMJAY_CALLBACK_BASE: 'http://hims.test:9000' });
  assert.strictEqual(c.providerCode, '1000000042@hcx');
  assert.strictEqual(c.providerRegistryId, 'IN9999999999');
  assert.strictEqual(c.providerId, '77777');
  assert.strictEqual(c.himsCertPath, '/tmp/hims.crt');
  assert.strictEqual(c.callbackBase, 'http://hims.test:9000');
});

test('unit: an override passed to load() wins over the environment', () => {
  assert.strictEqual(config.load({ providerId: '5' }).providerId, '5');
});

test('integration: the answer bundles name the configured provider ids', () => {
  const script = `
    const r = require('./src/responses');
    const req = JSON.parse(require('fs').readFileSync('fixtures/happy-coverage/request.json', 'utf8'));
    const pre = JSON.parse(require('fs').readFileSync('fixtures/happy-preauth/request.json', 'utf8'));
    process.stdout.write(JSON.stringify(r.build('coverage', { bundle: req })) + '\\n' + JSON.stringify(r.build('preauth.approved', { bundle: pre })));`;
  const [cov, pre] = execFileSync(process.execPath, ['-e', script], { cwd: ROOT,
    env: Object.assign({}, CLEAN, { PMJAY_PROVIDER_REGISTRY_ID: 'IN9999999999', PMJAY_PROVIDER_ID: '77777' }) }).toString().split('\n');
  assert.match(cov, /provider\/IN9999999999/);
  assert.match(pre, /provider\/77777/);
});
