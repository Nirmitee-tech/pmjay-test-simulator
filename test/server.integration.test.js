'use strict';
// End to end over real sockets: session, fetch/certs, an encrypted preauth/submit, and the
// callback received and decrypted on a local listener standing in for the HIMS.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const jwe = require('../src/server/jwe');
const H = require('./server.helpers');
const { createApp } = require('../src/server/app');

const hims = H.keyPair();
let app, port, lis, token, payerCert;

test.before(async () => {
  lis = H.listener();
  await new Promise(r => lis.server.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjaymock-'));
  app = createApp({ port: 0, dataDir, callbackBase: 'http://127.0.0.1:' + lis.server.address().port,
    himsCertPem: hims.publicPem, himsCertPath: '/nonexistent', policiesPath: '/nonexistent', defaultDelayMs: 50, logToFile: true });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
});
test.after(async () => { await app.close(); await new Promise(r => lis.server.close(r)); });
test.beforeEach(async () => { await app.idle(); lis.got.length = 0; await H.request(port, 'POST', '/mock/fault', { reset: true }); await H.request(port, 'POST', '/mock/scenario', { scenario: 'auto' }); });

async function submit(extraHeaders, cert) {
  const header = H.himsHeader();
  const payload = H.himsEncrypt(JSON.stringify(H.preauthBundle()), cert || payerCert, header);
  const res = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload }, Object.assign({ bearer_auth: 'Bearer ' + token }, extraHeaders || {}));
  return { header, res };
}

test('session and registry answer in the shapes the HIMS reads', async () => {
  const s = await H.request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'x', clientSecret: 'y', grantType: 'client_credentials' });
  assert.strictEqual(s.status, 200);
  assert.ok(s.json.accessToken);
  assert.strictEqual(s.json.expiresIn, 1200);
  token = s.json.accessToken;
  const c = await H.request(port, 'POST', '/participanthcxservice/fetch/certs', { participantid: '1518@hcx' }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(c.status, 200);
  assert.match(c.json.encryption_cert, /BEGIN (CERTIFICATE|PUBLIC KEY)/);
  payerCert = c.json.encryption_cert;
  // fetch/certs: {encryption_cert (CRLF), participant_name, participant_id} (a real sandbox answer of 2026-11-20)
  assert.deepStrictEqual(Object.keys(c.json).sort(), ['encryption_cert', 'participant_id', 'participant_name']);
  assert.ok(c.json.encryption_cert.includes('\r\n'));
  assert.strictEqual(c.json.participant_id, '1518@hcx');
  // participant/search: one flat object (a real sandbox answer of 2026-11-20)
  const sr = await H.request(port, 'POST', '/participanthcxservice/participant/search', { participant_code: '1518@hcx' }, { bearer_auth: 'Bearer ' + token });
  assert.strictEqual(sr.json.participant_code, '1518@hcx');
  assert.strictEqual(sr.json.participant_name, 'SHA HP');
  assert.strictEqual(sr.json.participant_id, 1000000544);
  assert.strictEqual(sr.json.status, 1);
  assert.strictEqual(sr.json.participants, undefined);
  assert.match(sr.json.encryption_cert, /fetched using the \/fetch\/certs API/);
  assert.strictEqual(sr.json.primary_mobile, 9000000000, 'phones are fakes');
  // get/policies: the sandbox member matches (190331336); an unknown mobile is HTTP 400 NHCX-1016 (190325676)
  const pol = await H.request(port, 'POST', '/participanthcxservice/participant/get/policies', { identifiertype: 'MemberId', identifiervalue: 'SBXSTG269' });
  assert.strictEqual(pol.status, 200);
  assert.deepStrictEqual(pol.json[0], { sno: '197610919', abhanumber: '91000000000000', mobilenumber: '9000000000', memberid: 'SBXSTG269',
    payerid: '1518@hcx', productid: 'PMJAY/HP/S/G', productname: 'PMJAY for Himachal', processingid: '1518@hcx' });
  const none = await H.request(port, 'POST', '/participanthcxservice/participant/get/policies', { identifiertype: 'MobileNo', identifiervalue: '9000000001' });
  assert.strictEqual(none.status, 400);
  assert.deepStrictEqual(none.json.error, { code: 'NHCX-1016', message: 'No policies found for given beneficiary MobileNo: 9000000001.' });
  assert.match(none.json.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
  const list = await H.request(port, 'POST', '/participanthcxservice/fetch/participants/list', { role: 'PAYER', fromdate: '01/01/2020', todate: '31/12/2030' });
  assert.deepStrictEqual(Object.keys(list.json.participantdetails[0]), ['participantcode', 'participantname', 'address', 'state']);
});

// NHA's real lists, 12 Nov 2026 (fixtures/registry): 1518@hcx only in the government list.
test('fetch/participants/list: PAYER without gov is the 202 real rows without 1518, gov is the 49 with it', async () => {
  const body = { role: 'PAYER', fromdate: '01/01/2020', todate: '31/12/2030' };
  const plain = (await H.request(port, 'POST', '/participanthcxservice/fetch/participants/list', body)).json.participantdetails;
  assert.strictEqual(plain.length, 202);
  assert.ok(!plain.some(r => r.participantcode === '1518@hcx'));
  assert.ok(plain.some(r => r.participantname === '5ecare'));
  const gov = (await H.request(port, 'POST', '/participanthcxservice/fetch/participants/list', Object.assign({ entitytype: 'gov' }, body))).json.participantdetails;
  assert.strictEqual(gov.length, 49);
  assert.deepStrictEqual(gov.find(r => r.participantcode === '1518@hcx'), { participantcode: '1518@hcx', participantname: 'SHA HP', address: null, state: 'Himachal Pradesh' });
});

test('preauth/submit: 202 ack, then an encrypted on_submit on the listener', async () => {
  const { header, res } = await submit();
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.json.correlation_id, header['x-hcx-correlation_id']);
  const got = await lis.waitFor(1);
  assert.strictEqual(got[0].path, '/v1/preauth/on_submit');
  const body = JSON.parse(got[0].body);
  const opened = jwe.decrypt(body.payload, hims.privatePem);
  assert.strictEqual(opened.header['x-hcx-correlation_id'], header['x-hcx-correlation_id']);
  // header as 1518's queued answer, fixture two-packages-preauth
  assert.strictEqual(opened.header['x-hcx-sender_code'], '1518');
  assert.strictEqual(opened.header['x-hcx-recipient_code'], '1000000001');
  assert.strictEqual(typeof opened.header['x-hcx-timestamp'], 'number');
  assert.strictEqual(opened.header['x-hcx-timestamp'] % 1000, 0);
  assert.strictEqual(opened.header['x-hcx-status'], 'response.partial');
  assert.strictEqual(opened.header['x-hcx-workflow_id'], '20');
  assert.deepStrictEqual(opened.header['x-hcx-error_details'], { trace: null, code: '100', message: 'Message Submitted' });
  assert.strictEqual(opened.header['x-hcx-debug_flag'], 'INFO');
  assert.notStrictEqual(opened.header['x-hcx-api_call_id'], header['x-hcx-api_call_id']);
  for (const k of ['x-hcx-request_id', 'x-hcx-use_case', 'x-hcx-ben-abha-id']) assert.ok(!(k in opened.header), k);
  assert.strictEqual(JSON.parse(opened.payload).resourceType, 'Bundle');
  const list = (await H.request(port, 'GET', '/mock/messages')).json;
  const detail = (await H.request(port, 'GET', '/mock/messages/' + list[0].id)).json;
  assert.strictEqual(detail.requestBundle.resourceType, 'Bundle');
  assert.ok(detail.responses && detail.responses[0].bundle);
});

test('missing bearer_auth is a 401', async () => {
  const payload = H.himsEncrypt('{}', payerCert, H.himsHeader());
  const r = await H.request(port, 'POST', '/hcx/v1/preauth/submit', { payload });
  assert.strictEqual(r.status, 401);
});

test('fault http503 answers 503 and sends nothing', async () => {
  await H.request(port, 'POST', '/mock/fault', { http503: true });
  const { res } = await submit();
  assert.strictEqual(res.status, 503);
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(lis.got.length, 0);
});

test('fault noCallback acknowledges and never calls back', async () => {
  await H.request(port, 'POST', '/mock/fault', { noCallback: true });
  const { res } = await submit();
  assert.strictEqual(res.status, 202);
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(lis.got.length, 0);
});

test('fault duplicateCallback delivers the same body twice', async () => {
  await H.request(port, 'POST', '/mock/fault', { duplicateCallback: true });
  await submit();
  const got = await lis.waitFor(2);
  assert.strictEqual(got[0].body, got[1].body);
});

test('fault truncatedJwe sends a payload with fewer than 5 parts', async () => {
  await H.request(port, 'POST', '/mock/fault', { truncatedJwe: true });
  await submit();
  const got = await lis.waitFor(1);
  assert.throws(() => jwe.decrypt(JSON.parse(got[0].body).payload, hims.privatePem));
});

test('fault slow delays the synchronous answer', async () => {
  await H.request(port, 'POST', '/mock/fault', { slow: 400 });
  const t = Date.now();
  await submit();
  assert.ok(Date.now() - t >= 380);
});

test('a request encrypted to another certificate comes back as a bare PAYR-1001 error (shape of real sandbox traffic)', async () => {
  const other = H.keyPair();
  const { res, header } = await submit({}, other.publicPem);
  assert.strictEqual(res.status, 202);
  const got = await lis.waitFor(1);
  const body = JSON.parse(got[0].body);
  assert.strictEqual(body.payload, undefined);
  assert.strictEqual(body.type, 'ProtocolResponse');
  assert.strictEqual(body['x-hcx-error_details'].code, 'PAYR-1001');
  assert.strictEqual(body['x-hcx-error_details'].message, 'Error occurred while decrypting payload for receiver code (1518@hcx) with correlation id (' + header['x-hcx-correlation_id'] + ').');
  assert.strictEqual(body['x-hcx-correlation_id'], header['x-hcx-correlation_id']);
  assert.notStrictEqual(body['x-hcx-api_call_id'], header['x-hcx-api_call_id']);
  assert.strictEqual(body['x-hcx-sender_code'], '1518@hcx');
  assert.strictEqual(body['x-hcx-recipient_code'], '1000000001');
  assert.match(body['x-hcx-timestamp'], /^\d{10}$/);
  assert.strictEqual(body['x-hcx-entity-type'], 'preauth');
});

test('manual desk: the queued answer comes, the pre-auth waits, then the desk decision is sent', async () => {
  const { header } = await submit({ 'X-Mock-Scenario': 'manual' });
  const q = await lis.waitFor(1);
  assert.strictEqual(jwe.decrypt(JSON.parse(q[0].body).payload, hims.privatePem).header['x-hcx-workflow_id'], '20');
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(lis.got.length, 1, 'no decision without the desk');
  // earlier tests in auto leave their pre-auths waiting for review too, so find this one by correlation
  const mine = () => H.request(port, 'GET', '/mock/pending').then(r => r.json.filter(x => x.correlationId === header['x-hcx-correlation_id']));
  const pending = await mine();
  assert.strictEqual(pending.length, 1);
  const d = await H.request(port, 'POST', '/mock/desk/' + pending[0].id, { decision: 'partial', amount: 1000 });
  assert.strictEqual(d.status, 200);
  const got = await lis.waitFor(2);
  const opened = jwe.decrypt(JSON.parse(got[1].body).payload, hims.privatePem);
  assert.strictEqual(opened.header['x-hcx-correlation_id'], header['x-hcx-correlation_id']);
  assert.strictEqual(opened.header['x-hcx-workflow_id'], '21');
  assert.strictEqual((await mine()).length, 0);
});

test('manual desk query comes back on preauth/on_submit, outcome queried, workflow 24 (fixture preauth-queried)', async () => {
  const { header } = await submit({ 'X-Mock-Scenario': 'manual' });
  await lis.waitFor(1);
  const pending = (await H.request(port, 'GET', '/mock/pending')).json.filter(x => x.correlationId === header['x-hcx-correlation_id']);
  await H.request(port, 'POST', '/mock/desk/' + pending[0].id, { decision: 'query', note: 'Send the discharge summary.' });
  const got = await lis.waitFor(2);
  assert.strictEqual(got[1].path, '/v1/preauth/on_submit');
  const opened = jwe.decrypt(JSON.parse(got[1].body).payload, hims.privatePem);
  assert.strictEqual(opened.header['x-hcx-correlation_id'], header['x-hcx-correlation_id']);
  assert.strictEqual(opened.header['x-hcx-workflow_id'], '24');
  const cr = JSON.parse(opened.payload).entry.find(e => e.resource.resourceType === 'ClaimResponse').resource;
  assert.strictEqual(cr.outcome, 'partial');
});

test('the log is written to data/log.jsonl', async () => {
  const text = fs.readFileSync(path.join(app.cfg.dataDir, 'log.jsonl'), 'utf8');
  assert.ok(text.split('\n').filter(Boolean).length > 0);
});

test('the page at / is served with the scenario picker, fault switches and message list', async () => {
  // Checks the page is served and wired to the endpoints it calls; it does not drive a browser.
  const r = await H.request(port, 'GET', '/');
  assert.strictEqual(r.status, 200);
  for (const id of ['id="scenario"', 'data-f="http503"', 'data-f="noCallback"', 'id="rows"', "'/mock/desk/'", "'/mock/messages'"])
    assert.ok(r.text.includes(id), 'page lacks ' + id);
  const cfg = (await H.request(port, 'GET', '/mock/config')).json;
  assert.strictEqual(cfg.himsCertLoaded, true);
});

// A lane's clean start between specs: the engine forgets its cases (so PAYR-1238 from the last spec's open
// pre-auth on SBXSTG269 does not carry over) and the chosen scenario stays.
test('POST /mock/cases/reset clears the cases and keeps the scenario', async () => {
  await H.request(port, 'POST', '/mock/scenario', { scenario: 'manual' });
  await submit();
  const r = await H.request(port, 'POST', '/mock/cases/reset', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.cases, 0);
  assert.strictEqual(r.json.scenario, 'manual');
  assert.strictEqual((await H.request(port, 'GET', '/mock/pending')).json.length, 0);
  await H.request(port, 'POST', '/mock/scenario', { scenario: 'auto' });
});
