'use strict';
// pmjaymock HTTP server: NHA's session, registry and /v1/* use-case endpoints, the PMJAY payer
// 1518@hcx behind them, the presence and face-auth stubs, and the tester's /mock/* controls.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const configMod = require('./config');
const keys = require('./keys');
const jwe = require('./jwe');
const actions = require('./actions');
const bridge = require('./bridge');
const callbacks = require('./callbacks');
const { MessageLog } = require('./log');
const protocol = require('./protocol');   // NHA protocol checks (hook)
const timing = require('./timing');       // callback delays (hook)

const UI_DIR = path.join(configMod.ROOT, 'ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fault switches, all off by default. POST /mock/fault {"<name>": true}, {"reset": true}.
const FAULTS = {
  http503: false, slowMs: 0, noCallback: false, duplicateCallback: false, truncatedJwe: false,
  http500: false,              // Spring 500 JSON, chunked (a real sandbox answer of 2026-11-09; 158 rows like it to 24 Nov)
  noHealthyUpstream: false,    // 503 "no healthy upstream" (a real sandbox answer of 2026-11-09, /v1/status)
  upstreamConnectError: false, // 503 envoy "upstream connect error" (a real sandbox answer of 2026-11-13, get/policies)
  jwePayloadWrapper: false,    // callback body {"type":"JWEPayload","payload":...} (seen on 4 of 24 1518 callbacks, 20 Nov)
  chunkedCallback: false,      // callback with Transfer-Encoding chunked and no Content-Length (predicted, see README)
  sessionRefuse: false,        // session refuses the credentials (body predicted, see README)
};
const BOOL_FAULTS = Object.keys(FAULTS).filter(k => k !== 'slowMs');

/** The delay that keeps a request's answers in order: never before the one already due for it, plus 100 ms. Pure. */
function orderedDelay(now, delayMs, lastDueAt) {
  const d = Math.max(0, Number(delayMs) || 0);
  return lastDueAt != null && lastDueAt >= now + d ? lastDueAt - now + 100 : d;
}

function createApp(over) {
  const cfg = configMod.load(over);
  const kp = keys.ensure(cfg.dataDir, cfg.payerCode);
  const log = new MessageLog(cfg.dataDir, cfg.logToFile);
  const state = {
    scenario: 'auto',
    faults: Object.assign({}, FAULTS),
    tokens: new Set(),
    registry: new Map(),        // participant code -> record (certs the HIMS registers through participant/update)
    timers: new Set(),
    inflight: 0,
    dummyQueries: new Map(),    // dummy payer query correlation id -> log id of the pre-auth or claim it queried
    decisionDelayMs: cfg.decisionDelayMs,
  };
  const proto = protocol.create({ participant: c => participant(c), log, providerCode: cfg.providerCode, settings: cfg.protocol });
  const timer = timing.create(timing.initialFrom(over));

  function himsCert() {
    const reg = state.registry.get(cfg.providerCode);
    if (reg && reg.encryption_cert) return reg.encryption_cert;
    if (cfg.himsCertPem) return cfg.himsCertPem;
    try { return fs.readFileSync(cfg.himsCertPath, 'utf8'); }
    catch (e) { return null; }
  }

  function participant(code) {
    const c = String(code || '');
    const bare = c.replace(/@hcx$/i, '');
    if (bare === cfg.payerCode.replace(/@hcx$/i, '')) {
      // 1518's registry record as NHA answered it (a real sandbox answer of 2026-11-20): name, id, state, schemes, endpoint.
      return { participant_id: 1000000544, participant_code: cfg.payerCode, participant_name: cfg.payerName, status: 'Active',
        roles: ['payor'], role_code: ['10002'], scheme_code: ['PMJAY/HP/S/G', 'PMJAY/HP/RSBY/G', 'PMJAY/HP/VVS/G', 'PMJAY'],
        endpoint_url: 'https://apisbeta.nha.gov.in/pmjay/hcx/bridgeexthcxpayer', signing_cert_path: 'string',
        encryption_cert: kp.certPem, state: 'Himachal Pradesh', district: null };
    }
    if (cfg.dummyPayerCode && bare === cfg.dummyPayerCode.replace(/@hcx$/i, '')) {
      return { participant_code: cfg.dummyPayerCode, participant_name: 'NHA dummy payer (mock)', status: 'Active',
        roles: ['payor'], role_code: ['10002'], endpoint_url: 'http://pmjaymock.local',
        encryption_cert: kp.certPem, state: 'Test State', district: 'Test District' };
    }
    if (bare === cfg.providerCode.replace(/@hcx$/i, '')) {
      const reg = state.registry.get(cfg.providerCode) || {};
      return Object.assign({ participant_code: cfg.providerCode, participant_name: 'HIMS provider (mock record)', status: 'Active',
        roles: ['provider'], role_code: ['10001'], endpoint_url: cfg.callbackBase, primary_mobile: '9999999999',
        primary_email: 'test@example.invalid', state: 'Test State', district: 'Test District', signing_cert_path: 'www.test.com/encryption.cert' },
        reg, { encryption_cert: himsCert() || '' });
    }
    const named = (cfg.participantNames && (cfg.participantNames[c] || cfg.participantNames[bare + '@hcx'])) || (capturedPayers().has(bare) ? '' : null);
    if (named != null) return { participant_code: bare + '@hcx', participant_name: named, status: 'Active', roles: ['payor'], role_code: ['10002'],
      endpoint_url: 'http://pmjaymock.local', encryption_cert: kp.certPem };
    return null;
  }
  // Payers on NHA's captured policy lists are registered on NHA's sandbox (1000004805@hcx drew a real NHCX-1001 on 2 Nov).
  function capturedPayers() {
    const out = new Set();
    try { const d = JSON.parse(fs.readFileSync(cfg.policiesPath, 'utf8'));
      for (const k of Object.keys(d)) for (const r of d[k] || []) for (const f of ['payerid', 'processingid']) if (r && r[f]) out.add(String(r[f]).replace(/@hcx$/i, '')); }
    catch (_) {}
    return out;
  }
  // NHA's real participant lists (fixtures/registry); null when the file is missing, and the minimal list is used.
  function registryList(file) {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/registry', file), 'utf8')).participantdetails || null; }
    catch (_) { return null; }
  }
  function capturedPolicies(type, value) {
    try { const d = JSON.parse(fs.readFileSync(cfg.policiesPath, 'utf8')); const r = d[type + ':' + value]; return Array.isArray(r) && r.length ? r : null; }
    catch (_) { return null; }
  }
  // participant/search as NHA answers it: one flat object, numeric status 1, a placeholder where the certificate
  // would be (a real sandbox answer of 2026-11-20, 1518@hcx). The phones and e-mail are fakes, never the registry's.
  function searchView(rec) {
    const id = rec.participant_id != null ? rec.participant_id : (/^\d+$/.test(callbacks.bare(rec.participant_code)) ? Number(callbacks.bare(rec.participant_code)) : null);
    return {
      participant_id: id, participant_code: rec.participant_code, participant_name: rec.participant_name, address: null,
      primary_email: 'test@example.invalid', additional_email: null, phone: 9000000000, primary_mobile: 9000000000, additional_mobile: null,
      status: 1, signing_cert_path: rec.signing_cert_path || 'string',
      encryption_cert: 'The encryption certificate is available and can be fetched using the /fetch/certs API.',
      endpoint_url: rec.registered_endpoint_url || rec.endpoint_url || null, registry_id: null, state: rec.state || null, district: rec.district || null,
      authentication_applicable: 'N', role_code: rec.role_code || [], scheme_code: rec.scheme_code || [],
    };
  }
  // A policy row with no personal data: the identifier the HIMS asked with is echoed, any other phone or ABHA is a fake.
  function maskPolicy(row, type, value) {
    const r = Object.assign({}, row);
    if ('mobilenumber' in r) r.mobilenumber = type === 'MobileNo' ? value : '9000000000';
    if ('abhanumber' in r) r.abhanumber = type === 'AbhaNumber' ? value : '91000000000000';
    if ('sno' in r) r.sno = String(r.sno);
    return r;
  }
  function knownHolder(type, value) {
    if (type === 'MemberId' && cfg.policyMembers.includes(value)) return true;
    return cfg.policyHolders.includes(type + ':' + value);
  }

  // ------------------------------------------------------------------ helpers
  function send(res, status, obj, headers) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'Content-Type': typeof obj === 'string' ? 'text/plain' : 'application/json',
      'Content-Length': Buffer.byteLength(text) }, headers || {}));
    res.end(text);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function parse(text) { try { return text ? JSON.parse(text) : {}; } catch (_) { return null; } }
  function ackBody(h, action) { return protocol.ackBody(h, action); }   // NHA's real 202 shape (protocol.js)
  function later(ms, fn) {
    const t = setTimeout(async () => {
      state.timers.delete(t); state.inflight++;
      try { await fn(); } finally { state.inflight--; }
    }, Math.max(0, ms || 0));
    state.timers.add(t);
  }
  function outcomeOf(cb) {
    if (!cb) return '';
    if (cb.error && cb.error.code) return 'error';
    const entries = (cb.bundle && cb.bundle.entry) || [];
    for (const e of entries) {
      const r = e && e.resource;
      if (r && (r.resourceType === 'ClaimResponse' || r.resourceType === 'CoverageEligibilityResponse') && r.outcome) return r.outcome;
      if (r && r.resourceType === 'Communication') return 'query';
    }
    return cb.hcxStatus || '';
  }

  // ------------------------------------------------------------------ callbacks
  function schedule(entry, cb, reqInfo, extraFaults) {
    const faults = Object.assign({}, state.faults, extraFaults || {});
    // One request's answers leave in the order they were made. A desk decision made while the queued answer still
    // waited (random 3 to 10 s) went first, and the queued answer, eligible 0 on every item, landed on the HIMS after the
    // approval and set the lines it claims at 0 ("MC011A has no amount", A/9026/26, 25 Nov 2026). 1518 sent its
    // queued answer in about 6 s and decided minutes to days later (real sandbox traffic), so it never arrived the other way.
    const now = Date.now();
    const delay = orderedDelay(now, cb.delayMs == null ? cfg.defaultDelayMs : cb.delayMs, entry._lastDueAt);
    entry._lastDueAt = now + delay;
    later(delay, async () => {
      const cert = himsCert();
      const rec = { action: cb.action, at: new Date().toISOString(), hcxStatus: cb.hcxStatus, error: cb.error || null, bundle: cb.bundle };
      // a ProtocolResponse goes as plain JSON, so it needs no the HIMS certificate
      if (!cert && !callbacks.isProtocolResponse(cb.bundle)) {
        rec.deliveries = [{ status: 0, error: 'No the HIMS certificate: set PMJAY_HIMS_CERT or let the HIMS call participant/update.' }];
      } else {
        try {
          const d = await callbacks.deliver({ cb, req: reqInfo, cfg, himsCertPem: cert, faults });
          Object.assign(rec, { url: d.url, header: d.header, truncated: d.truncated, deliveries: d.deliveries });
        } catch (e) { rec.deliveries = [{ status: 0, error: 'encrypt or send failed: ' + e.message }]; }
      }
      entry.responses = entry.responses || [];
      entry.responses.push(rec);
      const ok = (rec.deliveries || []).some(x => x.status >= 200 && x.status < 300);
      log.update(entry.id, { responses: entry.responses, delivered: ok, deliveryError: ok ? '' : ((rec.deliveries || [])[0] || {}).error || ('HTTP ' + ((rec.deliveries || [])[0] || {}).status) });
    });
  }

  // A payer that cannot open the request answers PAYR-1001 as a plain ProtocolResponse, shaped as real sandbox traffic
  // (dummy payer, 21 Oct 2026): sender the code the request was addressed to, recipient the bare provider code,
  // a fresh api_call_id, timestamp epoch seconds as a string. Its workflow_id was a UUID of unknown origin; the
  // mock puts a fresh one there.
  function sendProtocolError(entry, reqInfo, action, onAction) {
    const corr = reqInfo.correlationId || null;
    const to = reqInfo.recipient || cfg.payerCode;
    const body = { type: 'ProtocolResponse', 'x-hcx-sender_code': to, 'x-hcx-recipient_code': callbacks.bare(reqInfo.sender || cfg.providerCode),
      'x-hcx-api_call_id': crypto.randomUUID(), 'x-hcx-correlation_id': corr, 'x-hcx-workflow_id': crypto.randomUUID(),
      'x-hcx-timestamp': String(Math.floor(Date.now() / 1000)), 'x-hcx-debug_flag': null, 'x-hcx-status': 'response.error', 'x-hcx-redirect_to': null,
      'x-hcx-error_details': { code: 'PAYR-1001', message: 'Error occurred while decrypting payload for receiver code (' + to + ') with correlation id (' + corr + ').', trace: null },
      'x-hcx-debug_details': null, 'x-hcx-domain-header': null, 'x-hcx-entity-type': String(action).split('/')[0], 'x-hcx-ben-abha-id': null };
    schedule(entry, { action: onAction, delayMs: cfg.defaultDelayMs, bundle: body, hcxStatus: 'response.error', error: body['x-hcx-error_details'] }, reqInfo);
  }

  // ------------------------------------------------------------------ exchange failures (fault switches)
  // NHA's service behind each /v1 path, from the "path" of real Spring 500 bodies (real sandbox bodies, Sep to Nov 2026).
  const SERVICE = { coverageeligibility: 'coverageeligibilityhcxservice', preauth: 'preauthhcxservice', claim: 'claimhcxservice', paymentnotice: 'servicehcxpayment' };
  function spring500(res, action) {
    const entity = String(action).split('/')[0];
    const body = JSON.stringify({ timestamp: Date.now(), status: 500, error: 'Internal Server Error',
      path: '/' + (SERVICE[entity] || entity + 'hcxservice') + '/v1/' + action });   // services other than the four seen are predicted
    res.writeHead(500, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });   // real 500 was chunked (real sandbox traffic)
    res.write(body); res.end();
    return true;
  }
  function upstreamFault(res) {
    if (state.faults.noHealthyUpstream) { send(res, 503, 'no healthy upstream'); return true; }
    if (state.faults.upstreamConnectError) {
      send(res, 503, 'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: 111');
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ /v1/status
  // NHA answers a JWE status request 202 with every field null, then about a second later posts a plain
  // ProtocolResponse to /v1/on_status: sender and recipient both the HIMS's code, the asked-about api_call_id and
  // correlation_id, status request.dispatched, NHCX-1019, timestamp seconds as a string, entity-type the asked
  // request's entity (a real sandbox answer of 2026-11-13, real sandbox traffic). Until 21 Oct 2026 the
  // same answer carried NHCX-1012 (111 rows); POST /mock/protocol {"statusAnswerCode": "NHCX-1012"} selects it.
  function statusAnswer(res, h, reqInfo) {
    const asked = log.items.find(e => e.kind === 'request' && e.action !== 'status' && e.apiCallId === reqInfo.apiCallId);
    const entry = log.add({ kind: 'request', action: 'status', correlationId: reqInfo.correlationId || '', apiCallId: reqInfo.apiCallId || '',
      sender: reqInfo.sender || '', recipient: reqInfo.recipient || '', requestHeader: h, outcome: 'acknowledged', reqInfo });
    send(res, 202, { timestamp: null, api_call_id: null, correlation_id: null, result: null, error: null });
    if (state.faults.noCallback) return;
    const me = reqInfo.sender || cfg.providerCode;
    const body = { 'x-hcx-sender_code': me, 'x-hcx-recipient_code': me, 'x-hcx-api_call_id': reqInfo.apiCallId || null,
      'x-hcx-correlation_id': reqInfo.correlationId || null, 'x-hcx-workflow_id': null, 'x-hcx-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-hcx-debug_flag': null, 'x-hcx-status': 'request.dispatched', 'x-hcx-redirect_to': null,
      'x-hcx-error_details': { code: proto.settings.statusAnswerCode || 'NHCX-1019', message: 'Status check is verified and protocol response has been sent to the sender.', trace: null },
      'x-hcx-debug_details': null, 'x-hcx-domain-header': null, 'x-hcx-entity-type': asked ? String(asked.action).split('/')[0] : 'status' };
    later(cfg.statusDelayMs, async () => {
      const url = cfg.callbackBase.replace(/\/+$/, '') + '/v1/on_status';
      const d = await callbacks.post(url, JSON.stringify(body), cfg.callbackTimeoutMs, { chunked: state.faults.chunkedCallback });
      log.update(entry.id, { responses: [{ action: 'on_status', at: new Date().toISOString(), url, header: body, bundle: null, deliveries: [d] }], delivered: d.status >= 200 && d.status < 300 });
    });
  }

  // ------------------------------------------------------------------ /v1/*
  async function useCase(req, res, action, text) {
    if (state.faults.http503) return send(res, 503, { error: { code: 'MOCK-503', message: 'Fault mode http503: exchange unavailable.' } });
    if (upstreamFault(res)) return;
    if (state.faults.http500) return spring500(res, action);
    if (state.faults.slowMs > 0) await sleep(state.faults.slowMs);
    if (!proto.settings.enabled && !req.headers['bearer_auth'] && !req.headers['authorization'])
      return send(res, 401, { error: { code: 'NHCX-1003', message: 'Missing bearer_auth header.' } });

    const body = parse(text);
    if (!body) return send(res, 400, { error: { code: 'MOCK-JSON', message: 'Body is not JSON.' } });

    // /v1/status with a bare {api_call_id} (the reference HIMS): answered from the log.
    if (action === 'status' && typeof body.payload !== 'string') {
      const hit = log.items.find(e => e.apiCallId === body.api_call_id);
      return send(res, hit ? 200 : 404, hit ? { api_call_id: hit.apiCallId, correlation_id: hit.correlationId, status: hit.outcome || 'request.queued' }
        : { error: { code: 'NHCX-1012', message: 'No request with this api_call_id.' } });
    }
    const gate = proto.check({ action, headers: req.headers, text, body });
    if (!gate.ok) {
      const gh = gate.header || {};
      const refused = gate.refusal.status >= 300;
      log.add({ kind: 'request', action, correlationId: gh['x-hcx-correlation_id'] || '', apiCallId: gh['x-hcx-api_call_id'] || '', sender: gh['x-hcx-sender_code'] || '',
        recipient: gh['x-hcx-recipient_code'] || '', requestHeader: gate.header, protocol: gate.checks, outcome: refused ? 'refused' : 'duplicate', errorCode: gate.refusal.body.error.code });
      return send(res, gate.refusal.status, gate.refusal.body);
    }
    if (typeof body.payload !== 'string') return send(res, 400, { error: { code: 'MOCK-PAYLOAD', message: 'Expected {"payload": "<JWE>"}.' } });

    let h = null;
    try { h = jwe.peekHeader(body.payload); } catch (_) { /* unreadable header */ }
    const httpScenario = req.headers['x-mock-scenario'];
    const reqInfo = h ? {
      sender: h['x-hcx-sender_code'], recipient: h['x-hcx-recipient_code'], correlationId: h['x-hcx-correlation_id'],
      apiCallId: h['x-hcx-api_call_id'], workflowId: h['x-hcx-workflow_id'], useCase: h['x-hcx-use_case'], abha: h['x-hcx-ben-abha-id'],
    } : {};
    if (h && action === 'status') return statusAnswer(res, h, reqInfo);
    const entry = log.add({ kind: 'request', action, correlationId: reqInfo.correlationId || '', apiCallId: reqInfo.apiCallId || '',
      workflowId: reqInfo.workflowId || '', sender: reqInfo.sender || '', recipient: reqInfo.recipient || '', requestHeader: h,
      scenario: httpScenario || state.scenario, protocol: gate.checks });
    if (!h) {
      log.update(entry.id, { outcome: 'refused', errorCode: 'MOCK-HEADER', error: 'Protected header unreadable.' });
      return send(res, 400, { error: { code: 'MOCK-HEADER', message: 'JWE protected header is not readable.' } });
    }

    let opened;
    try { opened = jwe.decrypt(body.payload, kp.privatePem); }
    catch (e) {
      // The exchange accepted it; the payer could not open it. That comes back later as PAYR-1001.
      log.update(entry.id, { outcome: 'error', errorCode: 'PAYR-1001', error: e.message });
      send(res, 202, ackBody(h, action));
      const on = actions.onActionFor(action);
      if (on && !state.faults.noCallback) sendProtocolError(entry, reqInfo, action, on);
      return;
    }
    let bundle = null;
    try { bundle = JSON.parse(opened.payload); } catch (_) { bundle = { unparsed: opened.payload }; }
    entry.requestBundle = bundle;

    if (isDummy(reqInfo.recipient)) return dummyUseCase(res, entry, h, reqInfo, action, bundle);
    if (unreachable(reqInfo.recipient) && actions.onActionFor(action)) return undelivered(res, entry, h, reqInfo, action);

    // 'manual' is the engine's 'pending': the queued answer goes out, the decision waits for the desk.
    const scenarioHeader = httpScenario || state.scenario;
    const engineScenario = scenarioHeader === 'manual' ? 'pending' : scenarioHeader;
    // reviewHold: in scenario auto a pre-auth that needs 1518's review is not decided at once (see config decisionDelayMs).
    const input = Object.assign({}, reqInfo, { action, reviewHold: true, headers: Object.assign({}, h, { 'x-mock-scenario': engineScenario }), bundle });
    const r = bridge.handle(input, { delayMs: cfg.defaultDelayMs });
    const scenario = scenarioHeader === 'manual' ? 'manual' : (r.scenario || scenarioHeader);
    const findings = r.findings || r.validation || [];
    const pending = r.pending === true;
    const cbs = Array.isArray(r.callbacks) ? r.callbacks : [];
    log.update(entry.id, {
      requestBundle: bundle, scenario, findings, engine: r.engine, engineError: r.engineError || '',
      sync: r.sync || { status: 202 }, pending, caseNumber: r.caseNumber || '',
      outcome: r.sync && r.sync.status >= 300 ? 'refused' : pending ? 'pending' : outcomeOf(cbs[cbs.length - 1]) || 'acknowledged',
      errorCode: (r.sync && r.sync.body && r.sync.body.error && r.sync.body.error.code) || (cbs[0] && cbs[0].error && cbs[0].error.code) || '',
      reqInfo,
    });

    if (r.sync) {
      send(res, r.sync.status || 202, r.sync.body == null ? ackBody(h, action) : r.sync.body);
      if (r.sync.status >= 300) return;
    } else send(res, 202, ackBody(h, action));

    if (state.faults.noCallback) return;
    const planned = timer.plan(cbs, { scenario, headerValue: req.headers['x-mock-delay'] });
    log.update(entry.id, { timing: planned.callbacks.map(c => Object.assign({ action: c.action, hcxStatus: c.hcxStatus }, c.timing)) });
    for (const cb of planned.callbacks) schedule(entry, cb, reqInfo);
    // A held review decided after decisionDelayMs, when one is set; otherwise it waits for the desk.
    if (pending && r.review && state.decisionDelayMs != null) {
      later(state.decisionDelayMs, async () => { const e = log.get(entry.id); if (e && e.pending) deskDecide(entry.id, { decision: 'approve' }); });
    }
  }

  // ------------------------------------------------------------------ NHA dummy payer
  // As NHA's sandbox dummy payer behaves for the HIMS: cover and
  // plan checks are answered at once; a pre-auth or claim waits until /process/request names Approve,
  // Reject or Query (Query comes back as communication/request); /paymentNotice/init pays a claim.
  // The engine's 1518 rules are not applied: the dummy payer is not 1518.
  function isDummy(code) {
    return !!cfg.dummyPayerCode && String(code || '').replace(/@hcx$/i, '') === cfg.dummyPayerCode.replace(/@hcx$/i, '');
  }
  // Workflow ids NHA's dummy put on its answers (The HIMS audit, sender 1000003538@hcx, 24 Nov before noon): pre-auth
  // approve 21 (21 times, enhancements too), deny 23 (1); claim approve 26 (7), deny 291 (1); query 24; payment 31;
  // cover 5. The HIMS reads the decision from this id (the reference HIMS), so echoing the request's id reads as an ack.
  const DUMMY_WF = { 'preauth:approve': '21', 'preauth:reject': '23', 'claim:approve': '26', 'claim:reject': '291', coverage: '5', payment: '31' };
  const DUMMY_AUTO = { 'coverageeligibility/check': 'coverage', 'insuranceplan/request': 'plan' };
  // NHA's dummy plan answer, copied whole from the HIMS's inbox (2 Nov 2026, insuranceplan/on_request from
  // 1000003538@hcx, workflow 5): InsurancePlan 100217-32722 "PMJAY - Universal Health Policy", 230 packages. No member data.
  // NHA's dummy cover answer, the same for all 45 seen on 24 Nov - whatever the request's purpose (validation 30,
  // auth-requirements 10, benefits 5): purpose auth-requirements, outcome complete, one insurance naming the request's
  // Coverage with benefitPeriod 2024-01-01 to 2026-12-31 and no inforce or items; then the request echoed.
  function dummyCover(req) {
    const entries = ((req && req.entry) || []).filter(e => e && e.resource);
    const q = (entries.find(e => e.resource.resourceType === 'CoverageEligibilityRequest') || { resource: {} }).resource;
    const cov = entries.find(e => e.resource.resourceType === 'Coverage');
    const now = new Date(Date.now() + 330 * 60000).toISOString().replace(/\.\d+Z$/, '+05:30');
    const id = crypto.randomUUID();
    const r = { resourceType: 'CoverageEligibilityResponse', id,
      meta: { profile: ['http://hl7.org/fhir/StructureDefinition/CoverageEligibilityResponse'], tag: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED', display: 'subsetted' }] },
      identifier: [{ system: 'https://facility.ndhm.gov.in', value: crypto.randomUUID() }], status: 'active', purpose: ['auth-requirements'],
      patient: q.patient, created: now, request: { reference: 'urn:uuid:' + (q.id || crypto.randomUUID()) }, requestor: q.provider, insurer: q.insurer, outcome: 'complete',
      insurance: [{ coverage: { reference: cov ? (cov.fullUrl || 'urn:uuid:' + cov.resource.id) : '', display: 'Coverage' },
        benefitPeriod: { start: '2024-01-01T00:00:00+05:30', end: '2026-12-31T00:00:00+05:30' } }] };
    return { resourceType: 'Bundle', id: crypto.randomUUID(), meta: { lastUpdated: now }, identifier: req && req.identifier, type: 'collection', timestamp: now,
      entry: [{ fullUrl: 'urn:uuid:' + id, resource: r }].concat(entries) };
  }
  function dummyPlan() {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'dummy-plan.json'), 'utf8'));
    b.timestamp = new Date(Date.now() + 330 * 60000).toISOString().replace(/\.\d+Z$/, '+05:30');
    return b;
  }
  function dummyUseCase(res, entry, h, reqInfo, action, bundle) {
    const on = actions.onActionFor(action);
    const held = action === 'preauth/submit' || action === 'claim/submit' || action === 'predetermination/submit';
    log.update(entry.id, { requestBundle: bundle, scenario: 'dummy-payer', reqInfo, pending: held,
      outcome: held ? 'pending' : on ? 'acknowledged' : 'acknowledged', engine: 'dummy' });
    send(res, 202, ackBody(h, action));
    // NHA's dummy approved the queried pre-auth 2 s after the HIMS's reply arrived, with no drive (audit 24 Nov -> ).
    if (action === 'communication/on_request' && state.dummyQueries.has(reqInfo.correlationId)) {
      const q = log.get(state.dummyQueries.get(reqInfo.correlationId));
      state.dummyQueries.delete(reqInfo.correlationId);
      if (q && !state.faults.noCallback) {
        log.update(q.id, { outcome: 'approved', decidedBy: 'reply' });
        if (q.action === 'claim/submit') log.update(q.id, { dummyCaseNumber: caseOf(dummyAnswer(q.requestBundle, 'approve')) });
        schedule(q, { action: actions.onActionFor(q.action), delayMs: cfg.defaultDelayMs, bundle: dummyAnswer(q.requestBundle, 'approve'), hcxStatus: 'response.complete',
          workflowId: DUMMY_WF[(q.action === 'claim/submit' ? 'claim' : 'preauth') + ':approve'] }, q.reqInfo);
      }
      return;
    }
    if (held || !on || state.faults.noCallback) return;
    // The dummy itself answers only cover and plan checks unprompted; the rest wait for /process/request or get the ack
    // alone. /v1/status never reaches here: the exchange answers it (statusAnswer, above). Withdrawn 24 Nov: an earlier
    // note said NHA sent no on_status that morning; the HIMS had sent no status that morning, so it proved nothing.
    const kind = DUMMY_AUTO[action];
    if (!kind) return;
    const built = { bundle: kind === 'plan' ? dummyPlan() : dummyCover(bundle) };
    schedule(entry, { action: on, bundle: built.bundle, hcxStatus: 'response.complete', workflowId: DUMMY_WF.coverage }, reqInfo);   // cover and plan both 5 (real sandbox traffic)
  }
  // The dummy payer's own answers to /process/request and /paymentNotice/init, as NHA sent them: 200 with
  // protocol_status request.dispatched and a fresh api_call_id (a real sandbox answer of 2026-11-13); an unknown
  // correlation is HTTP 400 SBX-004 with both ids the asked correlation and a null result (2026-11-14/083105176,
  // HTTP status in real sandbox traffic to the test payer: 2154 answers 200, 36 answers 400).
  function dummyAck(apiCallId, corr, sender, recipient, protocolStatus) {
    return { timestamp: protocol.nhaStamp(null, true), api_call_id: apiCallId, correlation_id: corr,
      result: { sender_code: sender, recipient_code: recipient, entity_type: null, protocol_status: protocolStatus }, error: null };
  }
  function dummyRefusal(corr, code, message) {
    return { timestamp: protocol.nhaStamp(null, true), api_call_id: corr || null, correlation_id: corr || null,
      result: { sender_code: null, recipient_code: null, entity_type: null, protocol_status: 'request.error' }, error: { code, message } };
  }
  function dummyDrive(b) {
    const corr = String(b.correlationId || '');
    const entry = log.items.slice().reverse().find(e => e.kind === 'request' && e.correlationId === corr && isDummy(e.recipient) && e.pending);
    if (!entry) return { status: 400, body: dummyRefusal(corr, 'SBX-004', 'No Request was Queued with given Correlation Id, please initiate new Request and Try again') };
    const decision = { approve: 'approve', reject: 'reject', query: 'query' }[String(b.action || '').toLowerCase()];
    // not seen from NHA: what the dummy answers to an action it does not know (code and words are the mock's)
    if (!decision) return { status: 400, body: dummyRefusal(corr, 'MOCK-ACTION', 'action must be Approve, Reject or Query.') };
    const isClaim = entry.action === 'claim/submit';
    const ctx = Object.assign({}, entry.reqInfo, { bundle: entry.requestBundle });
    let cb;
    if (decision === 'query') {
      cb = { action: 'communication/request', delayMs: cfg.defaultDelayMs, bundle: dummyQuery(entry.requestBundle), hcxStatus: 'request.initiated',
        correlationId: crypto.randomUUID(), workflowId: isClaim ? '27' : '24' };
    } else {
      cb = { action: actions.onActionFor(entry.action), delayMs: cfg.defaultDelayMs, bundle: dummyAnswer(entry.requestBundle, decision), hcxStatus: 'response.complete',
        workflowId: DUMMY_WF[(isClaim ? 'claim:' : 'preauth:') + decision] };
    }
    if (decision === 'query') state.dummyQueries.set(cb.correlationId, entry.id);
    log.update(entry.id, { pending: false, outcome: decision === 'approve' ? 'approved' : decision, decidedBy: 'process/request',
      dummyCaseNumber: isClaim && decision === 'approve' ? caseOf(cb.bundle) : '' });
    schedule(entry, cb, entry.reqInfo, { truncatedJwe: false, duplicateCallback: false });
    return { status: 200, body: dummyAck(crypto.randomUUID(), corr, callbacks.bare(entry.sender || cfg.providerCode), entry.recipient || cfg.dummyPayerCode, 'request.dispatched') };
  }
  // NHA's dummy payer query, shape copied from the one the HIMS received on 24 Nov 2026 (inbox, workflow 24):
  // its Task and Organization, the request's own Claim, a CommunicationRequest basedOn that Claim, then the rest
  // of the request echoed. The HIMS files the query on the case named by the Claim's identifier.
  function dummyQuery(req) {
    const D = 'https://dummypayer.nha.gov.in';
    const tag = { tag: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED', display: 'subsetted' }] };
    const now = new Date(Date.now() + 330 * 60000).toISOString().replace('Z', '+05:30');
    const entries = ((req && req.entry) || []).filter(e => e && e.resource);
    const claim = entries.find(e => e.resource.resourceType === 'Claim');
    const rest = entries.filter(e => e !== claim);
    const crId = crypto.randomUUID(), taskId = crypto.randomUUID();
    const code = cfg.dummyPayerCode.replace(/@hcx$/i, '');
    const claimRef = claim ? (claim.fullUrl || 'urn:uuid:' + claim.resource.id) : '';
    return {
      resourceType: 'Bundle', id: 'CommunicationReq-' + crypto.randomUUID(), meta: Object.assign({ lastUpdated: now }, tag),
      identifier: (req && req.identifier) || { system: 'urn:hims:bundle', value: crypto.randomUUID() }, type: 'collection', timestamp: now,
      entry: [
        { id: taskId, fullUrl: D + '/task/' + taskId, resource: { resourceType: 'Task', id: taskId, meta: tag,
          identifier: [{ system: D + '/Task/' + taskId, value: taskId }], status: 'requested', intent: 'proposal',
          code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/financialtaskcode', code: 'poll', display: 'Poll' }] },
          input: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype', code: 'reference', display: 'Reference Number' }] },
            valueReference: { reference: D + '/CommunicationRequest/' + crId, display: 'CommunicationRequest' } }] } },
        { id: code, fullUrl: D + '/Organization/' + code, resource: { resourceType: 'Organization', id: code, meta: tag,
          identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NIIP', display: 'National Insurance Payor Identifier (Payor)' }] }, system: 'https://facility.abdm.gov.in', value: code }],
          active: true, type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'pay', display: 'Payer' }] }], name: 'NHCX Payer' } },
      ].concat(claim ? [claim] : []).concat([
        { id: crId, fullUrl: D + '/communicationRequest/' + crId, resource: { resourceType: 'CommunicationRequest', id: crId, meta: tag,
          identifier: [{ system: D + '/CommunicationRequest/' + crId, value: crId }],
          basedOn: claimRef ? [{ reference: claimRef, display: 'Claim' }] : [], status: 'active', priority: 'routine',
          payload: [{ contentString: 'Hospital Investigation Document missing' }, { contentString: 'Hospital Fecilities missing - Facilities for procedure' }, { contentString: 'Care Team Details missing' }],
          reasonCode: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'ELIGVER', display: 'eligibility verification' }] },
            { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'CLMATTCH', display: 'claim attachment' }] }] } },
      ]).concat(rest),
    };
  }
  // NHA's dummy pre-auth and claim answer (inbox 24 Nov and ): a ClaimResponse naming the request
  // Claim's identifier, request and insurer, outcome complete, eligible total = the claimed total; then the request
  // echoed. Reject as the dummy sent it (inbox 24 Nov pre-auth, claim): outcome complete, eligible 0,
  // line reason ClaimError-1, no disposition; workflow 23 or 291 carries the refusal.
  function dummyAnswer(req, decision) {
    const entries = ((req && req.entry) || []).filter(e => e && e.resource);
    const ce = entries.find(e => e.resource.resourceType === 'Claim') || { resource: {} };
    const c = ce.resource;
    const now = new Date(Date.now() + 330 * 60000).toISOString().replace(/\.\d+Z$/, '+05:30');
    const ok = decision !== 'reject';
    const total = Number((c.total && c.total.value) || (c.item || []).reduce((a, i) => a + Number((i.net && i.net.value) || (i.unitPrice && i.unitPrice.value) || 0), 0)) || 0;
    const eligible = (v) => [{ category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'eligible', display: 'Eligible Amount' }] }, amount: { value: v, currency: 'INR' } }];
    const items = (c.item || []).map((it, i) => ({ itemSequence: it.sequence || i + 1, adjudication: [Object.assign(eligible(ok ? Number((it.net && it.net.value) || (it.unitPrice && it.unitPrice.value) || 0) : 0)[0], { reason: { text: ok ? 'Covered' : 'ClaimError-1' } })] }));
    const id = crypto.randomUUID();
    const cr = { resourceType: 'ClaimResponse', id, meta: { tag: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED', display: 'subsetted' }] },
      identifier: c.identifier || [], status: 'active', type: c.type, use: c.use || 'preauthorization', patient: c.patient, created: now,
      insurer: c.insurer, request: { reference: ce.fullUrl || ('urn:uuid:' + c.id), display: 'Claim' }, outcome: 'complete',
      item: items, total: eligible(ok ? total : 0) };
    return { resourceType: 'Bundle', id: 'ClaimResponse-' + crypto.randomUUID(), meta: { lastUpdated: now }, identifier: req && req.identifier, type: 'collection', timestamp: now,
      entry: [{ fullUrl: 'urn:uuid:' + id, resource: cr }].concat(entries) };
  }
  // NHA's dummy payment notice (inbox 24 Nov ): Task, payer Organization, PaymentNotice, provider Organization,
  // PaymentReconciliation, each named by the claim number. The dummy's amount (841,479) did not match the claim; the mock pays the approved total.
  function dummyPayment(no, amount) {
    const D = 'https://dummypayer.nha.gov.in', code = cfg.dummyPayerCode.replace(/@hcx$/i, '');
    const now = new Date(Date.now() + 330 * 60000).toISOString().replace(/\.\d+Z$/, '+05:30');
    const t = crypto.randomUUID(), pn = crypto.randomUUID(), pr = crypto.randomUUID(), prov = crypto.randomUUID();
    const payer = { reference: D + '/Organization/' + code, display: 'Organization' };
    return { resourceType: 'Bundle', id: shortCase(no), meta: { lastUpdated: now }, type: 'collection', timestamp: now, entry: [
      { fullUrl: D + '/Task/' + t, resource: { resourceType: 'Task', id: t, identifier: [{ system: D + '/Task/' + no, value: no }], status: 'completed', intent: 'proposal',
        code: { coding: [{ system: 'http://hl7.org/fhir/CodeSystem/task-code', code: 'approve', display: 'Activate/approve the focal resource' }] }, requester: payer,
        input: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype', code: 'reference', display: 'Reference Number' }] }, valueReference: { reference: D + '/PaymentNotice/' + pn, display: 'PaymentNotice' } }] } },
      { fullUrl: D + '/Organization/' + code, resource: { resourceType: 'Organization', id: code, name: 'NHCX Payer',
        identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NIIP', display: 'National Insurance Payor Identifier (Payor)' }] }, system: 'https://facility.abdm.gov.in', value: code }] } },
      { fullUrl: D + '/PaymentNotice/' + pn, resource: { resourceType: 'PaymentNotice', id: pn, identifier: [{ system: D + '/PaymentNotice/' + no, value: no }], status: 'active', created: now,
        payment: { reference: D + '/PaymentReconciliation/' + pr, display: 'PaymentReconciliation' }, payee: payer, recipient: { reference: 'urn:uuid:' + prov, display: 'Organization' },
        amount: { value: amount, currency: 'INR' }, paymentStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/paymentstatus', code: 'paid', display: 'Paid' }] } } },
      { fullUrl: 'urn:uuid:' + prov, resource: { resourceType: 'Organization', id: prov, identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NPI', display: 'National Provider Identifier' }] }, system: 'https://facility.ndhm.gov.in', value: cfg.providerCode.replace(/@hcx$/i, '') }] } },
      { fullUrl: D + '/PaymentReconciliation/' + pr, resource: { resourceType: 'PaymentReconciliation', id: pr, identifier: [{ system: D + '/PaymentReconciliation/' + no, value: no }], status: 'active', created: now,
        paymentIssuer: payer, request: { reference: D + '/Task/' + no, display: 'Task' }, requestor: { reference: 'urn:uuid:' + prov, display: 'Organization' }, outcome: 'complete',
        paymentDate: now.slice(0, 10), paymentAmount: { value: amount, currency: 'INR' } } },
    ] };
  }
  function shortCase(no) { const p = String(no).split('/'); return p[p.length - 1] || String(no); }
  function caseOf(bundle) {
    for (const e of (bundle && bundle.entry) || []) {
      const r = e && e.resource;
      if (r && r.resourceType === 'ClaimResponse') {
        const id = (r.identifier || []).find(i => i.value) || {};
        const amt = ((r.total || []).find(t => t.amount) || {}).amount || (r.payment && r.payment.amount) || {};
        return { number: id.value || '', amount: Number(amt.value) || 0 };
      }
    }
    return { number: '', amount: 0 };
  }
  function dummyPay(b) {
    const no = String(b.claimNumber || '');
    const entry = log.items.slice().reverse().find(e => e.dummyCaseNumber && (e.dummyCaseNumber.number === no || !no));
    // not seen from NHA: its answer for a claim it never approved (code and words are the mock's)
    if (!entry) return { status: 400, body: dummyRefusal(null, 'MOCK-NO-CLAIM', 'No approved claim ' + no) };
    const built = { bundle: dummyPayment(no || entry.dummyCaseNumber.number, entry.dummyCaseNumber.amount) };
    // The init answer's api_call_id and correlation_id are one id, which the payment notice then carries as both
    // (a real sandbox answer of 2026-11-13; real sandbox traffic), protocol_status request.queued, sender the dummy payer.
    const corr = crypto.randomUUID();
    const pn = log.add({ kind: 'request', action: 'paymentnotice/request', correlationId: corr, apiCallId: corr, sender: entry.recipient, recipient: entry.sender, outcome: 'sent', scenario: 'dummy-payer' });
    schedule(pn, { action: 'paymentnotice/request', delayMs: cfg.defaultDelayMs, bundle: built.bundle, hcxStatus: 'request.initiated',
      correlationId: corr, workflowId: DUMMY_WF.payment }, entry.reqInfo, { truncatedJwe: false, duplicateCallback: false });
    return { status: 200, body: dummyAck(corr, corr, callbacks.bare(cfg.dummyPayerCode) + '@hcx', callbacks.bare(entry.sender || cfg.providerCode) + '@hcx', 'request.queued') };
  }

  // ------------------------------------------------------------------ registry payers with no system running
  // A request to any participant other than 1518 or the dummy payer: NHA accepts it (202) and later posts NHCX-1001
  // to /v1/error/response. Shape copied from the HIMS's audit, 2 Nov 2026, recipient 1000004805@hcx: a JWE whose
  // header echoes our sender and recipient, status request.initiated, empty workflow, a NEW api_call_id; payload a ProtocolResponse
  // carrying the original send's api_call_id. One sample: sent, answered (74 s); PMJAY_UNDELIVERED_MS overrides.
  function unreachable(code) {
    const bare = String(code || '').replace(/@hcx$/i, '');
    if (!bare) return false;
    return bare !== cfg.payerCode.replace(/@hcx$/i, '') && !isDummy(code) && bare !== cfg.providerCode.replace(/@hcx$/i, '');
  }
  function undelivered(res, entry, h, reqInfo, action) {
    log.update(entry.id, { outcome: 'error', errorCode: 'NHCX-1001', reqInfo, scenario: 'unreachable' });
    send(res, 202, ackBody(h, action));
    if (state.faults.noCallback) return;
    const entity = { coverageeligibility: 'coverageeligibility', preauth: 'preauthorization', claim: 'claim' }[actions.entityOf(action)] || actions.entityOf(action);
    later(Number(process.env.PMJAY_UNDELIVERED_MS || 74000), async () => {
      const cert = himsCert();
      const secs = String(Math.floor(Date.now() / 1000));
      const hdr = { alg: 'RSA-OAEP-256', enc: 'A256GCM', 'x-hcx-sender_code': reqInfo.sender, 'x-hcx-recipient_code': reqInfo.recipient,
        'x-hcx-correlation_id': reqInfo.correlationId, 'x-hcx-workflow_id': '', 'x-hcx-api_call_id': crypto.randomUUID(),
        'x-hcx-timestamp': secs, 'x-hcx-status': 'request.initiated' };
      const body = { type: 'ProtocolResponse', 'x-hcx-sender_code': reqInfo.sender, 'x-hcx-recipient_code': reqInfo.recipient,
        'x-hcx-api_call_id': reqInfo.apiCallId, 'x-hcx-correlation_id': reqInfo.correlationId, 'x-hcx-workflow_id': null, 'x-hcx-timestamp': secs,
        'x-hcx-debug_flag': null, 'x-hcx-status': null, 'x-hcx-redirect_to': null,
        'x-hcx-error_details': { code: 'NHCX-1001', message: 'Receiver system is not reachable.', trace: null },
        'x-hcx-debug_details': null, 'x-hcx-domain-header': null, 'x-hcx-entity-type': entity, 'x-hcx-ben-abha-id': null };
      const url = cfg.callbackBase.replace(/\/+$/, '') + '/v1/error/response';
      let d;
      try { d = cert ? await callbacks.post(url, JSON.stringify({ payload: jwe.encrypt(JSON.stringify(body), cert, hdr) }), cfg.callbackTimeoutMs) : { status: 0, error: 'no the HIMS certificate' }; }
      catch (e) { d = { status: 0, error: e.message }; }
      entry.responses = [{ action: 'error/response', at: new Date().toISOString(), url, header: hdr, bundle: body, deliveries: [d] }];
      log.update(entry.id, { responses: entry.responses, delivered: d.status >= 200 && d.status < 300 });
    });
  }

  // ------------------------------------------------------------------ manual payer desk
  function deskDecide(id, b) {
    const entry = log.get(id);
    if (!entry || !entry.pending) return { status: 404, body: { error: 'No pending request with that id.' } };
    const decision = String(b.decision || '');
    if (!['approve', 'partial', 'query', 'reject'].includes(decision)) return { status: 400, body: { error: 'decision must be approve, partial, query or reject.' } };
    const on = actions.onActionFor(entry.action);
    const reqInfo = entry.reqInfo;
    // Prefer the engine's desk, so case state (open pre-auth, wallet, pending event) moves with the decision and a
    // query comes back as on_submit outcome queried, as 1518 sent it (fixture preauth-queried, fixture preauth-queried).
    const eng = bridge.engine && bridge.engine();
    if (eng && typeof eng.desk === 'function' && typeof eng.cases === 'function') {
      const c = eng.cases().find(x => x.pendingEvent && x.pendingEvent.correlationId === reqInfo.correlationId);
      if (c) {
        const r = eng.desk({ caseNumber: c.number, decision, amount: b.amount, note: b.note });
        if (r.error) return { status: 409, body: { error: r.error } };
        log.update(entry.id, { pending: false, outcome: decision, decidedBy: 'desk' });
        for (const cbk of r.callbacks || []) schedule(entry, cbk, reqInfo, { truncatedJwe: false, duplicateCallback: false });
        return { status: 200, body: { ok: true, id: entry.id, decision, caseNumber: r.caseNumber } };
      }
    }
    const ctx = Object.assign({}, reqInfo, { bundle: entry.requestBundle, decision, amount: b.amount, note: b.note, action: entry.action });
    let cb;
    if (decision === 'query') {
      // A payer query is a new conversation the payer opens: communication/request, workflow 24 for a
      // pre-auth, 27 for a claim (the reference HIMS's notes).
      const built = bridge.buildResponse('communication/request', ctx);
      cb = { action: 'communication/request', delayMs: 0, bundle: built.bundle, hcxStatus: 'request.initiated',
        correlationId: crypto.randomUUID(), workflowId: /claim/.test(entry.action) ? '27' : '24' };
    } else {
      const built = bridge.buildResponse(on + ':' + decision, ctx);
      cb = { action: on, delayMs: 0, bundle: built.bundle, hcxStatus: decision === 'partial' ? 'response.partial' : 'response.complete' };
    }
    log.update(entry.id, { pending: false, outcome: decision === 'query' ? 'query' : outcomeOf(cb) || decision, decidedBy: 'desk' });
    schedule(entry, cb, reqInfo, { truncatedJwe: false, duplicateCallback: false });
    return { status: 200, body: { ok: true, id: entry.id, decision } };
  }

  // ------------------------------------------------------------------ router
  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      try { return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' }); }
      catch (_) { return send(res, 404, 'ui/index.html missing'); }
    }
    if (m === 'GET' && p === '/mock/health') return send(res, 200, { ok: true, payer: cfg.payerCode, callbackBase: cfg.callbackBase, himsCert: !!himsCert() });
    if (m === 'GET' && p === '/mock/config') return send(res, 200, { payerCode: cfg.payerCode, providerCode: cfg.providerCode, callbackBase: cfg.callbackBase,
      himsCertPath: cfg.himsCertPath, himsCertLoaded: !!himsCert(), scenario: state.scenario, faults: state.faults, scenarios: bridge.scenarios() });
    if (m === 'GET' && p === '/mock/messages') return send(res, 200, log.summary());
    if (m === 'GET' && p.startsWith('/mock/messages/')) {
      const e = log.get(p.split('/').pop());
      return e ? send(res, 200, e) : send(res, 404, { error: 'not found' });
    }
    if (m === 'GET' && p === '/mock/pending') return send(res, 200, log.summary().filter(x => x.pending));
    if (p.startsWith('/playground/')) return require('./playground').route(req, res, p);   // learning playground
    if (m === 'GET' && p === '/mock/cert') return send(res, 200, kp.certPem, { 'Content-Type': 'application/x-pem-file' });

    const text = m === 'POST' || m === 'PUT' ? await readBody(req) : '';
    const b = parse(text) || {};

    if (m === 'POST' && p === '/mock/fault') {
      if (b.reset) state.faults = Object.assign({}, FAULTS);
      for (const k of BOOL_FAULTS) if (k in b) state.faults[k] = !!b[k];
      if ('slow' in b) state.faults.slowMs = Math.max(0, Number(b.slow) || 0);
      if ('slowMs' in b) state.faults.slowMs = Math.max(0, Number(b.slowMs) || 0);
      return send(res, 200, state.faults);
    }
    if (m === 'GET' && p === '/mock/timing') return send(res, 200, Object.assign(timer.get(), { decisionDelayMs: state.decisionDelayMs }));
    if (m === 'POST' && p === '/mock/timing') {
      if ('decisionDelayMs' in b) {
        state.decisionDelayMs = b.decisionDelayMs == null || b.decisionDelayMs === '' ? null : Math.max(0, Number(b.decisionDelayMs) || 0);
        if (Object.keys(b).length === 1) return send(res, 200, { ok: true, decisionDelayMs: state.decisionDelayMs });
      }
      const r = timer.set(b); return send(res, r.ok ? 200 : 400, Object.assign(r, { decisionDelayMs: state.decisionDelayMs }));
    }
    if (m === 'GET' && p === '/mock/protocol') return send(res, 200, { settings: proto.settings, checks: protocol.CATALOGUE });
    if (m === 'POST' && p === '/mock/protocol') { if (b.expireToken) proto.expire(String(b.expireToken)); for (const k of Object.keys(proto.settings)) if (k in b) proto.settings[k] = b[k]; return send(res, 200, { settings: proto.settings }); }
    if (m === 'POST' && p === '/mock/scenario') {
      state.scenario = String(b.scenario || 'auto');
      bridge.setScenario(state.scenario);
      return send(res, 200, { scenario: state.scenario });
    }
    // A test run's clean start: the engine's cases and wallet back to the starting member, the chosen scenario kept,
    // and nothing left waiting on the desk. Real 1518 never forgets a case (PAYR-1238 holds until a claim or cancel);
    // this exists because a test lane resets the HIMS's admissions before each spec, and the payer has to start clean too.
    if (m === 'POST' && p === '/mock/cases/reset') {
      const eng = bridge.engine && bridge.engine();
      if (!eng || typeof eng.reset !== 'function') return send(res, 503, { error: 'engine not loaded' });
      eng.reset();
      bridge.setScenario(state.scenario || 'auto');
      let released = 0;
      for (const x of log.summary()) if (x.pending) { log.update(x.id, { pending: false, outcome: 'reset' }); released++; }
      return send(res, 200, { ok: true, cases: eng.cases().length, released, scenario: state.scenario || 'auto' });
    }
    if (m === 'POST' && p.startsWith('/mock/desk/')) {
      const r = deskDecide(p.split('/').pop(), b);
      return send(res, r.status, r.body);
    }

    // Session (NHCX_SESSION_URL): any path ending in /sessions.
    if (m === 'POST' && /\/sessions$/.test(p)) {
      if (upstreamFault(res)) return;
      const badCreds = (cfg.clientId && b.clientId !== cfg.clientId) || (cfg.clientSecret && b.clientSecret !== cfg.clientSecret);
      // No real refusal of bad credentials was captured (the 140 session 403s to 24 Nov are CloudFront blocks),
      // so the status 401 and this body are the mock's guess, marked MOCK so nobody reads it as NHA's code.
      if (state.faults.sessionRefuse || badCreds) return send(res, 401, { error: { code: 'MOCK-SESSION-401', message: 'Invalid client credentials.' } });
      const token = 'mock-' + crypto.randomBytes(16).toString('hex');
      state.tokens.add(token);
      proto.issue(token);
      // real answer keys (a real sandbox answer of 2026-11-24): accessToken, expiresIn, refreshExpiresIn, refreshToken, tokenType
      return send(res, 200, { accessToken: token, expiresIn: 1200, refreshExpiresIn: 1800, refreshToken: 'mock-refresh-' + crypto.randomBytes(16).toString('hex'), tokenType: 'bearer' });
    }

    // Registry (NHCX_PARTICIPANT_BASE).
    const isRegistry = /\/(participant\/(search|get\/policies|update|create)|fetch\/(certs|participants\/list))$/.test(p);
    if (m === 'POST' && isRegistry) { const f = upstreamFault(res); if (f) return f; }
    if (m === 'POST' && p.endsWith('/participant/search')) {
      const rec = participant(b.participant_code);
      return rec ? send(res, 200, searchView(rec))
        : send(res, 400, { error: { code: 'NHCX-1048', message: 'Participant not found: ' + b.participant_code } });
    }
    if (m === 'POST' && p.endsWith('/fetch/certs')) {
      // {encryption_cert, participant_name, participant_id}, the PEM with CRLF line ends (a real sandbox answer of 2026-11-20)
      const rec = participant(b.participantid);
      return rec && rec.encryption_cert ? send(res, 200, { encryption_cert: String(rec.encryption_cert).replace(/\r?\n/g, '\r\n'),
        participant_name: rec.participant_name, participant_id: rec.participant_code })
        : send(res, 400, { error: { code: 'NHCX-1048', message: 'No certificate for ' + b.participantid } });
    }
    if (m === 'POST' && p.endsWith('/fetch/participants/list')) {
      // rows {participantcode, participantname, address, state} under participantdetails (a real sandbox answer of 2026-11-12).
      // PAYER answers NHA's real lists (fixtures/registry): without entitytype the 202 rows that do not carry 1518@hcx,
      // with entitytype "gov" the 49 that do. Withdrawn 24 Nov 2026: listing 1518 in the plain PAYER list so pickers
      // found it. Real NHA does not, and the HIMS spec 93 (its look-in-the-gov-list fallback) failed against that.
      if (String(b.role || '').toUpperCase() === 'PAYER') {
        const gov = String(b.entitytype || '').toLowerCase() === 'gov';
        const real = registryList(gov ? 'payer-list-gov.json' : 'payer-list.json');
        if (real) return send(res, 200, { participantdetails: real });
      }
      const named = Object.keys(cfg.participantNames || {}).map(participant).filter(Boolean);
      const rows = [participant(cfg.payerCode), participant(cfg.providerCode)].concat(named)
        .filter(r => !b.role || (String(b.role).toUpperCase() === 'PAYER' ? r.role_code[0] === '10002' : String(b.role).toUpperCase() === 'PROVIDER' ? r.role_code[0] === '10001' : false))
        .map(r => ({ participantcode: r.participant_code, participantname: r.participant_name, address: null, state: r.state || null }));
      return send(res, 200, { participantdetails: rows });
    }
    if (m === 'POST' && p.endsWith('/participant/get/policies')) {
      const type = String(b.identifiertype || ''), v = String(b.identifiervalue || '');
      const known = v ? capturedPolicies(type, v) : null;
      if (known) return send(res, 200, known.map(r => maskPolicy(r, type, v)));
      if (v && knownHolder(type, v)) {
        // one row as NHA answered MemberId SBXSTG269 (a real sandbox answer of 2026-11-20); sno is a string there
        return send(res, 200, [maskPolicy({ sno: String(197610919), abhanumber: '', mobilenumber: '', memberid: type === 'MemberId' ? v : cfg.policyMembers[0] || '',
          payerid: cfg.payerCode, productid: 'PMJAY/HP/S/G', productname: 'PMJAY for Himachal', processingid: cfg.payerCode }, type, v)]);
      }
      // no match: HTTP 400 NHCX-1016, timestamp ISO UTC with millis (a real sandbox answer of 2026-11-20, real sandbox traffic)
      return send(res, 400, { timestamp: new Date().toISOString().replace('Z', '+00:00'), api_call_id: null, correlation_id: null,
        error: { code: 'NHCX-1016', message: 'No policies found for given beneficiary ' + type + ': ' + v + '.' } });
    }
    if (m === 'POST' && (p.endsWith('/participant/update') || p.endsWith('/participant/create'))) {
      const code = b.participant_code || cfg.providerCode;
      let cert = b.encryption_cert || '';
      if (cert && !cert.includes('BEGIN')) { try { cert = Buffer.from(cert, 'base64').toString('utf8'); } catch (_) {} }
      const prev = state.registry.get(code) || {};
      state.registry.set(code, Object.assign(prev, cert.includes('BEGIN') ? { encryption_cert: cert } : {}, b.endpoint_url ? { registered_endpoint_url: b.endpoint_url } : {}));
      log.add({ kind: 'registry', action: p.split('/').slice(-2).join('/'), outcome: 'stored', correlationId: '' });
      return send(res, 200, { participant_code: code, status: 'Active' });
    }

    // NHA sandbox dummy payer (NHCX_DUMMY_PAYER_BASE): nothing to drive; the mock answers on its own.
    if (m === 'POST' && (p.endsWith('/process/request') || p.endsWith('/paymentNotice/init'))) { const f = upstreamFault(res); if (f) return; }
    if (m === 'POST' && p.endsWith('/process/request')) { const r = dummyDrive(b); return send(res, r.status, r.body); }
    if (m === 'POST' && p.endsWith('/paymentNotice/init')) { const r = dummyPay(b); return send(res, r.status, r.body); }

    // Presence (NHCX_PRESENCE_BASE) and face auth (NHCX_FACEAUTH_BASE).
    if (p.endsWith('/faceauth/init') || p.endsWith('/auth/init')) return send(res, 200, { txnId: crypto.randomUUID(), message: 'mock: started' });
    if (p.endsWith('/capture/pid')) return send(res, 200, { txnId: b.txnId || '', status: 'COMPLETE' });
    if (p.endsWith('/v2/auth/verify')) return send(res, 200, { authResult: 'success', message: 'mock: verified',
      tokens: { token: 'mock-user-' + crypto.randomBytes(8).toString('hex'), expiresIn: 1800, refreshToken: 'mock-refresh', refreshExpiresIn: 86400 },
      ABHAProfile: { ABHANumber: '91-0000-0000-0000', firstName: 'Mock', lastName: 'Patient', preferredAddress: 'mock@sbx' } });
    if (p.endsWith('/auth/verify') || p.endsWith('/auth/refresh/token')) return send(res, 200, { authResult: 'success', message: 'mock: verified',
      token: 'mock-user-' + crypto.randomBytes(8).toString('hex'), expiresIn: 1800, refreshToken: 'mock-refresh', refreshExpiresIn: 86400,
      accounts: [{ ABHANumber: '91-0000-0000-0000', name: 'Mock Patient', preferredAbhaAddress: 'mock@sbx' }] });

    // Use cases (NHCX_USECASE_BASE + /v1/...).
    const i = p.indexOf('/v1/');
    if (m === 'POST' && i >= 0) {
      const action = p.slice(i + 4);
      if (!actions.isKnown(action)) return send(res, 404, { error: { code: 'MOCK-PATH', message: 'Unknown use-case path /v1/' + action } });
      return useCase(req, res, action, text);
    }
    return send(res, 404, { error: 'not found: ' + m + ' ' + p });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(e => { try { send(res, 500, { error: { code: 'MOCK-500', message: e.message } }); } catch (_) {} });
  });

  function close() {
    for (const t of state.timers) clearTimeout(t);
    state.timers.clear();
    return new Promise(r => server.close(() => r()));
  }

  /** Resolves once no callback is waiting or being delivered (tests use it). */
  async function idle() {
    while (state.timers.size || state.inflight) await sleep(20);
  }

  return { server, cfg, state, log, keys: kp, close, idle, proto, timer };
}

module.exports = { createApp, orderedDelay };
