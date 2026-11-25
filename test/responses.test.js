'use strict';
// Unit tests for src/responses: each builder's output is compared with a real 1518 answer kept
// in fixtures/. "Same structure" here means: the same set of JSON key paths (arrays folded,
// grouped by resourceType), the same coding systems, the same resource types and entry url
// patterns. Values that 1518 filled from the case (amounts, dates, free text) are checked
// separately where they matter. A pass shows the builder emits the fields 1518 emits; it does
// not prove the HIMS accepts them, which only a run against the HIMS shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, kinds, SHAPE_SOURCE } = require('../src/responses');

const FX = path.join(__dirname, '..', 'fixtures');
const load = (p) => JSON.parse(fs.readFileSync(path.join(FX, p), 'utf8'));
const NOW = new Date('2026-11-20T10:25:59Z');

function paths(o, p = '', out = new Set()) {
  if (Array.isArray(o)) { for (const x of o) paths(x, p + '[]', out); if (!o.length) out.add(p + '[]'); return out; }
  if (o && typeof o === 'object') {
    const rt = o.resourceType ? `<${o.resourceType}>` : '';
    for (const [k, v] of Object.entries(o)) paths(v, `${p}${rt}.${k}`, out);
    return out;
  }
  out.add(`${p}:${o === null ? 'null' : typeof o}`);
  return out;
}
function systems(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach((x) => systems(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'system' && typeof v === 'string') out.add(v); else systems(v, out); }
  return out;
}
const urlPattern = (u) => String(u || '').replace(/A\/\d+\/\d+/g, 'CASE').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'UUID');
function entryShape(b) { return (b.entry || []).map((e) => `${e.resource.resourceType} ${urlPattern(e.fullUrl)} ${e.id ? 'id' : ''}`).sort(); }
function sameShape(actual, real, label) {
  const a = paths(actual); const r = paths(real);
  const missing = [...r].filter((x) => !a.has(x)); const extra = [...a].filter((x) => !r.has(x));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label}: key paths differ`);
  assert.deepEqual([...systems(actual)].sort(), [...systems(real)].sort(), `${label}: coding systems differ`);
  if (real.entry) assert.deepEqual(entryShape(actual), entryShape(real), `${label}: entries differ`);
}
const crOf = (b) => b.entry.find((e) => e.resource.resourceType === 'ClaimResponse').resource;
const statusCodes = (cr) => ({
  outcome: cr.outcome,
  header: cr.adjudication.map((a) => a.reason.coding[0].code),
  items: (cr.item || []).map((i) => i.adjudication.find((a) => a.category.coding[0].code === 'status').reason.coding[0].code).sort(),
});
function ctxFrom(dir, file = 'response.json', items) {
  const req = load(`${dir}/request.json`);
  const real = load(`${dir}/${file}`);
  const cr = real.entry && real.entry.find((e) => e.resource.resourceType === 'ClaimResponse');
  const meta = load(`${dir}/meta.json`);
  const ctx = { bundle: req, caseNumber: meta.caseNumber, preAuthRef: cr && cr.resource.preAuthRef, now: NOW, memberId: 'SBXSTG269' };
  if (cr) ctx.disposition = cr.resource.disposition ?? null; // null means 1518 sent none
  if (items) ctx.items = items;
  return { real, ctx };
}

// MN001A: the HIMS asked 500, 1518 priced the package at 1500 (rate). Enhancement: SN063D (1800)
// was approved before, SG059A (12000) is the new package.
const MN001A = [{ sequence: 1, submitted: 500, rate: 1500 }];
const ENH = [{ sequence: 2, submitted: 12000 }, { sequence: 1, submitted: 1800, prior: true }];
const CLAIM_CASES = [
  ['preauth.queued', 'happy-preauth', 'response-ack.json', MN001A],
  ['preauth.approved', 'happy-preauth', 'response.json', MN001A],
  ['preauth.approved', 'enhancement-approved', 'response.json', ENH],
  ['preauth.approved', 'room-level-sn063d', 'response.json'],
  ['preauth.approved', 'newborn-preauth', 'response.json', MN001A],
  ['preauth.queried', 'preauth-queried', 'response.json'],
  ['preauth.rejected', 'preauth-rejected', 'response.json'],
  ['preauth.queued', 'two-packages-preauth', 'response.json'],
  ['claim.queued', 'happy-claim', 'response-ack.json'],
  ['claim.approved', 'happy-claim', 'response.json'],
  ['claim.approved', 'newborn-claim', 'response.json'],
  ['claim.approved', 'death-before-surgery-claim', 'response.json'],
  ['claim.queried', 'claim-queried', 'response.json'],
  ['claim.rejected', 'claim-rejected', 'response.json'],
];

for (const [kind, dir, file, items] of CLAIM_CASES) {
  test(`${kind} matches real ${dir}/${file}`, () => {
    const { real, ctx } = ctxFrom(dir, file, items);
    const out = build(kind, ctx);
    sameShape(out, real, `${kind} vs ${dir}`);
    assert.deepEqual(statusCodes(crOf(out)), statusCodes(crOf(real)));
    assert.equal(crOf(out).identifier[0].value, crOf(real).identifier[0].value, 'case number');
    assert.equal(out.id, real.id, 'bundle id is the case number year segment');
    assert.equal(crOf(out).preAuthRef, crOf(real).preAuthRef);
    const tot = (b, c) => crOf(b).total.find((t) => t.category.coding[0].code === c);
    assert.equal(tot(out, 'submitted').amount.value, tot(real, 'submitted').amount.value, 'submitted total');
    assert.equal(tot(out, 'benefit').amount.value, tot(real, 'benefit').amount.value, 'benefit total');
  });
}

test('coverage matches real happy-coverage', () => {
  const req = load('happy-coverage/request.json');
  const real = load('happy-coverage/response.json');
  const out = build('coverage', { bundle: req, now: NOW });
  sameShape(out, real, 'coverage');
  const cer = (b) => b.entry.find((e) => e.resource.resourceType === 'CoverageEligibilityResponse').resource;
  assert.equal(cer(out).outcome, 'complete');
  assert.equal(cer(out).request.reference, cer(real).request.reference, 'points back at the request');
  assert.equal(out.id, real.id);
  assert.equal(cer(out).id, cer(real).id);
});

test('task.cancel matches real preauth-cancel', () => {
  const req = load('preauth-cancel/request.json');
  const real = load('preauth-cancel/response.json');
  const out = build('task.cancel', { bundle: req, caseNumber: 'A/9011/26', now: NOW });
  sameShape(out, real, 'cancel');
  assert.deepEqual(statusCodes(crOf(out)), statusCodes(crOf(real)));
  assert.equal(out.entry[0].resource.status, 'completed');
  assert.equal(out.entry[0].resource.description, real.entry[0].resource.description, 'echoes the cancel reason text');
});

test('task.reprocess matches real claim-reprocess', () => {
  const req = load('claim-reprocess/request.json');
  const real = load('claim-reprocess/response.json');
  const out = build('task.reprocess', { bundle: req, now: NOW });
  sameShape(out, real, 'reprocess');
  assert.equal(crOf(out).identifier[0].value, 'A/9016/26', 'case number read from the Task basedOn/input');
  assert.equal(out.entry[0].resource.status, 'accepted');
});

test('paymentnotice.request matches real payment-notice request', () => {
  const real = load('payment-notice/request.json');
  const out = build('paymentnotice.request', { caseNumber: 'A/9022/26', amount: 1500, preAuthRef: 'PMJAY/HP/S/2024/R2/2026112090000014', now: NOW });
  sameShape(out, real, 'payment notice');
  const rec = (b) => b.entry.find((e) => e.resource.resourceType === 'PaymentReconciliation').resource;
  assert.equal(rec(out).detail[0].id, rec(real).detail[0].id, 'placer id <provider>/<preauth serial>/N');
});

const errorDirs = fs.readdirSync(FX).filter((d) => d.startsWith('error-'));
for (const dir of errorDirs) {
  test(`error matches real ${dir}`, () => {
    const real = load(`${dir}/response.json`);
    const meta = load(`${dir}/meta.json`);
    const out = build('error', {
      endpoint: meta.response.endpoint, code: real['x-hcx-error_details'].code, message: real['x-hcx-error_details'].message,
      apiCallId: real['x-hcx-api_call_id'], correlationId: real['x-hcx-correlation_id'], workflowId: real['x-hcx-workflow_id'], now: NOW,
    });
    sameShape(out, real, dir);
    for (const k of ['x-hcx-status', 'x-hcx-sender_code', 'x-hcx-entity-type', 'x-hcx-error_details', 'type']) assert.deepEqual(out[k], real[k], `${dir} ${k}`);
  });
}

test('partial approval lowers eligible and benefit, keeps the approved shape', () => {
  const { real, ctx } = ctxFrom('happy-claim');
  const out = build('claim.partial', { ...ctx, items: [{ sequence: 1, submitted: 1500, approved: 1000 }] });
  sameShape(out, real, 'claim.partial');
  const cr = crOf(out);
  assert.equal(cr.total.find((t) => t.category.coding[0].code === 'benefit').amount.value, 1000);
  assert.equal(cr.item[0].adjudication.find((a) => a.category.coding[0].code === 'eligpercent').value, 67);
});

test('preAuthRef default follows the real format', () => {
  const out = build('preauth.queued', { caseNumber: 'A/9025/26', items: [{ sequence: 1, submitted: 1800 }], seq: 7, now: NOW });
  assert.match(crOf(out).preAuthRef, /^PMJAY\/HP\/S\/2024\/R2\/2026112010000007$/);
  assert.match(out.timestamp, /^2026-11-20T15:55:59\.000\+05:30$/);
});

test('communication.request is built and marked as predicted', () => {
  const out = build('communication.request', { caseNumber: 'A/9022/26', now: NOW });
  assert.equal(out.entry[0].resource.resourceType, 'CommunicationRequest');
  assert.match(SHAPE_SOURCE['communication.request'], /none/);
});

test('every kind is listed and unknown kinds throw', () => {
  for (const k of kinds) assert.ok(SHAPE_SOURCE[k], k);
  assert.throws(() => build('nope', {}), /unknown response kind/);
});

// Integration: the engine (src/engine, Agent B) answers a real the HIMS pre-auth request through
// these builders. Checks that the callbacks carry the real 1518 shape (queued ack, then the
// decision) and not the engine's stub. It does not test the HTTP or JWE layer.
test('integration: engine.handle on the real happy-preauth request returns 1518-shaped callbacks', () => {
  const engine = require('../src/engine');
  const req = load('happy-preauth/request.json');
  const r = engine.handle({ action: 'preauth/submit', apiCallId: 'it-1', correlationId: 'it-c1', sender: '1000000001@hcx', recipient: '1518@hcx', headers: {}, bundle: req });
  assert.ok(r.callbacks.length >= 1, 'at least one callback');
  const ack = r.callbacks[0];
  assert.equal(ack.action, 'preauth/on_submit');
  const realAck = load('happy-preauth/response-ack.json');
  assert.deepEqual(entryShape(ack.bundle), entryShape(realAck), 'ack entries match the real ack');
  assert.equal(crOf(ack.bundle).outcome, 'queued');
  assert.equal(crOf(ack.bundle).identifier[0].value, 'A/9022/26');
  assert.ok(!JSON.stringify(ack.bundle).includes('pmjaymock-stub'), 'built by src/responses, not the engine stub');
});
