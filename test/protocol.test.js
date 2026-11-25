'use strict';
// Every NHA protocol check in src/server/protocol.js: unit (check() directly) and over HTTP (createApp on a free port).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const H = require('./server.helpers');
const protocol = require('../src/server/protocol');
const { createApp } = require('../src/server/app');

const HIMS = '1000000001@hcx';
const REG = {
  '1000000001@hcx': { status: 'Active' }, '1518@hcx': { status: 'Active' }, '1000003538@hcx': { status: 'Active' },
  '1000000009@hcx': { status: 'Inactive' },
};
const kp = H.keyPair();

function mk(settings, log) {
  const p = protocol.create({ participant: c => REG[c] || null, log: log || { items: [] }, providerCode: HIMS, settings });
  p.issue('tok');
  return p;
}
function call(p, action, hdr, opts) {
  const header = Object.assign(H.himsHeader(), hdr || {});
  for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k];
  const payload = (opts && opts.payload) || H.himsEncrypt('{}', kp.publicPem, header);
  const body = { payload };
  return Object.assign(p.check({ action, headers: { bearer_auth: 'Bearer ' + ((opts && opts.token) || 'tok') }, text: JSON.stringify(body), body }), { sent: header });
}
function refused(r, id, http, code) {
  assert.strictEqual(r.ok, false, 'expected refusal by ' + id);
  const last = r.checks[r.checks.length - 1];
  assert.strictEqual(last.id, id);
  assert.strictEqual(r.refusal.status, http);
  assert.strictEqual(r.refusal.body.error.code, code);
  assert.ok(last.source, 'every check names its source');
}

test('a well formed HIMS request passes every check, each logged with its source', () => {
  const r = call(mk(), 'preauth/submit');
  assert.strictEqual(r.ok, true);
  const ids = r.checks.map(c => c.id);
  for (const id of ['token', 'body', 'size', 'header', 'alg', 'required', 'uuid', 'timestamp', 'sender', 'senderToken', 'recipient', 'status', 'abha', 'apiCallUnique', 'conversation'])
    assert.ok(ids.includes(id), id);
  assert.ok(r.checks.every(c => c.ok && typeof c.real === 'boolean' && c.source));
});

test('token: missing, not issued, expired -> 401 NHCX-401 with null ids (real body, row 83)', () => {
  const p = mk();
  const none = p.check({ action: 'preauth/submit', headers: {}, text: '{}', body: {} });
  refused(none, 'token', 401, 'NHCX-401');
  assert.strictEqual(none.refusal.body.api_call_id, null);
  assert.strictEqual(none.refusal.body.result.protocol_status, 'request.error');
  assert.strictEqual(none.refusal.body.error.message, 'Sender is not authorized to execute the operation.');
  refused(call(p, 'preauth/submit', {}, { token: 'never-issued' }), 'token', 401, 'NHCX-401');
  let t = 1000;
  const q = protocol.create({ participant: c => REG[c], log: { items: [] }, providerCode: HIMS, now: () => t });
  q.issue('short', HIMS, 500); t = 2000;
  const r = q.check({ action: 'preauth/submit', headers: { bearer_auth: 'Bearer short' }, text: '{}', body: { payload: 'x' } });
  refused(r, 'token', 401, 'NHCX-401');
  assert.match(r.checks[0].detail, /expired/);
});

test('body: blank or missing payload -> 400 NHCX-1013', () => {
  const p = mk();
  refused(p.check({ action: 'claim/submit', headers: { bearer_auth: 'Bearer tok' }, text: '{}', body: {} }), 'body', 400, 'NHCX-1013');
  refused(p.check({ action: 'claim/submit', headers: { bearer_auth: 'Bearer tok' }, text: '{"payload":" "}', body: { payload: ' ' } }), 'body', 400, 'NHCX-1013');
});

test('size: payload over the limit -> 400 NHCX-1007 (predicted)', () => {
  refused(call(mk({ maxPayloadBytes: 100 }), 'preauth/submit'), 'size', 400, 'NHCX-1007');
});

test('header: not 5 parts or not JSON -> 400 NHCX-1005', () => {
  const p = mk();
  refused(call(p, 'preauth/submit', {}, { payload: 'a.b.c' }), 'header', 400, 'NHCX-1005');
  refused(call(p, 'preauth/submit', {}, { payload: 'bm90IGpzb24.a.b.c.d' }), 'header', 400, 'NHCX-1005');
});

test('alg/enc other than RSA-OAEP-256/A256GCM -> NHCX-1005', () => {
  refused(call(mk(), 'preauth/submit', { alg: 'RSA-OAEP' }, { payload: H.base64Url(Buffer.from(JSON.stringify(Object.assign(H.himsHeader(), { alg: 'RSA-OAEP' })))) + '.a.b.c.d' }), 'alg', 400, 'NHCX-1005');
});

test('required headers: each missing field -> NHCX-1005; workflow_id required on forward sends only', () => {
  for (const k of ['x-hcx-sender_code', 'x-hcx-recipient_code', 'x-hcx-api_call_id', 'x-hcx-correlation_id', 'x-hcx-timestamp', 'x-hcx-status', 'x-hcx-workflow_id']) {
    const r = call(mk(), 'preauth/submit', { [k]: undefined });
    refused(r, 'required', 400, 'NHCX-1005');
    assert.match(r.checks[r.checks.length - 1].detail, new RegExp(k));
  }
});

test('uuid: api_call_id, correlation_id, request_id must be UUIDs -> NHCX-1005', () => {
  for (const k of ['x-hcx-api_call_id', 'x-hcx-correlation_id', 'x-hcx-request_id'])
    refused(call(mk(), 'preauth/submit', { [k]: 'abc-123' }), 'uuid', 400, 'NHCX-1005');
});

test('timestamp: unparseable, non-IST, stale and future -> NHCX-1005; epoch millis and +0530 accepted', () => {
  refused(call(mk(), 'preauth/submit', { 'x-hcx-timestamp': '24/11/2026 10:00' }), 'timestamp', 400, 'NHCX-1005');
  refused(call(mk(), 'preauth/submit', { 'x-hcx-timestamp': new Date().toISOString().replace(/\.\d+Z$/, 'Z') }), 'timestamp', 400, 'NHCX-1005');
  refused(call(mk(), 'preauth/submit', { 'x-hcx-timestamp': H.istStamp(Date.now() - 31 * 60000) }), 'timestamp', 400, 'NHCX-1005');
  refused(call(mk(), 'preauth/submit', { 'x-hcx-timestamp': H.istStamp(Date.now() + 6 * 60000) }), 'timestamp', 400, 'NHCX-1005');
  assert.strictEqual(call(mk(), 'preauth/submit', { 'x-hcx-timestamp': Date.now() }).ok, true);
  assert.strictEqual(call(mk(), 'preauth/submit', { 'x-hcx-timestamp': H.istStamp().replace('+05:30', '+0530') }).ok, true);
  assert.strictEqual(call(mk({ requireIst: false }), 'preauth/submit', { 'x-hcx-timestamp': new Date().toISOString() }).ok, true);
});

test('sender: unknown or inactive -> 400 NHCX-1002 (real, real sandbox traffic)', () => {
  refused(call(mk(), 'preauth/submit', { 'x-hcx-sender_code': '1000000077@hcx' }), 'sender', 400, 'NHCX-1002');
  const r = call(mk(), 'preauth/submit', { 'x-hcx-sender_code': '1000000009@hcx' });
  refused(r, 'sender', 400, 'NHCX-1002');
  assert.strictEqual(r.refusal.body.result.entity_type, 'preauthorization');
});

test('sender must be the token holder -> 401 NHCX-401', () => {
  refused(call(mk(), 'preauth/submit', { 'x-hcx-sender_code': '1518@hcx', 'x-hcx-recipient_code': HIMS }), 'senderToken', 401, 'NHCX-401');
});

test('recipient: unknown or inactive -> 400 NHCX-1003 (real, real sandbox traffic)', () => {
  const r = call(mk(), 'coverageeligibility/check', { 'x-hcx-recipient_code': '1000000077@hcx', 'x-hcx-workflow_id': '1' });
  refused(r, 'recipient', 400, 'NHCX-1003');
  assert.strictEqual(r.refusal.body.result.recipient_code, '1000000077@hcx');
  refused(call(mk(), 'claim/submit', { 'x-hcx-recipient_code': '1000000009@hcx' }), 'recipient', 400, 'NHCX-1003');
});

test('status: response.* on a submit, request.initiated on an on_*, unknown value -> NHCX-1011', () => {
  refused(call(mk(), 'preauth/submit', { 'x-hcx-status': 'response.complete' }), 'status', 400, 'NHCX-1011');
  refused(call(mk(), 'communication/on_request', {}), 'status', 400, 'NHCX-1011');
  refused(call(mk(), 'claim/submit', { 'x-hcx-status': 'whatever' }), 'status', 400, 'NHCX-1011');
});

test('ABHA header: empty and 14 digits pass (213 real sends accepted), other shapes -> NHCX-1018', () => {
  assert.strictEqual(call(mk(), 'preauth/submit', { 'x-hcx-ben-abha-id': '91123456789012' }).ok, true);
  assert.strictEqual(call(mk(), 'preauth/submit', { 'x-hcx-ben-abha-id': '91-1234-5678-9012' }).ok, true);
  refused(call(mk(), 'preauth/submit', { 'x-hcx-ben-abha-id': '12345' }), 'abha', 400, 'NHCX-1018');
});

test('api_call_id reused -> 202 carrying NHCX-1006, protocol_status request.queued (real, real sandbox traffic)', () => {
  const p = mk();
  const first = call(p, 'preauth/submit');
  assert.strictEqual(first.ok, true);
  const r = call(p, 'preauth/submit', { 'x-hcx-api_call_id': first.sent['x-hcx-api_call_id'] });
  refused(r, 'apiCallUnique', 202, 'NHCX-1006');
  assert.strictEqual(r.refusal.body.result.protocol_status, 'request.queued');
});

test('correlation_id: reuse by the same pair continues the conversation; another pair -> NHCX-1006', () => {
  const p = mk();
  const corr = crypto.randomUUID();
  assert.strictEqual(call(p, 'preauth/submit', { 'x-hcx-correlation_id': corr }).ok, true);
  assert.strictEqual(call(p, 'claim/submit', { 'x-hcx-correlation_id': corr, 'x-hcx-workflow_id': '15' }).ok, true);
  refused(call(p, 'preauth/submit', { 'x-hcx-correlation_id': corr, 'x-hcx-recipient_code': '1000003538@hcx' }), 'conversation', 202, 'NHCX-1006');
});

test('on_* must name a known correlation -> 400 NHCX-1010 (real, real sandbox traffic); a payer-opened one passes', () => {
  const p = mk();
  const r = call(p, 'paymentnotice/on_request', { 'x-hcx-status': 'response.complete', 'x-hcx-workflow_id': '17' });
  refused(r, 'onCorrelation', 400, 'NHCX-1010');
  assert.strictEqual(r.refusal.body.result.entity_type, 'payment');
  const corr = crypto.randomUUID();
  const viaLog = mk(undefined, { items: [{ responses: [{ header: { 'x-hcx-correlation_id': corr } }] }] });
  assert.strictEqual(call(viaLog, 'communication/on_request', { 'x-hcx-status': 'response.complete', 'x-hcx-correlation_id': corr }).ok, true);
  const opened = mk(); const c2 = crypto.randomUUID(); opened.opened(c2, '1518@hcx', HIMS);
  assert.strictEqual(call(opened, 'paymentnotice/on_request', { 'x-hcx-status': 'response.complete', 'x-hcx-correlation_id': c2 }).ok, true);
});

test('/v1/status must name a known api_call_id -> 400 NHCX-1012 (real, real sandbox traffic); the known one passes', () => {
  const p = mk();
  refused(call(p, 'status', { 'x-hcx-workflow_id': '1' }), 'statusApiCall', 400, 'NHCX-1012');
  const first = call(p, 'claim/submit');
  assert.strictEqual(call(p, 'status', { 'x-hcx-api_call_id': first.sent['x-hcx-api_call_id'], 'x-hcx-correlation_id': first.sent['x-hcx-correlation_id'] }).ok, true);
});

test('bodies: 202 ack and refusal match the real NHA shapes', () => {
  const h = H.himsHeader();
  const a = protocol.ackBody(h, 'preauth/submit');
  assert.match(a.timestamp, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  assert.deepStrictEqual(Object.keys(a), ['timestamp', 'api_call_id', 'correlation_id', 'result', 'error']);
  assert.strictEqual(a.error, null);
  assert.deepStrictEqual(a.result, { sender_code: HIMS, recipient_code: '1518@hcx', entity_type: 'preauthorization', protocol_status: 'request.queued' });
  const e = protocol.errorBody(h, 'claim/submit', 'NHCX-1003');
  assert.match(e.timestamp, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}:\d{3}$/);
  for (const [act, ent] of [['search/submit', 'preauth'], ['paymentnotice/on_request', 'payment'], ['task/submit', 'task'], ['status', 'status']])
    assert.strictEqual(protocol.entityType(act), ent);
  assert.strictEqual(protocol.nhaStamp(Date.UTC(2026, 10, 23, 8, 58, 30)), '23/11/2026 14:28:30');
});

test('disabled (PMJAY_PROTOCOL=off equivalent) lets everything through', () => {
  assert.strictEqual(mk({ enabled: false }).check({ action: 'preauth/submit', headers: {}, body: {} }).ok, true);
});

// ---------------------------------------------------------------- over HTTP
let app, port, lis, cert, token;
test.before(async () => {
  lis = H.listener();
  await new Promise(r => lis.server.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-proto-'));
  app = createApp({ port: 0, dataDir, callbackBase: 'http://127.0.0.1:' + lis.server.address().port, himsCertPem: kp.publicPem,
    himsCertPath: '/nonexistent', policiesPath: '/nonexistent', defaultDelayMs: 20, logToFile: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  token = await H.session(port);
  cert = (await H.request(port, 'POST', '/participanthcxservice/fetch/certs', { participantid: '1518@hcx' })).json.encryption_cert;
});
test.after(async () => { await app.idle(); await app.close(); await new Promise(r => lis.server.close(r)); });

test('HTTP: accepted send returns the real 202 shape and the log carries every check', async () => {
  const header = H.himsHeader({ workflowId: '1' });
  const r = await H.request(port, 'POST', '/hcx/v1/coverageeligibility/check', { payload: H.himsEncrypt('{"resourceType":"Bundle","entry":[]}', cert, header) }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.json.result.entity_type, 'coverageeligibility');
  assert.strictEqual(r.json.error, null);
  const list = (await H.request(port, 'GET', '/mock/messages')).json;
  const d = (await H.request(port, 'GET', '/mock/messages/' + list.find(x => x.correlationId === header['x-hcx-correlation_id']).id)).json;
  assert.ok(d.protocol.length >= 14 && d.protocol.every(c => c.ok));
  await app.idle();
});

test('HTTP: refusals return NHA status and body, are logged with the failing check, and reach no payer', async () => {
  lis.got.length = 0;
  const bad = H.himsHeader({ recipient: '1000000077@hcx' });
  const r = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload: H.himsEncrypt('{}', cert, bad) }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'NHCX-1003');
  const u = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload: H.himsEncrypt('{}', cert, H.himsHeader()) }, { bearer_auth: 'Bearer nope' });
  assert.strictEqual(u.status, 401);
  assert.strictEqual(u.json.error.code, 'NHCX-401');
  const list = (await H.request(port, 'GET', '/mock/messages')).json;
  const row = list.find(x => x.errorCode === 'NHCX-1003');
  const d = (await H.request(port, 'GET', '/mock/messages/' + row.id)).json;
  assert.strictEqual(d.protocol[d.protocol.length - 1].id, 'recipient');
  await app.idle();
  assert.strictEqual(lis.got.length, 0);
});

test('HTTP: same send twice -> second is 202 with NHCX-1006 and no second callback', async () => {
  lis.got.length = 0;
  const header = H.himsHeader({ workflowId: '1' });
  const payload = H.himsEncrypt('{"resourceType":"Bundle","entry":[]}', cert, header);
  const a = await H.request(port, 'POST', '/hcx/v1/coverageeligibility/check', { payload }, { bearer_auth: 'Bearer ' + token });
  const b = await H.request(port, 'POST', '/hcx/v1/coverageeligibility/check', { payload }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(a.status, 202); assert.strictEqual(a.json.error, null);
  assert.strictEqual(b.status, 202); assert.strictEqual(b.json.error.code, 'NHCX-1006');
  await app.idle();
  assert.strictEqual(lis.got.length, 1);
});

test('HTTP: /mock/protocol lists the catalogue and expires a token', async () => {
  const g = await H.request(port, 'GET', '/mock/protocol');
  assert.ok(g.json.checks.token && g.json.checks.onCorrelation);
  const t = await H.session(port);
  await H.request(port, 'POST', '/mock/protocol', { expireToken: t });
  const r = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload: H.himsEncrypt('{}', cert, H.himsHeader()) }, { bearer_auth: 'Bearer ' + t });
  assert.strictEqual(r.status, 401);
});
