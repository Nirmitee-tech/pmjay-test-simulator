'use strict';
// One pass case per scenario, through handle() as the server calls it.
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/engine');
const H = require('./engine.helpers');

function fresh() { engine.reset(); engine.setScenario(null); engine.setOptions({ queuedMs: 0, decisionMs: 0, paymentMs: 0 }); }
const S = s => ({ 'x-mock-scenario': s });
const claimOn = (ref, o = {}) => H.bundle(Object.assign({ use: 'claim', preAuthRef: ref, discharged: '2026-11-18T12:00:00+05:30' }, o));
const decisions = r => r.callbacks.map(c => [c.action, c.hcxStatus]);

test('catalogue lists every scenario with a plain description', () => {
  const ids = engine.scenarios().map(s => s.id);
  for (const id of ['auto', 'approve', 'partial', 'query', 'reject', 'pending', 'cancel', 'enhancement', 'implant', 'newborn', 'lama', 'dama', 'death-before', 'death-after', 'two-packages', 'erroneous', 'reprocess', 'payment'])
    assert.ok(ids.includes(id), id);
  for (const s of engine.scenarios()) assert.ok(s.description.length > 20);
});

test('case numbers look like 1518 ones', () => {
  fresh();
  const r = engine.handle(H.req('preauth/submit', H.bundle()));
  assert.match(r.caseNumber, /^PMJAY\/HP\/S\/2024\/R2\/\d{8}1\d{7}$/);
});

test('auto: cover check, plan, pre-auth queued then approved, claim approved', () => {
  fresh();
  assert.deepStrictEqual(decisions(engine.handle(H.req('coverageeligibility/check', H.cover()))), [['coverageeligibility/on_check', 'response.complete']]);
  assert.deepStrictEqual(decisions(engine.handle(H.req('insuranceplan/request', H.planTask('PMJAY/HP/S/G')))), [['insuranceplan/on_request', 'response.complete']]);
  const p = engine.handle(H.req('/v1/preauth/submit', H.bundle()));
  assert.deepStrictEqual(decisions(p), [['preauth/on_submit', 'response.partial'], ['preauth/on_submit', 'response.complete']]);
  const c = engine.handle(H.req('claim/submit', claimOn(p.caseNumber)));
  assert.deepStrictEqual(decisions(c), [['claim/on_submit', 'response.partial'], ['claim/on_submit', 'response.complete']]);
});

test('auto: package approved without review comes back complete at once', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle({ items: [H.line('SB017A', { speciality: 'SB', amount: 17000 }), H.line('IMP0129', { speciality: 'SB', amount: 3000 })] })));
  assert.deepStrictEqual(decisions(p), [['preauth/on_submit', 'response.complete']]);
});

test('approve', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle(), S('approve')));
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'approved');
});

test('partial: half the eligible amount', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle(), S('partial')));
  assert.strictEqual(engine.state.findCase(p.caseNumber).approved, 6000);
});

test('query: pre-auth question on the pre-auth, reply approved', () => {
  fresh();
  engine.setScenario('query');
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'queried');
  const reply = engine.handle(H.req('preauth/submit', H.bundle(), { 'x-hcx-workflow_id': '19' }));
  assert.strictEqual(reply.caseNumber, p.caseNumber);
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'approved');
  const c = engine.handle(H.req('claim/submit', claimOn(p.caseNumber)));
  assert.strictEqual(engine.state.findCase(p.caseNumber).claim.status, 'queried');   // complete, outcome partial (fixture claim-queried)
  const c2 = engine.handle(H.req('claim/submit', claimOn(p.caseNumber)));
  assert.strictEqual(c2.callbacks.at(-1).hcxStatus, 'response.complete');
});

test('reject: then a new pre-auth on the same admission keeps the case number', () => {
  fresh();
  engine.setScenario('reject');
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'rejected');
  const p2 = engine.handle(H.req('preauth/submit', H.bundle()));
  assert.strictEqual(p2.caseNumber, p.caseNumber);
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'approved');
});

test('pending: only queued, decided on the desk', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle(), S('pending')));
  assert.deepStrictEqual(decisions(p), [['preauth/on_submit', 'response.partial']]);
  const d = engine.desk({ caseNumber: p.caseNumber, decision: 'approve' });
  assert.strictEqual(d.callbacks[0].hcxStatus, 'response.complete');
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'approved');
});

test('cancel: PC01 on an open pre-auth answered complete, case closed, member free again', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle({ admissionId: 'A/9002/26' }), S('pending')));
  const t = engine.handle(H.req('task/submit', H.cancelTask(p.caseNumber), S('cancel')));
  assert.deepStrictEqual(decisions(t), [['task/on_submit', 'response.complete']]);
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'cancelled');
  const p2 = engine.handle(H.req('preauth/submit', H.bundle({ admissionId: 'A/9003/26' })));
  assert.ok(!p2.callbacks[0].error);
});

test('enhancement: top-up on an approved pre-auth adding a surgical package', () => {
  fresh();
  engine.setScenario('enhancement');
  const p = engine.handle(H.req('preauth/submit', H.bundle({ items: [H.line('SN063D', { speciality: 'SN', amount: 1800, strat: 'STRAT006a' })] })));
  const e = engine.handle(H.req('preauth/submit', H.bundle({ preAuthRef: p.caseNumber, items: [H.line('SN063D', { speciality: 'SN', amount: 1800, strat: 'STRAT006a' }), H.line('SG059A', { amount: 12000 })] })));
  assert.strictEqual(e.callbacks.at(-1).hcxStatus, 'response.complete');
  assert.strictEqual(engine.state.findCase(p.caseNumber).approved, 13800);
});

test('implant: package with its implant approved, claim approved in full', () => {
  fresh();
  engine.setScenario('implant');
  const items = () => [H.line('SB017A', { speciality: 'SB', amount: 17000 }), H.line('IMP0129', { speciality: 'SB', amount: 3000 })];
  const p = engine.handle(H.req('preauth/submit', H.bundle({ items: items() })));
  assert.ok(!p.findings.some(f => f.code === 'SCENARIO'));
  engine.handle(H.req('claim/submit', claimOn(p.caseNumber, { items: items() })));
  assert.strictEqual(engine.state.findCase(p.caseNumber).claim.approved, 20000);   // fixture implant-claim
});

test('newborn: child as second patient, no document list, approved', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle({ newborn: true }), S('newborn')));
  assert.strictEqual(p.callbacks.at(-1).hcxStatus, 'response.complete');
  assert.ok(!p.findings.some(f => f.code === 'SCENARIO'));
});

for (const [sc, dis] of [['lama', ['LAMA', 'Before Surgery']], ['dama', ['DAMA', 'Before Surgery']], ['death-before', ['DTM', 'Before Surgery']], ['death-after', ['DTM', 'After Surgery']]]) {
  test(sc + ': claim with that discharge approved', () => {
    fresh();
    engine.setScenario(sc);
    const p = engine.handle(H.req('preauth/submit', H.bundle()));
    const c = engine.handle(H.req('claim/submit', claimOn(p.caseNumber, { dis })));
    assert.strictEqual(c.callbacks.at(-1).hcxStatus, 'response.complete');
    assert.ok(!c.findings.some(f => f.code === 'SCENARIO'));
    const wrong = engine.handle(H.req('claim/submit', claimOn(p.caseNumber, { dis: ['DIS', 'x'], admissionId: 'A/9005/26' })));
    assert.ok(wrong.findings.some(f => f.code === 'SCENARIO' && !f.refuse));
  });
}

test('two-packages: two surgical packages on one pre-auth approved', () => {
  fresh();
  const p = engine.handle(H.req('preauth/submit', H.bundle({ items: [H.line('SG059A', { amount: 12000 }), H.line('SB017A', { speciality: 'SB', amount: 17000 }), H.line('IMP0129', { speciality: 'SB', amount: 3000 })] }), S('two-packages')));
  assert.strictEqual(p.callbacks.at(-1).hcxStatus, 'response.complete');
  assert.ok(!p.findings.some(f => f.code === 'SCENARIO'));
});

test('erroneous: short-paid claim, two notices, then the erroneous claim is accepted', () => {
  fresh();
  engine.setScenario('erroneous');
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  const c = engine.handle(H.req('claim/submit', claimOn(p.caseNumber)));
  assert.deepStrictEqual(c.callbacks.filter(x => x.action === 'paymentnotice/request').length, 2);
  const e = engine.handle(H.req('claim/submit', claimOn(p.caseNumber, { items: [H.line('SG059A', { amount: 6000 })] })));
  assert.ok(!e.callbacks[0].error);
  assert.strictEqual(e.callbacks.at(-1).hcxStatus, 'response.complete');
});

test('reprocess: claim rejected, sent again, approved', () => {
  fresh();
  engine.setScenario('reprocess');
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  engine.handle(H.req('claim/submit', claimOn(p.caseNumber)));
  assert.strictEqual(engine.state.findCase(p.caseNumber).claim.status, 'rejected');
  engine.handle(H.req('claim/submit', claimOn(p.caseNumber), { 'x-hcx-workflow_id': '122' }));
  assert.strictEqual(engine.state.findCase(p.caseNumber).claim.status, 'approved');
});

test('payment: claim approved and two payment notices sent', () => {
  fresh();
  engine.setScenario('payment');
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  const c = engine.handle(H.req('claim/submit', claimOn(p.caseNumber)));
  const notices = c.callbacks.filter(x => x.action === 'paymentnotice/request');
  assert.strictEqual(notices.length, 2);
  assert.strictEqual(notices[0].hcxStatus, 'request.initiated');
});

test('a refusal is one response.error callback with code and message', () => {
  fresh();
  const r = engine.handle(H.req('preauth/submit', H.bundle({ policies: ['100217'] })));
  assert.strictEqual(r.callbacks.length, 1);
  assert.strictEqual(r.callbacks[0].hcxStatus, 'response.error');
  assert.strictEqual(r.callbacks[0].error.code, 'PAYR-1250');
  assert.ok(r.callbacks[0].bundle);
});

// ---- fidelity fixes (24 Nov 2026 blind review)

const hold = (action, b, h) => Object.assign(H.req(action, b, h), { reviewHold: true });

test('auto with reviewHold: a pre-auth needing review gets only the queued answer and waits for the desk', () => {
  fresh();
  const p = engine.handle(hold('preauth/submit', H.bundle()));
  assert.deepStrictEqual(decisions(p), [['preauth/on_submit', 'response.partial']]);
  assert.strictEqual(p.pending, true);
  assert.strictEqual(p.review, true);
  const c = engine.state.findCase(p.caseNumber);
  assert.strictEqual(c.status, 'pending');
  const d = engine.desk({ caseNumber: p.caseNumber, decision: 'approve' });
  assert.strictEqual(d.callbacks[0].hcxStatus, 'response.complete');
  assert.strictEqual(engine.state.findCase(p.caseNumber).status, 'approved');
});

test('auto with reviewHold: a package the plan approves without review (SB017A) is still decided at once', () => {
  fresh();
  const p = engine.handle(hold('preauth/submit', H.bundle({ items: [H.line('SB017A', { speciality: 'SB', amount: 17000 }), H.line('IMP0129', { speciality: 'SB', amount: 3000 })] })));
  assert.deepStrictEqual(decisions(p), [['preauth/on_submit', 'response.complete']]);
  assert.ok(!p.pending);
});

test('a claim keeps the pre-auth preAuthRef, also when the mock no longer holds the case (real sandbox traffic)', () => {
  fresh();
  const ref = 'PMJAY/HP/S/2024/R2/2026112090000015';
  const c = engine.handle(H.req('claim/submit', claimOn(ref, { admissionId: 'A/9023/26' }), S('approve')));
  const cr = c.callbacks[0].bundle.entry.find(e => e.resource.resourceType === 'ClaimResponse').resource;
  assert.strictEqual(c.caseNumber, ref);
  assert.strictEqual(cr.preAuthRef, ref);
});

test('payment notices open their own conversations, workflow 30 then 33 (real sandbox traffic)', () => {
  fresh();
  engine.setScenario('payment');
  const p = engine.handle(H.req('preauth/submit', H.bundle()));
  const req = H.req('claim/submit', claimOn(p.caseNumber));
  const notices = engine.handle(req).callbacks.filter(x => x.action === 'paymentnotice/request');
  assert.deepStrictEqual(notices.map(n => n.workflowId), ['30', '33']);
  assert.ok(notices.every(n => n.correlationId && n.correlationId !== req.correlationId));
  assert.notStrictEqual(notices[0].correlationId, notices[1].correlationId);
});

test('a refusal names 1518 as sender, the HIMS bare as recipient, a fresh api_call_id, no workflow id (real sandbox traffic)', () => {
  fresh();
  const req = Object.assign(H.req('preauth/submit', H.bundle({ policies: ['100217'] })), { sender: '1000000001@hcx', workflowId: '12' });
  const pr = engine.handle(req).callbacks[0].bundle;
  assert.strictEqual(pr.type, 'ProtocolResponse');
  assert.strictEqual(pr['x-hcx-sender_code'], '1518');
  assert.strictEqual(pr['x-hcx-recipient_code'], '1000000001');
  assert.strictEqual(pr['x-hcx-workflow_id'], null);
  assert.notStrictEqual(pr['x-hcx-api_call_id'], req.apiCallId);
  assert.match(pr['x-hcx-timestamp'], /^\d{10}000$/);
});

test('the sandbox member starts with 1518\'s last wallet: allowed 392000, used 108000 (real sandbox traffic)', () => {
  fresh();
  const r = engine.handle(H.req('coverageeligibility/check', H.cover()));
  const ce = r.callbacks[0].bundle.entry.find(e => e.resource.resourceType === 'CoverageEligibilityResponse').resource;
  const b = ce.insurance[0].item[0].benefit[0];
  assert.deepStrictEqual([b.allowedMoney.value, b.usedMoney.value], [392000, 108000]);
});
