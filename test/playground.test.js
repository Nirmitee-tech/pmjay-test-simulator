'use strict';
// Playground: every scenario runs end to end through engine.handle() and gives the outcome the catalogue promises;
// edits make the matching rule fire; the HIMS's own cases are never touched; the HTTP routes and the page tab work.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pg = require('../src/server/playground');
const engine = require('../src/engine');
const H = require('./server.helpers');
const { createApp } = require('../src/server/app');

const cat = pg.catalogue();

test('catalogue has the 18 engine scenarios and one per real refusal fixture', () => {
  const flows = cat.scenarios.filter(s => s.kind === 'flow').map(s => s.id).sort();
  assert.deepStrictEqual(flows, engine.scenarios().map(s => s.id).sort());
  const errDirs = fs.readdirSync(path.join(__dirname, '..', 'fixtures')).filter(d => d.startsWith('error-'));
  assert.strictEqual(cat.scenarios.filter(s => s.kind === 'error').length, errDirs.length);
  for (const s of cat.scenarios) { assert.ok(s.plain && s.calls.length, s.id); assert.ok(!/—/.test(s.plain + s.label), s.id); }
  assert.ok(cat.patients.some(p => p.id === 'SBXSTG269'));
});

for (const s of cat.scenarios) {
  test(`scenario ${s.id} runs end to end with the expected outcome`, () => {
    pg.reset();
    const r = pg.run({ scenario: s.id, patient: 'SBXSTG269' });
    assert.strictEqual(r.steps.length, s.steps.length);
    for (const st of r.steps) {
      assert.strictEqual(st.outcome, st.expect, `${s.id} step ${st.n} (${st.fixture})`);
      assert.ok(st.answers.length >= 1, 'an answer was built');
      assert.ok(st.checks.every(c => ['pass', 'fail', 'note'].includes(c.result)));
    }
  });
}

test('error scenarios marked real give the code 1518 gave to that request', () => {
  for (const s of cat.scenarios.filter(x => x.kind === 'error' && x.steps[0].real)) {
    pg.reset();
    assert.strictEqual(pg.run({ scenario: s.id }).steps[0].outcome, s.code, s.id);
  }
});

test('edits make the matching rule fire', () => {
  const cases = [['implant', 'remove-implant', 'PAYR-1111'], ['query', 'policy-100217', 'PAYR-1250'],
    ['implant', 'speciality-null', 'PAYR-1114'], ['implant', 'quantity-0', 'PAYR-1045'], ['dama', 'discharge-before-admission', 'PAYR-1357'],
    ['dama', 'bad-attachment', 'PAYR-1008'], ['dama', 'total-600000', 'PAYR-1323']];
  for (const [sc, edit, code] of cases) {
    pg.reset();
    const st = pg.run({ scenario: sc, edit: { id: edit } }).steps.find(x => x.changes.length && x.outcome === code);
    assert.ok(st, `${sc} + ${edit} gives ${code}`);
    assert.ok(st.checks.some(c => c.code === code && c.result === 'fail'));
    assert.strictEqual(st.real, false, 'an edited request is marked predicted');
  }
  pg.reset();
  const f = pg.run({ scenario: 'implant', edit: { id: 'field', path: 'item.0.quantity.value', value: '0' } });
  assert.strictEqual(f.steps[0].outcome, 'PAYR-1045');
  assert.throws(() => pg.run({ scenario: 'lama', edit: { id: 'remove-implant' } }), /no implant line/);
});

test('patient and package swaps reach the request', () => {
  pg.reset();
  const r = pg.run({ scenario: 'approve', patient: 'PT00000001' });
  assert.ok(!JSON.stringify(r.steps[0].request).includes('SBXSTG269'));
  assert.strictEqual(r.state.cases[0].member, 'PT00000001');
  pg.reset();
  const p = pg.run({ scenario: 'implant', package: 'SN063D' });
  assert.ok(JSON.stringify(p.steps[0].request).includes('SN063D'));
});

test('preview changes nothing; run keeps state until reset; the HIMS cases untouched', () => {
  engine.reset();
  engine.state.seedCase({ number: 'PMJAY/HP/S/2024/R2/LIVE0001', member: 'SBXSTG269', admission: 'A/9002/26', status: 'approved' });
  pg.reset();
  pg.preview({ scenario: 'pending' });
  assert.strictEqual(pg.current().cases.length, 0);
  pg.run({ scenario: 'pending' });
  assert.strictEqual(pg.current().cases[0].waiting, 'Pre-auth');
  // a second, different stay for the same member now meets the open pre-auth
  assert.strictEqual(pg.run({ scenario: 'implant' }).steps[0].outcome, 'PAYR-1238');
  assert.deepStrictEqual(engine.cases().map(c => c.number), ['PMJAY/HP/S/2024/R2/LIVE0001']);
  assert.strictEqual(pg.reset().cases.length, 0);
});

test('HTTP: catalogue, preview, run, reset, and the page has the Playground tab', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-pg-'));
  const app = createApp({ port: 0, dataDir, callbackBase: 'http://127.0.0.1:9', himsCertPath: '/nonexistent', policiesPath: '/nonexistent', logToFile: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    const c = await H.request(port, 'GET', '/playground/catalogue');
    assert.strictEqual(c.status, 200);
    assert.ok(c.json.scenarios.length >= 18);
    await H.request(port, 'POST', '/playground/reset', {});
    const pv = await H.request(port, 'POST', '/playground/preview', { scenario: 'reject', patient: 'SBXSTG269' });
    assert.deepStrictEqual(pv.json.steps.map(s => s.outcome), ['Rejected', 'Approved']);
    assert.strictEqual(pv.json.steps[0].real, true);
    const run = await H.request(port, 'POST', '/playground/run', { scenario: 'implant', edit: { id: 'remove-implant' } });
    assert.strictEqual(run.json.steps[0].outcome, 'PAYR-1111');
    const bad = await H.request(port, 'POST', '/playground/run', { scenario: 'nope' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error.message, /Pick a scenario/);
    const st = await H.request(port, 'POST', '/playground/reset', {});
    assert.strictEqual(st.json.cases.length, 0);
    const page = await H.request(port, 'GET', '/');
    assert.match(page.text, /id="tabPg"[^>]*>Playground</);
    for (const id of ['pgScen', 'pgPat', 'pgPkg', 'pgEdit', 'pgSend', 'pgReset', 'pgOut']) assert.ok(page.text.includes(`id="${id}"`), id);
    assert.ok(!/—/.test(page.text), 'no em dashes on the page');
  } finally { await app.close(); }
});
