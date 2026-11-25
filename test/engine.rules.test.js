'use strict';
// One test per rule: a bundle that breaks exactly that rule gets that code, and the same bundle fixed passes it.
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/engine');
const H = require('./engine.helpers');

const codes = fs => fs.filter(f => f.refuse).map(f => f.code);
const rulesHit = fs => fs.filter(f => f.refuse).map(f => f.rule);
function fresh() { engine.reset(); engine.setScenario(null); engine.setOptions({ queuedMs: 0, decisionMs: 0, paymentMs: 0 }); }

test('PAYR-1402 plan request with a policy other than PMJAY/HP/S/G', () => {
  fresh();
  assert.deepStrictEqual(codes(engine.validate('insuranceplan/request', H.planTask('100217'))), ['PAYR-1402']);
  assert.deepStrictEqual(codes(engine.validate('insuranceplan/request', H.planTask('PMJAY/HP/S/G'))), []);
});

test('HBP0006 cover check without the PMJAY policy', () => {
  fresh();
  assert.deepStrictEqual(rulesHit(engine.validate('coverageeligibility/check', H.cover({ policies: ['A-PRIVATE-1'] }))), ['cover-no-pmjay-policy']);
  assert.deepStrictEqual(codes(engine.validate('coverageeligibility/check', H.cover())), []);
});

test('PAYR-1250 pre-auth naming policy 100217', () => {
  fresh();
  const f = engine.validate('preauth/submit', H.bundle({ policies: ['PMJAY/HP/S/G', '100217'] }));
  assert.deepStrictEqual(codes(f), ['PAYR-1250']);
  assert.match(f[0].message, /Requested policy 100217 is not listed/);
  assert.deepStrictEqual(codes(engine.validate('preauth/submit', H.bundle())), []);
});

test('PAYR-1123 member the payer does not hold', () => {
  fresh();
  assert.deepStrictEqual(codes(engine.validate('coverageeligibility/check', H.cover({ member: 'NOBODY1' }))), ['PAYR-1123']);
});

test('PAYR-1114 line with no speciality', () => {
  fresh();
  const f = engine.validate('coverageeligibility/check', H.cover({ items: [H.ceLine('SG059A', { speciality: null })] }));
  assert.deepStrictEqual(codes(f), ['PAYR-1114']);
  assert.match(f[0].message, /null for item SG059A/);
});

test('PAYR-1045 quantity other than a whole number', () => {
  fresh();
  assert.deepStrictEqual(codes(engine.validate('coverageeligibility/check', H.cover({ items: [H.ceLine('SG059A', { quantity: 1.5 })] }))), ['PAYR-1045']);
  assert.deepStrictEqual(codes(engine.validate('preauth/submit', H.bundle({ items: [H.line('SG059A', { quantity: null })] }))), ['PAYR-1045']);
  // 1.0 is only visible in the raw text
  const raw = '{"item":[{"quantity":{"value":1.0}}]}';
  assert.deepStrictEqual(codes(engine.validate('coverageeligibility/check', H.cover(), { raw })), ['PAYR-1045']);
});

test('PAYR-1111 implant package without its implant line', () => {
  fresh();
  const f = engine.validate('coverageeligibility/check', H.cover({ items: [H.ceLine('SB017A', { speciality: 'SB' })] }));
  assert.deepStrictEqual(rulesHit(f), ['implant-missing']);
  const ok = engine.validate('preauth/submit', H.bundle({ items: [H.line('SB017A', { speciality: 'SB', amount: 17000 }), H.line('IMP0129', { speciality: 'SB', amount: 3000 })] }));
  assert.deepStrictEqual(codes(ok), []);
});

test('PAYR-1111 room-level package without its room level', () => {
  fresh();
  const f = engine.validate('preauth/submit', H.bundle({ items: [H.line('SN063D', { speciality: 'SN', amount: 1800 })] }));
  assert.deepStrictEqual(rulesHit(f), ['stratification-missing']);
  assert.match(f[0].message, /Stratification is allowed for procedure SN063D/);
  assert.deepStrictEqual(codes(engine.validate('preauth/submit', H.bundle({ items: [H.line('SN063D', { speciality: 'SN', amount: 1800, strat: 'STRAT006a' })] }))), []);
});

test('PAYR-1238 second pre-auth while the member has one open', () => {
  fresh();
  const r1 = engine.handle(H.req('preauth/submit', H.bundle({ admissionId: 'A/9002/26' })));
  assert.strictEqual(r1.callbacks.at(-1).hcxStatus, 'response.complete');
  const r2 = engine.handle(H.req('preauth/submit', H.bundle({ admissionId: 'A/9003/26' })));
  assert.strictEqual(r2.callbacks[0].error.code, 'PAYR-1238');
  assert.match(r2.callbacks[0].error.message, new RegExp(r1.caseNumber.replace(/\//g, '\\/')));
});

test('PAYR-1372 claim while the pre-auth is still pending', () => {
  fresh();
  const r1 = engine.handle(H.req('preauth/submit', H.bundle(), { 'x-mock-scenario': 'pending' }));
  assert.strictEqual(r1.pending, true);
  const r2 = engine.handle(H.req('claim/submit', H.bundle({ use: 'claim', preAuthRef: r1.caseNumber, discharged: '2026-11-18T12:00:00+05:30' })));
  assert.strictEqual(r2.callbacks[0].error.code, 'PAYR-1372');
});

test('PAYR-1372 erroneous claim before the second payment notice', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  const claim = () => H.bundle({ use: 'claim', preAuthRef: p.caseNumber, discharged: '2026-11-18T12:00:00+05:30' });
  engine.handle(H.req('claim/submit', claim()));   // approved, no payment notices under auto
  const r = engine.handle(H.req('claim/submit', claim()));
  assert.strictEqual(r.callbacks[0].error.code, 'PAYR-1372');
  assert.deepStrictEqual(rulesHit(r.findings), ['erroneous-too-early']);
});

test('PAYR-1245 top-up on a package that takes none', () => {
  fresh();
  const items = () => [H.line('SB017A', { speciality: 'SB', amount: 17000 }), H.line('IMP0129', { speciality: 'SB', amount: 3000 })];
  const p = engine.handle(H.req('preauth/submit', H.bundle({ items: items() })));
  const r = engine.handle(H.req('preauth/submit', H.bundle({ preAuthRef: p.caseNumber, items: items().concat([H.line('SB017A', { speciality: 'SB', amount: 6000 })]) })));
  assert.strictEqual(r.callbacks[0].error.code, 'PAYR-1245');
  assert.match(r.callbacks[0].error.message, /Enhancement is not applicable/);
});

test('PAYR-1245 second conservative package on a case', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle({ items: [H.line('SN063D', { speciality: 'SN', amount: 1800, strat: 'STRAT006a' })] })));
  const r = engine.handle(H.req('preauth/submit', H.bundle({ preAuthRef: p.caseNumber, items: [H.line('SN063D', { speciality: 'SN', amount: 1800, strat: 'STRAT006a' }), H.line('MG062A', { speciality: 'MG', amount: 1800, strat: 'STRAT006a' })] })));
  assert.strictEqual(r.callbacks[0].error.code, 'PAYR-1245');
  assert.match(r.callbacks[0].error.message, /Only one conservative procedure/);
});

test('PAYR-1263 newborn with a document list on the package line', () => {
  fresh();
  const bad = H.bundle({ newborn: true, items: [H.line('SG059A', { informationSequence: [1, 2, 3] })] });
  assert.deepStrictEqual(codes(engine.validate('preauth/submit', bad)), ['PAYR-1263']);
  assert.deepStrictEqual(codes(engine.validate('preauth/submit', H.bundle({ newborn: true }))), []);
  // the same list on an adult's pre-auth passes, as ours did
  assert.deepStrictEqual(codes(engine.validate('preauth/submit', H.bundle({ items: [H.line('SG059A', { informationSequence: [1, 2] })] }))), []);
});

test('PAYR-1008 document under a category other than ATT, INV or DOB, with no data, or not base64', () => {
  fresh();
  const c = o => H.bundle(Object.assign({ use: 'claim', discharged: '2026-11-18T12:00:00+05:30' }, o));
  // fixture error-payr-1008-invalid-base64-value-received-in-attachm refused with DCR under HDS, real sandbox traffic accepted with it under ATT and nothing else changed
  const f = engine.validate('claim/submit', c({ attachment: H.PDF, attachCategory: 'HDS' }));
  assert.deepStrictEqual(codes(f), ['PAYR-1008']);
  assert.match(f[0].message, /for item FB/);
  assert.deepStrictEqual(codes(engine.validate('claim/submit', c({ attachment: null }))), ['PAYR-1008']);
  assert.deepStrictEqual(codes(engine.validate('claim/submit', c({ attachment: '@@notbase64' }))), ['PAYR-1008']);
  for (const cat of ['ATT', 'INV', 'DOB']) assert.deepStrictEqual(codes(engine.validate('claim/submit', c({ attachment: H.PDF, attachCategory: cat }))), [], cat);
  // a PDF without an xref table passes: adding one did not clear the 10 Nov refusals (out-1fefeef6)
  assert.deepStrictEqual(codes(engine.validate('claim/submit', c({ attachment: H.BAD_PDF }))), []);
});

test('PAYR-1357 same-day discharge sent as a bare date', () => {
  fresh();
  const bad = H.bundle({ use: 'claim', admitted: '2026-11-16T09:00:00+05:30', discharged: '2026-11-16' });
  assert.deepStrictEqual(codes(engine.validate('claim/submit', bad)), ['PAYR-1357']);
  const ok = H.bundle({ use: 'claim', admitted: '2026-11-16T09:00:00+05:30', discharged: '2026-11-16T15:00:00' });
  assert.deepStrictEqual(codes(engine.validate('claim/submit', ok)), []);
});

test('PAYR-1323 claim line the plan prices by room level, sent without one', () => {
  fresh();
  const bad = H.bundle({ use: 'claim', discharged: '2026-11-18T12:00:00+05:30', dis: ['DAMA', 'Before Surgery'], items: [H.line('LM100', { speciality: 'BM', amount: 12000 })] });
  const f = engine.validate('claim/submit', bad);
  assert.deepStrictEqual(rulesHit(f), ['unpriced-line']);
  const over = H.bundle({ use: 'claim', discharged: '2026-11-18T12:00:00+05:30', items: [H.line('LM100', { speciality: 'SG', amount: 12000, strat: 'STRAT006a' })] });
  assert.deepStrictEqual(rulesHit(engine.validate('claim/submit', over)), ['unpriced-line']);
  const ok = H.bundle({ use: 'claim', discharged: '2026-11-18T12:00:00+05:30', items: [H.line('LM100', { speciality: 'SG', amount: 1800, strat: 'STRAT006a' })] });
  assert.deepStrictEqual(codes(engine.validate('claim/submit', ok)), []);
});

test('PAYR-1323 claim above what is left in the wallet', () => {
  fresh();
  engine.reset({ members: [{ id: 'SBXSTG269', wallet: 1000 }] });
  const f = engine.validate('claim/submit', H.bundle({ use: 'claim', discharged: '2026-11-18T12:00:00+05:30' }));
  assert.deepStrictEqual(rulesHit(f), ['wallet']);
});

test('repeated package on a top-up is a note, priced at the package rate', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  const r = engine.handle(H.req('preauth/submit', H.bundle({ preAuthRef: p.caseNumber, items: [H.line('SG059A', { amount: 12000 }), H.line('SG059A', { amount: 3600 })] })));
  assert.ok(r.findings.some(f => f.code === 'ADJ-REPEAT' && !f.refuse));
  const last = r.callbacks.at(-1);
  assert.strictEqual(last.hcxStatus, 'response.complete');
  assert.strictEqual(engine.state.findCase(p.caseNumber).approved, 24000);   // NHA: eligible 24,000 on 12,000 + 3,600
});

test('every rule names its source', () => {
  for (const r of engine.rules()) assert.ok(r.source && r.source.length > 10, r.id);
});
