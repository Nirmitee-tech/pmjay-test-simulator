'use strict';
// The mock answering as NHA's sandbox dummy payer 1000003538@hcx: a pre-auth waits until
// /process/request names a decision; Query comes back as communication/request; a claim approved
// that way can be paid through /paymentNotice/init.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const jwe = require('../src/server/jwe');
const H = require('./server.helpers');
const { createApp } = require('../src/server/app');

process.env.PMJAY_UNDELIVERED_MS = '50';   // the real 74 s delay, shortened for the test
const DUMMY = '1000003538@hcx';
const hims = H.keyPair();
let app, port, lis, cert, token;

test.before(async () => {
  lis = H.listener();
  await new Promise(r => lis.server.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-dummy-'));
  app = createApp({ port: 0, dataDir, callbackBase: 'http://127.0.0.1:' + lis.server.address().port,
    himsCertPem: hims.publicPem, himsCertPath: '/nonexistent', defaultDelayMs: 20, statusDelayMs: 50, logToFile: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  const c = await H.request(port, 'POST', '/participanthcxservice/fetch/certs', { participantid: DUMMY });
  assert.strictEqual(c.status, 200);
  cert = c.json.encryption_cert;
  token = await H.session(port);
});
test.after(async () => { await app.close(); await new Promise(r => lis.server.close(r)); });
test.beforeEach(async () => { await app.idle(); lis.got.length = 0; });

async function send(action, bundle, extra) {
  const header = H.himsHeader(Object.assign({ recipient: DUMMY }, extra || {}));
  const res = await H.request(port, 'POST', '/hcx/v1/' + action, { payload: H.himsEncrypt(JSON.stringify(bundle), cert, header) }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(res.status, 202);
  return header;
}
const opened = (g) => jwe.decrypt(JSON.parse(g.body).payload, hims.privatePem);

test('a pre-auth to the dummy payer waits; Query brings communication/request from the dummy payer', async () => {
  const h = await send('preauth/submit', H.preauthBundle());
  await app.idle();
  assert.strictEqual(lis.got.length, 0);
  const d = await H.request(port, 'POST', '/dummyhcxpayer/process/request', { action: 'Query', method: 'Preauth', correlationId: h['x-hcx-correlation_id'] });
  assert.strictEqual(d.status, 200);
  // the dummy payer's ack (a real sandbox answer of 2026-11-13)
  assert.match(d.json.timestamp, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}:\d{3}$/);
  assert.strictEqual(d.json.correlation_id, h['x-hcx-correlation_id']);
  assert.notStrictEqual(d.json.api_call_id, h['x-hcx-correlation_id']);
  assert.deepStrictEqual(d.json.result, { sender_code: '1000000001', recipient_code: DUMMY, entity_type: null, protocol_status: 'request.dispatched' });
  assert.strictEqual(d.json.error, null);
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/communication/request');
  const o = opened(got[0]);
  assert.strictEqual(o.header['x-hcx-sender_code'], DUMMY);
  assert.strictEqual(o.header['x-hcx-workflow_id'], '24');
  const qb = JSON.parse(o.payload);
  const types = qb.entry.map(e => e.resource.resourceType);
  assert.deepStrictEqual(types.slice(0, 4), ['Task', 'Organization', 'Claim', 'CommunicationRequest'], 'the dummy payer echoes the request Claim');
  const claim = qb.entry[2], cr = qb.entry[3].resource;
  assert.strictEqual(cr.basedOn[0].reference, claim.fullUrl);
  assert.strictEqual(cr.reasonCode[0].coding[0].code, 'ELIGVER');
  const again = await H.request(port, 'POST', '/dummyhcxpayer/process/request', { action: 'Approve', method: 'Preauth', correlationId: h['x-hcx-correlation_id'] });
  assert.strictEqual(again.status, 400, 'a finished conversation is refused');
  // SBX-004 as NHA sent it (a real sandbox answer of 2026-11-14)
  assert.strictEqual(again.json.api_call_id, h['x-hcx-correlation_id']);
  assert.deepStrictEqual(again.json.result, { sender_code: null, recipient_code: null, entity_type: null, protocol_status: 'request.error' });
  assert.deepStrictEqual(again.json.error, { code: 'SBX-004', message: 'No Request was Queued with given Correlation Id, please initiate new Request and Try again' });
});

test('claim approved through process/request, then paid through paymentNotice/init', async () => {
  const b = H.preauthBundle(30000);
  b.entry.find(e => e.resource.resourceType === 'Claim').resource.identifier = [{ system: 'https://nhcx.abdm.gov.in', value: 'A/9028/26' }];
  const h = await send('claim/submit', b);
  await H.request(port, 'POST', '/dummyhcxpayer/process/request', { action: 'Approve', method: 'Claim', correlationId: h['x-hcx-correlation_id'] });
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/claim/on_submit');
  assert.strictEqual(opened(got[0]).header['x-hcx-workflow_id'], '26', 'claim approve carries the dummy payer workflow 26');
  const cr = opened(got[0]).payload;
  const crb = JSON.parse(cr);
  assert.strictEqual(crb.entry[0].resource.resourceType, 'ClaimResponse');
  assert.strictEqual(crb.entry[0].resource.outcome, 'complete');
  assert.ok(crb.entry.some(e => e.resource.resourceType === 'Claim'), 'the request is echoed after the answer');
  const claimNo = JSON.parse(cr).entry.map(e => e.resource).find(r => r.resourceType === 'ClaimResponse').identifier.find(i => i.value).value;
  const p = await H.request(port, 'POST', '/dummyhcxpayer/paymentNotice/init', { providerId: '1000000001@hcx', claimNumber: claimNo });
  assert.strictEqual(p.status, 200);
  // init ack (a real sandbox answer of 2026-11-13): one id as api_call_id and correlation_id, request.queued
  assert.strictEqual(p.json.api_call_id, p.json.correlation_id);
  assert.deepStrictEqual(p.json.result, { sender_code: DUMMY, recipient_code: '1000000001@hcx', entity_type: null, protocol_status: 'request.queued' });
  const all = await lis.waitFor(2);
  assert.strictEqual(all[1].path, '/v1/paymentnotice/request');
  const ph = opened(all[1]).header;
  assert.strictEqual(ph['x-hcx-correlation_id'], p.json.correlation_id, 'the notice carries the id the init answered with');
  assert.strictEqual(ph['x-hcx-api_call_id'], p.json.correlation_id);
  assert.strictEqual(ph['x-hcx-workflow_id'], '31');
  assert.strictEqual(ph['x-hcx-recipient_code'], '1000000001@hcx');
  assert.ok(ph['x-hcx-timestamp'] < 1e11, 'dummy payer timestamps are epoch seconds (real sandbox traffic)');
  assert.strictEqual(claimNo, 'A/9028/26');
  const pnb = JSON.parse(opened(all[1]).payload);
  const pn = pnb.entry.map(e => e.resource).find(r => r.resourceType === 'PaymentNotice');
  assert.strictEqual(pn.identifier[0].value, 'A/9028/26');
});

test('a cover check to the dummy payer is answered at once', async () => {
  await send('coverageeligibility/check', { resourceType: 'Bundle', type: 'collection', entry: [] });
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/coverageeligibility/on_check');
  const cr = JSON.parse(opened(got[0]).payload).entry[0].resource;
  assert.strictEqual(cr.resourceType, 'CoverageEligibilityResponse');
  assert.strictEqual(cr.insurance[0].benefitPeriod.end, '2026-12-31T00:00:00+05:30');
  assert.strictEqual(cr.insurance[0].inforce, undefined, 'the dummy states no in-force flag');
});

test('paymentNotice/init for an unknown claim is refused', async () => {
  const p = await H.request(port, 'POST', '/dummyhcxpayer/paymentNotice/init', { claimNumber: 'NOPE/1' });
  assert.strictEqual(p.status, 400);
});

test('get/policies answers a captured list by identifier, and a named payer is searchable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-pol-'));
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, JSON.stringify({ 'MobileNo:1112223334': [{ sno: '1', payerid: '1000000099@hcx', productname: 'Test Plan' }] }));
  app.cfg.policiesPath = file;
  app.cfg.participantNames = { '1000000099@hcx': 'TEST INSURER' };
  const a = await H.request(port, 'POST', '/participanthcxservice/participant/get/policies', { identifiertype: 'MobileNo', identifiervalue: '1112223334' });
  assert.strictEqual(a.json[0].productname, 'Test Plan');
  const other = await H.request(port, 'POST', '/participanthcxservice/participant/get/policies', { identifiertype: 'MobileNo', identifiervalue: '5550000000' });
  assert.strictEqual(other.status, 400, 'an identifier not captured and not configured has no policy (NHCX-1016)');
  assert.strictEqual(other.json.error.code, 'NHCX-1016');
  const s = await H.request(port, 'POST', '/participanthcxservice/participant/search', { participant_code: '1000000099@hcx' });
  assert.strictEqual(s.json.participant_name, 'TEST INSURER');
});

test('replying to a dummy query approves the queried pre-auth without a drive', async () => {
  const h = await send('preauth/submit', H.preauthBundle());
  await H.request(port, 'POST', '/dummyhcxpayer/process/request', { action: 'Query', method: 'Preauth', correlationId: h['x-hcx-correlation_id'] });
  const q = await lis.waitFor(1);
  const qcorr = opened(q[0]).header['x-hcx-correlation_id'];
  await send2('communication/on_request', { resourceType: 'Bundle', entry: [] }, qcorr);
  const got = await lis.waitFor(2);
  assert.strictEqual(got[1].path, '/v1/preauth/on_submit');
  assert.strictEqual(opened(got[1]).header['x-hcx-correlation_id'], h['x-hcx-correlation_id']);
  assert.strictEqual(opened(got[1]).header['x-hcx-workflow_id'], '21', 'pre-auth approve carries workflow 21');
});
async function send2(action, bundle, corr) {
  // a reply on an on_* path carries a response status (the reference HIMS), on the payer's correlation
  const header = H.himsHeader({ recipient: DUMMY, correlationId: corr, status: 'response.complete' });
  const res = await H.request(port, 'POST', '/hcx/v1/' + action, { payload: H.himsEncrypt(JSON.stringify(bundle), cert, header) }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(res.status, 202);
}

test('a status request to the dummy payer is answered by NHA on /v1/on_status (3 of 3 on 2 Nov 2026)', async () => {
  // The HIMS's RequestStatus resends under the earlier request's api_call_id; a fresh one is NHCX-1012
  const prior = await send('coverageeligibility/check', { resourceType: 'Bundle', entry: [] });
  await app.idle(); lis.got.length = 0;
  await send('status', { resourceType: 'Bundle', entry: [] }, { apiCallId: prior['x-hcx-api_call_id'], correlationId: prior['x-hcx-correlation_id'] });
  const got = await lis.waitFor(1, 3000);
  assert.strictEqual(got[0].path, '/v1/on_status');
  assert.strictEqual(JSON.parse(got[0].body)['x-hcx-entity-type'], 'coverageeligibility');
});

test('a plan request to the dummy payer gets its InsurancePlan, workflow 5', async () => {
  await send('insuranceplan/request', { resourceType: 'Bundle', entry: [] });
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/insuranceplan/on_request');
  const o = opened(got[0]);
  assert.strictEqual(o.header['x-hcx-workflow_id'], '5');
  assert.strictEqual(JSON.parse(o.payload).entry[0].resource.resourceType, 'InsurancePlan');
});

test('Reject comes back as the dummy sends it: outcome complete, eligible 0, workflow 23', async () => {
  const rb = H.preauthBundle();
  rb.entry.find(e => e.resource.resourceType === 'Claim').resource.item = [{ sequence: 1, net: { value: 5000, currency: 'INR' } }];
  const h = await send('preauth/submit', rb);
  await H.request(port, 'POST', '/dummyhcxpayer/process/request', { action: 'Reject', method: 'Preauth', correlationId: h['x-hcx-correlation_id'] });
  const got = await lis.waitFor(1);
  const o = opened(got[0]);
  assert.strictEqual(o.header['x-hcx-workflow_id'], '23');
  const cr = JSON.parse(o.payload).entry[0].resource;
  assert.strictEqual(cr.outcome, 'complete');
  assert.strictEqual(cr.total[0].amount.value, 0);
  assert.strictEqual(cr.item[0].adjudication[0].reason.text, 'ClaimError-1');
});

test('a request to a registry payer with no system comes back as NHCX-1001 on /v1/error/response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-reg-'));
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ 'MobileNo:1': [{ payerid: '1000004805@hcx', processingid: '1000004805@hcx' }] }));
  app.cfg.policiesPath = path.join(dir, 'p.json');
  const c = await H.request(port, 'POST', '/participanthcxservice/fetch/certs', { participantid: '1000004805@hcx' });
  assert.strictEqual(c.status, 200);
  const tok = (await H.request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'x', clientSecret: 'y', grantType: 'client_credentials' })).json.accessToken;
  const header = H.himsHeader({ recipient: '1000004805@hcx' });
  const res = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload: H.himsEncrypt(JSON.stringify(H.preauthBundle()), c.json.encryption_cert, header) }, { bearer_auth: 'Bearer ' + tok });
  assert.strictEqual(res.status, 202);
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/error/response');
  const o = jwe.decrypt(JSON.parse(got[0].body).payload, hims.privatePem);
  assert.strictEqual(o.header['x-hcx-recipient_code'], '1000004805@hcx');
  assert.strictEqual(JSON.parse(o.payload)['x-hcx-error_details'].code, 'NHCX-1001');
  assert.strictEqual(JSON.parse(o.payload)['x-hcx-api_call_id'], header['x-hcx-api_call_id'], 'the body names the original send');
  assert.notStrictEqual(o.header['x-hcx-api_call_id'], header['x-hcx-api_call_id'], 'the header carries a new api_call_id');
});
