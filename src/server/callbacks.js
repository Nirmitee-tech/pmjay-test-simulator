'use strict';
// Builds and delivers a callback to the HIMS the way NHCX does: POST <callbackBase>/v1/<action>.
//
// Success callbacks: body {"payload": "<JWE>"} encrypted to the HIMS's certificate, x-hcx-* in the protected
// header. The header copies real 1518 and dummy payer callbacks (real sandbox headers, read 24 Nov 2026):
// - keys and order as fixture two-packages-preauth: error_details {code "100", message "Message
//  Submitted", trace null}, debug_flag "INFO"; no request_id, use_case or ben-abha-id.
// - 1518: sender "1518" on pre-auth, claim, task and payment notice (fixture two-packages-preauth, claim-reprocess, payment-notice) and
//  "1518@hcx" on cover and plan answers (real sandbox traffic); recipient bare "1000000001"; timestamp epoch
//  millis rounded down to a whole second, as a number (real sandbox traffic: 1795400000000).
// - NHA's dummy payer 1000003538@hcx: recipient "1000000001@hcx", timestamp 10-digit epoch seconds as a
//  number (real sandbox traffic: 1795400000).
// - A message the payer opens (request.initiated: payment notice, query) carries api_call_id equal to its
//  correlation_id (fixture payment-notice); an answer carries a fresh api_call_id.
// Refusals: a plain unencrypted ProtocolResponse object as the body (a real sandbox answer of 2026-11-09, rows
// real sandbox traffic), never wrapped in a JWE.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const jwe = require('./jwe');

function bare(code) { return String(code || '').replace(/@hcx$/i, ''); }
function isDummy(code, cfg) { return !!(cfg && cfg.dummyPayerCode) && bare(code) === bare(cfg.dummyPayerCode); }

// 1518 put "1518@hcx" on cover and plan answers and bare "1518" on everything else it sent.
function payerSender(action, cfg) {
  const full = bare(cfg.payerCode) + '@hcx';
  return action === 'coverageeligibility/on_check' || action === 'insuranceplan/on_request' ? full : bare(cfg.payerCode);
}

function claimResponseOf(bundle) {
  for (const e of (bundle && bundle.entry) || []) if (e && e.resource && e.resource.resourceType === 'ClaimResponse') return e.resource;
  return null;
}
function adjudicationStatus(cr) {
  if (!cr) return '';
  for (const a of cr.adjudication || []) {
    const c = a && a.reason && a.reason.coding && a.reason.coding[0];
    if (c && c.code) return String(c.code);
  }
  return '';
}

// Workflow id per step, derived from 1518's own callbacks before the mock existed (real sandbox traffic, inbound,
// to 24 Nov 2026 noon): cover 5 (65 rows), plan 5 (real sandbox traffic); pre-auth queued 20 (19), approved 21 (17),
// rejected 23 (fixture preauth-rejected), queried 24 (fixture preauth-queried); claim queued 25 (16), approved 26 (12), queried 27 (fixture claim-queried),
// rejected 291 (fixture claim-rejected); payment notice 30 (12) and 33 on the second notice of a claim (real sandbox traffic); task
// cancel PC02 (fixture preauth-cancel), task reprocess 37 (fixture claim-reprocess). The dummy payer: cover and plan 5, pre-auth approved 21,
// rejected 23, claim approved 26, rejected 291, query 24 or 27, payment 31.
function workflowFor(cb, fromDummy) {
  if (cb.workflowId) return String(cb.workflowId);
  const a = String(cb.action || '');
  if (a === 'coverageeligibility/on_check' || a === 'insuranceplan/on_request') return '5';
  if (a === 'paymentnotice/request') return fromDummy ? '31' : cb.notice === 2 ? '33' : '30';
  if (a === 'communication/request') return cb.forClaim ? '27' : '24';
  const cr = claimResponseOf(cb.bundle);
  const st = adjudicationStatus(cr);
  if (a === 'task/on_submit') return st === 'cancelled' ? 'PC02' : '37';
  const isClaim = a === 'claim/on_submit';
  const pick = (pre, clm) => (isClaim ? clm : pre);
  if (st === 'submitted' || (cr && cr.outcome === 'queued') || cb.hcxStatus === 'response.partial') return pick('20', '25');
  if (st === 'queried') return pick('24', '27');
  if (st === 'rejected' || (cr && cr.outcome === 'error')) return pick('23', '291');
  return pick('21', '26');
}

function header(cb, req, cfg) {
  const fromDummy = isDummy(req.recipient, cfg);
  const provider = bare(req.sender || cfg.providerCode);
  const correlation = cb.correlationId || req.correlationId;
  const status = cb.hcxStatus || 'response.complete';
  const now = Date.now();
  const error = cb.error
    ? { trace: null, code: cb.error.code || '', message: cb.error.message || '' }
    : { trace: null, code: '100', message: 'Message Submitted' };
  return {
    'x-hcx-error_details': error,
    'x-hcx-recipient_code': fromDummy ? provider + '@hcx' : provider,
    'x-hcx-debug_flag': 'INFO',
    'x-hcx-timestamp': fromDummy ? Math.floor(now / 1000) : Math.floor(now / 1000) * 1000,
    'x-hcx-sender_code': cb.sender || (fromDummy ? bare(cfg.dummyPayerCode) + '@hcx' : payerSender(cb.action, cfg)),
    'x-hcx-correlation_id': correlation,
    enc: 'A256GCM',
    'x-hcx-workflow_id': workflowFor(cb, fromDummy),
    'x-hcx-api_call_id': status === 'request.initiated' ? correlation : crypto.randomUUID(),
    alg: 'RSA-OAEP-256',
    'x-hcx-status': status,
  };
}

/** opts.chunked: send with Transfer-Encoding chunked and no Content-Length (fault chunkedCallback). */
function post(url, bodyText, timeoutMs, opts) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, error: 'bad callback URL ' + url }); }
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const headers = { 'Content-Type': 'application/json' };
    if (!(opts && opts.chunked)) headers['Content-Length'] = Buffer.byteLength(bodyText);
    const r = lib.request(u, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 2000), ms: Date.now() - started }));
    });
    r.on('timeout', () => { r.destroy(new Error('timed out after ' + timeoutMs + ' ms')); });
    r.on('error', (e) => resolve({ status: 0, error: e.message, ms: Date.now() - started }));
    if (opts && opts.chunked) { r.write(bodyText); r.end(); } else r.end(bodyText);
  });
}

function isProtocolResponse(b) { return !!b && b.type === 'ProtocolResponse'; }

/**
 * Encrypt (or not, for a ProtocolResponse) and deliver one callback. Returns the delivery record(s).
 * faults: { truncatedJwe, duplicateCallback, jwePayloadWrapper, chunkedCallback }
 */
async function deliver({ cb, req, cfg, himsCertPem, faults }) {
  faults = faults || {};
  const url = cfg.callbackBase.replace(/\/+$/, '') + '/v1/' + cb.action;
  let h, body, truncated = false;
  if (isProtocolResponse(cb.bundle)) {
    h = cb.bundle;
    body = JSON.stringify(cb.bundle);
  } else {
    h = header(cb, req, cfg);
    let token = jwe.encrypt(JSON.stringify(cb.bundle || {}), himsCertPem, h);
    if (faults.truncatedJwe) { token = token.slice(0, Math.floor(token.length * 0.6)); truncated = true; }
    // 1518 and the dummy payer sometimes wrap the JWE as {"type":"JWEPayload","payload":...}: 4 of 1518's 24
    // callbacks on 20 Nov 2026 (real sandbox traffic), and the HIMS reads both (the reference HIMS).
    body = JSON.stringify(faults.jwePayloadWrapper ? { type: 'JWEPayload', payload: token } : { payload: token });
  }
  const times = faults.duplicateCallback ? 2 : 1;
  const results = [];
  for (let i = 0; i < times; i++) results.push(await post(url, body, cfg.callbackTimeoutMs, { chunked: !!faults.chunkedCallback }));
  return { url, header: h, bundle: cb.bundle, truncated, deliveries: results };
}

module.exports = { deliver, header, post, workflowFor, payerSender, isProtocolResponse, bare };
