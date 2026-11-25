'use strict';
// The rules run on the real request bundles the HIMS sent to 1518 (fixtures/, Agent C, scrubbed copies of sandbox messages
// payloads). Each refused fixture must get the code 1518 gave; each accepted one must pass.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const engine = require('../src/engine');

const DIR = path.join(__dirname, '..', 'fixtures');
const load = (d, f) => JSON.parse(fs.readFileSync(path.join(DIR, d, f), 'utf8'));
const has = d => fs.existsSync(path.join(DIR, d, 'request.json')) && fs.existsSync(path.join(DIR, d, 'meta.json'));
const dirs = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(has) : [];
const action = m => m.request.endpoint.replace(/^\/?v1\//, '');
const firstRefusal = fs2 => (fs2.find(f => f.refuse) || {}).code || null;
function fresh() { engine.reset(); engine.setScenario(null); engine.setOptions({ queuedMs: 0, decisionMs: 0, paymentMs: 0 }); }

// Refusals the rules cannot reproduce from the bundle alone, and why. These are stated gaps, not passes.
const KNOWN_GAPS = {
  'HBP016': 'Private policy 0000/00-00-0000000-01; the mock answers HBP0006. What makes 1518 pick HBP016 over HBP0006 is not known.',
  'HBP039': 'Same private policy; the mock answers HBP0006. Not separable from the data.',
  'PAYR-1123': 'Sent to every team during an NHA-side window on 20 Nov; the bundle was fine.',
  'ERR-PYR-SR-002': 'Search is not modelled.',
};
const STATEFUL = ['PAYR-1238', 'PAYR-1372'];

for (const d of dirs.filter(x => x.startsWith('error-'))) {
  const meta = load(d, 'meta.json');
  const code = meta.response.errorCode;
  if (KNOWN_GAPS[code] || STATEFUL.includes(code) || /enhancement-is-not-applicable/.test(d)) continue;
  test(`real refused bundle ${d} gets ${code}`, () => {
    fresh();
    assert.strictEqual(firstRefusal(engine.validate(action(meta), load(d, 'request.json'), { kind: 'new' })), code);
  });
}

for (const d of dirs.filter(x => !x.startsWith('error-') && x !== 'happy-claim')) {
  const meta = load(d, 'meta.json');
  if (meta.response.errorCode && meta.response.errorCode !== '100') continue;
  test(`real accepted bundle ${d} passes every stateless rule`, () => {
    fresh();
    assert.strictEqual(firstRefusal(engine.validate(action(meta), load(d, 'request.json'), { kind: 'new' })), null);
  });
}

test('real happy case A/9022/26: cover, pre-auth, claim go through handle() and the claim is not refused', { skip: !dirs.includes('happy-claim') }, () => {
  fresh();
  const req = (a, b) => ({ action: a, apiCallId: 'x', correlationId: 'y', sender: 'p', recipient: '1518@hcx', headers: {}, bundle: b });
  assert.ok(!engine.handle(req('coverageeligibility/check', load('happy-coverage', 'request.json'))).callbacks[0].error);
  const p = engine.handle(req('preauth/submit', load('happy-preauth', 'request.json')));
  assert.ok(!p.callbacks[0].error);
  // 1518's own case number for this admission, so the claim's preAuthRef finds it
  const c = engine.state.findCase(p.caseNumber);
  delete engine.state.get().cases[c.number];
  c.number = 'PMJAY/HP/S/2024/R2/2026112090000014';
  engine.state.get().cases[c.number] = c;
  assert.strictEqual(c.approved, 1500);   // 1,000 package + 500 room level, as 1518 answered
  const r = engine.handle(req('claim/submit', load('happy-claim', 'request.json')));
  assert.ok(!r.callbacks[0].error, JSON.stringify(r.callbacks[0].error));
});

test('real PAYR-1238 bundle refused while the member holds another open pre-auth', () => {
  fresh();
  const d = dirs.find(x => x.startsWith('error-payr-1238'));
  engine.state.seedCase({ number: 'PMJAY/HP/S/2024/R2/2026111890000009', member: 'SBXSTG269', admission: 'A/9016/26', status: 'approved' });
  assert.strictEqual(firstRefusal(engine.validate('preauth/submit', load(d, 'request.json'), { kind: 'new' })), 'PAYR-1238');
});

test('real PAYR-1245 top-up refused on an approved SB017A case', () => {
  fresh();
  const d = dirs.find(x => /enhancement-is-not-applicable/.test(x));
  const c = engine.state.seedCase({ number: 'PMJAY/HP/S/2024/R2/2026110990000001', member: 'SBXSTG269', admission: 'A/9007/26', packages: [{ code: 'SB017A', eligible: 17000 }, { code: 'IMP0129', eligible: 3000 }] });
  const r = engine.handle({ action: 'preauth/submit', headers: {}, bundle: load(d, 'request.json') });
  assert.strictEqual(r.callbacks[0].error.code, 'PAYR-1245');
  assert.strictEqual(c.status, 'approved');
});

test('real PAYR-1372 claim refused while the top-up waits', () => {
  fresh();
  const d = dirs.find(x => x.startsWith('error-payr-1372'));
  engine.state.seedCase({ number: 'PMJAY/HP/S/2024/R2/2026111390000002', member: 'SBXSTG269', admission: 'A/9008/26',
    packages: [{ code: 'SG059A', eligible: 12000 }], pendingEvent: { action: 'preauth/submit', correlationId: 'c19370c6-1127-4bab-90e6-3a087c0c4722', kind: 'enhancement' } });
  const r = engine.handle({ action: 'claim/submit', headers: {}, bundle: load(d, 'request.json') });
  assert.strictEqual(r.callbacks[0].error.code, 'PAYR-1372');
  assert.match(r.callbacks[0].error.message, /c19370c6-1127-4bab-90e6-3a087c0c4722 for case number A\/9008\/26/);
});

test('known gaps are stated, not hidden', () => {
  for (const [code, why] of Object.entries(KNOWN_GAPS)) assert.ok(why.length > 10, code);
});
