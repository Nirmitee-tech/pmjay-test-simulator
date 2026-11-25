'use strict';
// The fixes from the 24 Nov 2026 blind review, each against the real message it copies (the real message
// or answer named in the test). Unit tests on the callback header first, then end to end over sockets.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const jwe = require('../src/server/jwe');
const callbacks = require('../src/server/callbacks');
const H = require('./server.helpers');
const E = require('./engine.helpers');
const { createApp } = require('../src/server/app');

const CFG = { payerCode: '1518@hcx', providerCode: '1000000001@hcx', dummyPayerCode: '1000003538@hcx' };
const REQ = { sender: '1000000001@hcx', recipient: '1518@hcx', correlationId: 'c-1', apiCallId: 'a-1', workflowId: '12', useCase: 'New', abha: '12345678901234' };
const cr = (code, outcome, use = 'preauthorization') => ({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'ClaimResponse', use, outcome,
  adjudication: [{ reason: { coding: [{ code }] } }] } }] });

// ------------------------------------------------------------------ unit: header and workflow ids

test('unit: 1518 header has the real keys in the real order, sender per endpoint, bare recipient (fixture two-packages-preauth)', () => {
  const h = callbacks.header({ action: 'preauth/on_submit', hcxStatus: 'response.partial', bundle: cr('submitted', 'queued') }, REQ, CFG);
  assert.deepStrictEqual(Object.keys(h), ['x-hcx-error_details', 'x-hcx-recipient_code', 'x-hcx-debug_flag', 'x-hcx-timestamp', 'x-hcx-sender_code',
    'x-hcx-correlation_id', 'enc', 'x-hcx-workflow_id', 'x-hcx-api_call_id', 'alg', 'x-hcx-status']);
  assert.strictEqual(h['x-hcx-sender_code'], '1518');
  assert.strictEqual(h['x-hcx-recipient_code'], '1000000001');
  assert.strictEqual(h['x-hcx-timestamp'] % 1000, 0);
  assert.ok(h['x-hcx-timestamp'] > 1e12);
  assert.strictEqual(h['x-hcx-debug_flag'], 'INFO');
  assert.deepStrictEqual(h['x-hcx-error_details'], { trace: null, code: '100', message: 'Message Submitted' });
  assert.notStrictEqual(h['x-hcx-api_call_id'], 'a-1');
  const cov = callbacks.header({ action: 'coverageeligibility/on_check', hcxStatus: 'response.complete' }, REQ, CFG);
  assert.strictEqual(cov['x-hcx-sender_code'], '1518@hcx');
  assert.strictEqual(cov['x-hcx-workflow_id'], '5');
});

test('unit: dummy payer header: @hcx on both codes, epoch seconds (real sandbox traffic)', () => {
  const h = callbacks.header({ action: 'preauth/on_submit', hcxStatus: 'response.complete', bundle: { entry: [] } }, Object.assign({}, REQ, { recipient: '1000003538@hcx' }), CFG);
  assert.strictEqual(h['x-hcx-sender_code'], '1000003538@hcx');
  assert.strictEqual(h['x-hcx-recipient_code'], '1000000001@hcx');
  assert.ok(h['x-hcx-timestamp'] < 1e11);
  assert.strictEqual(h['x-hcx-workflow_id'], '21', 'dummy approved is 21, never the request\'s 12');
});

test('unit: workflow ids per step match 1518\'s real callbacks', () => {
  const wf = (action, bundle, hcxStatus = 'response.complete', extra = {}) => callbacks.workflowFor(Object.assign({ action, bundle, hcxStatus }, extra), false);
  assert.strictEqual(wf('preauth/on_submit', cr('submitted', 'queued'), 'response.partial'), '20');   // real sandbox traffic
  assert.strictEqual(wf('preauth/on_submit', cr('approved', 'complete')), '21');                       // real sandbox traffic
  assert.strictEqual(wf('preauth/on_submit', cr('rejected', 'error')), '23');                          // fixture preauth-rejected
  assert.strictEqual(wf('preauth/on_submit', cr('queried', 'partial')), '24');                         // fixture preauth-queried
  assert.strictEqual(wf('claim/on_submit', cr('submitted', 'queued', 'claim'), 'response.partial'), '25'); // real sandbox traffic
  assert.strictEqual(wf('claim/on_submit', cr('approved', 'complete', 'claim')), '26');                // real sandbox traffic
  assert.strictEqual(wf('claim/on_submit', cr('queried', 'partial', 'claim')), '27');                  // fixture claim-queried
  assert.strictEqual(wf('claim/on_submit', cr('rejected', 'error', 'claim')), '291');                  // fixture claim-rejected
  assert.strictEqual(wf('task/on_submit', cr('cancelled', 'complete')), 'PC02');                       // fixture preauth-cancel
  assert.strictEqual(wf('task/on_submit', cr('submitted', 'queued', 'claim'), 'response.partial'), '37'); // fixture claim-reprocess
  assert.strictEqual(wf('paymentnotice/request', null, 'request.initiated', { notice: 1 }), '30');      // fixture payment-notice
  assert.strictEqual(wf('paymentnotice/request', null, 'request.initiated', { notice: 2 }), '33');      // real sandbox traffic
  assert.strictEqual(wf('insuranceplan/on_request', null), '5');                                         // real sandbox traffic
});

test('unit: a message the payer opens carries api_call_id = correlation_id (fixture payment-notice)', () => {
  const h = callbacks.header({ action: 'paymentnotice/request', hcxStatus: 'request.initiated', correlationId: 'pn-1', notice: 1 }, REQ, CFG);
  assert.strictEqual(h['x-hcx-api_call_id'], 'pn-1');
  assert.strictEqual(h['x-hcx-correlation_id'], 'pn-1');
  assert.strictEqual(h['x-hcx-sender_code'], '1518');
});

// ------------------------------------------------------------------ end to end

const hims = H.keyPair();
let app, port, lis, token, cert;

test.before(async () => {
  lis = H.listener();
  await new Promise(r => lis.server.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-fid-'));
  app = createApp({ port: 0, dataDir, callbackBase: 'http://127.0.0.1:' + lis.server.address().port,
    himsCertPem: hims.publicPem, himsCertPath: '/nonexistent', policiesPath: '/nonexistent', defaultDelayMs: 20, statusDelayMs: 40, logToFile: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  token = await H.session(port);
  cert = (await H.request(port, 'POST', '/participanthcxservice/fetch/certs', { participantid: '1518@hcx' })).json.encryption_cert;
});
test.after(async () => { await app.close(); await new Promise(r => lis.server.close(r)); });
test.beforeEach(async () => {
  await app.idle(); lis.got.length = 0;
  await H.request(port, 'POST', '/mock/fault', { reset: true });
  await H.request(port, 'POST', '/mock/scenario', { scenario: 'auto' });
  await H.request(port, 'POST', '/mock/timing', { decisionDelayMs: null });
});

async function send(action, bundle, extra, headers) {
  const header = H.himsHeader(extra || {});
  const res = await H.request(port, 'POST', '/hcx/v1/' + action, { payload: H.himsEncrypt(JSON.stringify(bundle), cert, header) }, Object.assign({ bearer_auth: 'Bearer ' + token }, headers || {}));
  return { header, res };
}
const open = g => jwe.decrypt(JSON.parse(g.body).payload, hims.privatePem);
const crOf = b => b.entry.find(e => e.resource.resourceType === 'ClaimResponse').resource;
// 1518 allows one open pre-auth per member (PAYR-1238), and held ones stay open, so each test uses its own member
let adm = 7000;
const nextAdmission = () => 'A/' + (++adm) + '/26';
const fresh = (o = {}) => E.bundle(Object.assign({ admissionId: nextAdmission(), member: 'SBXT' + adm }, o));

test('auto: a pre-auth that needs review gets the queued answer (20) and then waits for the desk', async () => {
  const { header } = await send('preauth/submit', fresh());
  const got = await lis.waitFor(1);
  assert.strictEqual(open(got[0]).header['x-hcx-workflow_id'], '20');
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(lis.got.length, 1, 'no decision seconds later');
  const pending = (await H.request(port, 'GET', '/mock/pending')).json.filter(x => x.correlationId === header['x-hcx-correlation_id']);
  assert.strictEqual(pending.length, 1);
  await H.request(port, 'POST', '/mock/desk/' + pending[0].id, { decision: 'approve' });
  const all = await lis.waitFor(2);
  assert.strictEqual(open(all[1]).header['x-hcx-workflow_id'], '21');
});

test('auto with decisionDelayMs: the held pre-auth is approved after that delay', async () => {
  await H.request(port, 'POST', '/mock/timing', { decisionDelayMs: 150 });
  assert.strictEqual((await H.request(port, 'GET', '/mock/timing')).json.decisionDelayMs, 150);
  const t0 = Date.now();
  await send('preauth/submit', fresh());
  const got = await lis.waitFor(2, 3000);
  assert.ok(Date.now() - t0 >= 140);
  assert.deepStrictEqual(got.map(g => open(g).header['x-hcx-workflow_id']), ['20', '21']);
});

test('auto: SB017A (plan ApprovalNotRequired) comes back approved at once, no queued step (fixture implant-preauth)', async () => {
  await send('preauth/submit', E.bundle({ admissionId: nextAdmission(), member: 'SBXSB017', items: [E.line('SB017A', { speciality: 'SB', amount: 17000 }), E.line('IMP0129', { speciality: 'SB', amount: 3000 })] }));
  const got = await lis.waitFor(1);
  await app.idle();
  assert.strictEqual(lis.got.length, 1);
  const o = open(got[0]);
  assert.strictEqual(o.header['x-hcx-status'], 'response.complete');
  assert.strictEqual(o.header['x-hcx-workflow_id'], '21');
});

test('a 1518 refusal arrives as plain JSON ProtocolResponse, not a JWE (a real sandbox answer of 2026-11-09, real sandbox traffic)', async () => {
  const { header } = await send('preauth/submit', fresh({ policies: ['100217'] }));
  const got = await lis.waitFor(1);
  const body = JSON.parse(got[0].body);
  assert.strictEqual(body.payload, undefined);
  assert.strictEqual(body.type, 'ProtocolResponse');
  assert.strictEqual(body['x-hcx-error_details'].code, 'PAYR-1250');
  assert.strictEqual(body['x-hcx-sender_code'], '1518');
  assert.strictEqual(body['x-hcx-recipient_code'], '1000000001');
  assert.strictEqual(body['x-hcx-correlation_id'], header['x-hcx-correlation_id']);
  assert.notStrictEqual(body['x-hcx-api_call_id'], header['x-hcx-api_call_id']);
  assert.strictEqual(body['x-hcx-workflow_id'], null);
});

test('payment notices from 1518: sender 1518, workflow 30 then 33, own correlation, api_call_id = correlation', async () => {
  const a = nextAdmission();
  const p = await send('preauth/submit', E.bundle({ admissionId: a, member: 'SBXPAY01' }), {}, { 'x-mock-scenario': 'approve' });
  await lis.waitFor(2); await app.idle();
  const ref = crOf(JSON.parse(open(lis.got[1]).payload)).preAuthRef;
  lis.got.length = 0;
  const c = await send('claim/submit', E.bundle({ use: 'claim', admissionId: a, member: 'SBXPAY01', preAuthRef: ref, discharged: '2026-11-18T12:00:00+05:30' }), { workflowId: '15' }, { 'x-mock-scenario': 'payment' });
  const got = await lis.waitFor(4, 4000);
  const ack = open(got[0]);
  assert.strictEqual(crOf(JSON.parse(ack.payload)).preAuthRef, ref, 'the claim keeps the pre-auth preAuthRef (real sandbox traffic)');
  const notices = got.filter(g => g.path === '/v1/paymentnotice/request').map(open);
  assert.deepStrictEqual(notices.map(n => n.header['x-hcx-workflow_id']), ['30', '33']);
  for (const n of notices) {
    assert.strictEqual(n.header['x-hcx-sender_code'], '1518');
    assert.strictEqual(n.header['x-hcx-api_call_id'], n.header['x-hcx-correlation_id']);
    assert.notStrictEqual(n.header['x-hcx-correlation_id'], c.header['x-hcx-correlation_id']);
  }
});

test('/v1/status: 202 with every field null, then a plain on_status NHCX-1019 about a second later (a real sandbox answer of 2026-11-13)', async () => {
  const p = await send('preauth/submit', fresh(), {}, { 'x-mock-scenario': 'approve' });
  await lis.waitFor(2); await app.idle(); lis.got.length = 0;
  const s = await send('status', { resourceType: 'Bundle', entry: [] }, { apiCallId: p.header['x-hcx-api_call_id'], correlationId: p.header['x-hcx-correlation_id'], workflowId: '12' });
  assert.strictEqual(s.res.status, 202);
  assert.deepStrictEqual(s.res.json, { timestamp: null, api_call_id: null, correlation_id: null, result: null, error: null });
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/on_status');
  const b = JSON.parse(got[0].body);
  assert.strictEqual(b.payload, undefined);
  assert.strictEqual(b['x-hcx-sender_code'], '1000000001@hcx');
  assert.strictEqual(b['x-hcx-recipient_code'], '1000000001@hcx');
  assert.strictEqual(b['x-hcx-api_call_id'], p.header['x-hcx-api_call_id']);
  assert.strictEqual(b['x-hcx-correlation_id'], p.header['x-hcx-correlation_id']);
  assert.strictEqual(b['x-hcx-status'], 'request.dispatched');
  assert.strictEqual(b['x-hcx-error_details'].code, 'NHCX-1019');
  assert.match(b['x-hcx-timestamp'], /^\d{10}$/);
  assert.strictEqual(b['x-hcx-entity-type'], 'preauth');
  // the older code, as NHA sent it until 21 Oct 2026 (real sandbox traffic)
  await H.request(port, 'POST', '/mock/protocol', { statusAnswerCode: 'NHCX-1012' });
  lis.got.length = 0;
  await send('status', { resourceType: 'Bundle', entry: [] }, { apiCallId: p.header['x-hcx-api_call_id'], correlationId: p.header['x-hcx-correlation_id'], workflowId: '12' });
  assert.strictEqual(JSON.parse((await lis.waitFor(1))[0].body)['x-hcx-error_details'].code, 'NHCX-1012');
  await H.request(port, 'POST', '/mock/protocol', { statusAnswerCode: 'NHCX-1019' });
});

test('fault http500: Spring error JSON, chunked, path names NHA\'s service (a real sandbox answer of 2026-11-09)', async () => {
  await H.request(port, 'POST', '/mock/fault', { http500: true });
  const { res } = await send('preauth/submit', E.bundle());
  assert.strictEqual(res.status, 500);
  assert.deepStrictEqual(Object.keys(res.json), ['timestamp', 'status', 'error', 'path']);
  assert.strictEqual(typeof res.json.timestamp, 'number');
  assert.strictEqual(res.json.path, '/preauthhcxservice/v1/preauth/submit');
  assert.strictEqual(res.json.error, 'Internal Server Error');
});

test('fault noHealthyUpstream and upstreamConnectError: 503 plain text on /v1 and the registry', async () => {
  await H.request(port, 'POST', '/mock/fault', { noHealthyUpstream: true });
  const a = await send('status', {}, {});
  assert.strictEqual(a.res.status, 503);
  assert.strictEqual(a.res.text, 'no healthy upstream');                                   // a real sandbox answer of 2026-11-09
  await H.request(port, 'POST', '/mock/fault', { reset: true, upstreamConnectError: true });
  const b = await H.request(port, 'POST', '/participanthcxservice/participant/get/policies', { identifiertype: 'MemberId', identifiervalue: 'SBXSTG269' });
  assert.strictEqual(b.status, 503);
  assert.match(b.text, /^upstream connect error or disconnect\/reset before headers/); // a real sandbox answer of 2026-11-13
});

test('fault jwePayloadWrapper and chunkedCallback change only how the callback is sent', async () => {
  await H.request(port, 'POST', '/mock/fault', { jwePayloadWrapper: true, chunkedCallback: true });
  await send('preauth/submit', fresh());
  const got = await lis.waitFor(1);
  const body = JSON.parse(got[0].body);
  assert.strictEqual(body.type, 'JWEPayload');
  assert.strictEqual(jwe.decrypt(body.payload, hims.privatePem).header['x-hcx-sender_code'], '1518');
  assert.strictEqual(got[0].headers['content-length'], undefined);
  assert.strictEqual(got[0].headers['transfer-encoding'], 'chunked');
});

test('session: refuses when the fault is on, or when configured credentials do not match; answer carries refreshToken', async () => {
  const ok = await H.request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'x', clientSecret: 'y' });
  assert.deepStrictEqual(Object.keys(ok.json), ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType']);
  await H.request(port, 'POST', '/mock/fault', { sessionRefuse: true });
  assert.strictEqual((await H.request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'x', clientSecret: 'y' })).status, 401);
  await H.request(port, 'POST', '/mock/fault', { reset: true });
  app.cfg.clientId = 'SBX_TEST'; app.cfg.clientSecret = 'right';
  try {
    assert.strictEqual((await H.request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'SBX_TEST', clientSecret: 'wrong' })).status, 401);
    assert.strictEqual((await H.request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'SBX_TEST', clientSecret: 'right' })).status, 200);
  } finally { app.cfg.clientId = ''; app.cfg.clientSecret = ''; }
});

test('the page offers the new fault switches', async () => {
  const r = await H.request(port, 'GET', '/');
  for (const f of ['http500', 'noHealthyUpstream', 'upstreamConnectError', 'jwePayloadWrapper', 'chunkedCallback', 'sessionRefuse'])
    assert.ok(r.text.includes('data-f="' + f + '"'), f);
});
