'use strict';
// Callback timing (src/server/timing.js): every mode, precedence, presets, and over HTTP that the ack is immediate
// while callbacks wait, with a queued response.partial before the decision.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const H = require('./server.helpers');
const timing = require('../src/server/timing');
const jwe = require('../src/server/jwe');
const { createApp } = require('../src/server/app');

const two = [{ action: 'preauth/on_submit', hcxStatus: 'response.partial' }, { action: 'preauth/on_submit', hcxStatus: 'response.complete' }];

test('default is random 3 to 10 s', () => {
  const t = timing.create(null, () => 0.5);
  const g = t.get().global;
  assert.deepStrictEqual([g.mode, g.min, g.max], ['random', 3000, 10000]);
  assert.strictEqual(t.plan([two[0]]).callbacks[0].delayMs, 6500);
});

test('fixed: every callback waits ms after the one before', () => {
  const t = timing.create({ mode: 'fixed', ms: 5000 });
  const p = t.plan(two).callbacks;
  assert.deepStrictEqual(p.map(c => c.delayMs), [5000, 10000]);
  assert.strictEqual(p[0].hcxStatus, 'response.partial');
});

test('random: draws within min..max', () => {
  let i = 0; const r = [0, 1];
  const t = timing.create({ mode: 'random', min: 3000, max: 10000 }, () => r[i++ % 2]);
  assert.deepStrictEqual(t.plan(two).callbacks.map(c => c.timing.gapMs), [3000, 10000]);
});

test('sequence: one value per callback, cycling across requests', () => {
  const t = timing.create({ mode: 'sequence', sequence: [3000, 5000, 10000] });
  assert.deepStrictEqual(t.plan(two).callbacks.map(c => c.delayMs), [3000, 8000]);
  assert.deepStrictEqual(t.plan(two).callbacks.map(c => c.delayMs), [10000, 13000]);
});

test('precedence: X-Mock-Delay header > scenario override > global', () => {
  const t = timing.create({ mode: 'fixed', ms: 100 });
  assert.ok(t.set({ scenario: 'reject', mode: 'fixed', ms: 200 }).ok);
  assert.strictEqual(t.plan([two[0]], { scenario: 'reject' }).callbacks[0].delayMs, 200);
  assert.strictEqual(t.plan([two[0]], { scenario: 'other' }).callbacks[0].delayMs, 100);
  assert.strictEqual(t.plan([two[0]], { scenario: 'reject', headerValue: '50' }).callbacks[0].delayMs, 50);
  const ranged = t.plan([two[0]], { headerValue: '1000-1000' }).callbacks[0];
  assert.strictEqual(ranged.delayMs, 1000); assert.strictEqual(ranged.timing.from, 'header');
  t.set({ scenario: 'reject', clear: true });
  assert.strictEqual(t.plan([two[0]], { scenario: 'reject' }).callbacks[0].delayMs, 100);
});

test('set: bad input refused; presets measured from sandbox traffic load by name; reset restores the default', () => {
  const t = timing.create({ mode: 'fixed', ms: 1 });
  assert.strictEqual(t.set({ mode: 'sequence', sequence: [] }).ok, false);
  assert.strictEqual(t.set({ mode: 'nope' }).ok, false);
  assert.ok(t.set({ preset: 'preauth-partial' }).ok);
  assert.deepStrictEqual([t.get().global.min, t.get().global.max], [4680, 11560]);
  assert.ok(t.set({ reset: true }).ok);
  assert.strictEqual(t.get().global.max, 10000);
  for (const k of Object.keys(timing.PRESETS)) assert.ok(timing.PRESETS[k].min <= timing.PRESETS[k].max);
});

test('initialFrom: explicit timing, then PMJAY_TIMING, then a caller defaultDelayMs, else default', () => {
  assert.deepStrictEqual(timing.initialFrom({ timing: { mode: 'fixed', ms: 9 } }), { mode: 'fixed', ms: 9 });
  assert.deepStrictEqual(timing.initialFrom({ defaultDelayMs: 50 }), { mode: 'fixed', ms: 50 });
  const old = process.env.PMJAY_TIMING;
  process.env.PMJAY_TIMING = '{"mode":"fixed","ms":7}';
  try { assert.deepStrictEqual(timing.initialFrom({ defaultDelayMs: 50 }), { mode: 'fixed', ms: 7 }); }
  finally { if (old === undefined) delete process.env.PMJAY_TIMING; else process.env.PMJAY_TIMING = old; }
  assert.strictEqual(timing.initialFrom(undefined), null);
});

// ---------------------------------------------------------------- over HTTP
const hims = H.keyPair();
let app, port, lis, cert, token;
test.before(async () => {
  lis = H.listener();
  await new Promise(r => lis.server.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-timing-'));
  app = createApp({ port: 0, dataDir, callbackBase: 'http://127.0.0.1:' + lis.server.address().port, himsCertPem: hims.publicPem,
    himsCertPath: '/nonexistent', policiesPath: '/nonexistent', timing: { mode: 'fixed', ms: 300 }, logToFile: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  token = await H.session(port);
  cert = (await H.request(port, 'POST', '/participanthcxservice/fetch/certs', { participantid: '1518@hcx' })).json.encryption_cert;
});
test.after(async () => { await app.idle(); await app.close(); await new Promise(r => lis.server.close(r)); });

async function preauth(extra) {
  const t0 = Date.now();
  const r = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload: H.himsEncrypt(JSON.stringify(H.preauthBundle()), cert, H.himsHeader()) },
    Object.assign({ bearer_auth: 'Bearer ' + token }, extra || {}));
  return { r, t0, ackMs: Date.now() - t0 };
}

test('HTTP: ack immediately; response.partial first, the decision a gap later', async () => {
  lis.got.length = 0;
  const arrive = [];
  // scenario approve: auto would hold a pre-auth that needs review for the desk (server.fidelity.test.js)
  const { r, t0, ackMs } = await preauth({ 'x-mock-scenario': 'approve' });
  assert.strictEqual(r.status, 202);
  assert.ok(ackMs < 250, 'ack took ' + ackMs + ' ms');
  const got = await lis.waitFor(2, 5000);
  for (const g of got) arrive.push(Date.now() - t0);
  const st = got.map(g => jwe.decrypt(JSON.parse(g.body).payload, hims.privatePem).header['x-hcx-status']);
  if (st.length >= 2) { assert.strictEqual(st[0], 'response.partial'); assert.strictEqual(st[1], 'response.complete'); }
  const list = (await H.request(port, 'GET', '/mock/messages')).json;
  const d = (await H.request(port, 'GET', '/mock/messages/' + list[0].id)).json;
  assert.deepStrictEqual(d.timing.map(x => x.atMs), [300, 600]);
  assert.ok(got.length === 2);
  await app.idle();
});

test('HTTP: X-Mock-Delay overrides for one request; POST /mock/timing changes the global', async () => {
  lis.got.length = 0;
  const { t0 } = await preauth({ 'x-mock-delay': '50', 'x-mock-scenario': 'approve' });
  await lis.waitFor(1, 2000);
  assert.ok(Date.now() - t0 < 290, 'header delay used');
  await app.idle();
  const s = await H.request(port, 'POST', '/mock/timing', { mode: 'sequence', sequence: [40, 80] });
  assert.strictEqual(s.status, 200);
  const bad = await H.request(port, 'POST', '/mock/timing', { mode: 'random', min: 'x' });
  assert.strictEqual(bad.status, 200, 'random with junk numbers normalises to 0..0');
  assert.strictEqual((await H.request(port, 'POST', '/mock/timing', { mode: 'nope' })).status, 400);
  await H.request(port, 'POST', '/mock/timing', { mode: 'sequence', sequence: [40, 80] });
  await preauth({ 'x-mock-scenario': 'approve' });
  const list = (await H.request(port, 'GET', '/mock/messages')).json;
  const d = (await H.request(port, 'GET', '/mock/messages/' + list[0].id)).json;
  assert.deepStrictEqual(d.timing.map(x => x.gapMs), [40, 80]);
  assert.strictEqual((await H.request(port, 'GET', '/mock/timing')).json.global.mode, 'sequence');
  await app.idle();
});

test('HTTP: per-scenario override through /mock/timing', async () => {
  await H.request(port, 'POST', '/mock/timing', { scenario: 'reject', mode: 'fixed', ms: 25 });
  await preauth({ 'x-mock-scenario': 'reject' });
  const list = (await H.request(port, 'GET', '/mock/messages')).json;
  const d = (await H.request(port, 'GET', '/mock/messages/' + list[0].id)).json;
  assert.ok(d.timing.length >= 1 && d.timing[0].from === 'scenario' && d.timing[0].gapMs === 25);
  await H.request(port, 'POST', '/mock/timing', { reset: true });
  await app.idle();
});
