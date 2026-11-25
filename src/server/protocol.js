'use strict';
// NHA exchange protocol checks, run on every /v1/* call before the payer sees it.
//
// Each check names its source and whether the HTTP status, code and body it returns were seen in
// real NHA traffic ("real") or are our best reading of NHA's docs and the HIMS's notes ("predicted").
// Real samples: real sandbox messages (read 24 Nov 2026, messages before the
// mock existed). Codes and wording: NHA's Standard-Error-Codes, compiled in the reference HIMS code.
// A real code with a predicted trigger is marked predicted: we know what NHA says, not exactly when.
const crypto = require('crypto');
const jwe = require('./jwe');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESPONSE_STATUSES = ['response.complete', 'response.partial', 'response.error'];

// NHCX words, verbatim from the reference HIMS code, or from the real body where it differs.
const MSG = {
  'NHCX-401': 'Sender is not authorized to execute the operation.',           // real body, row 83 (10 Sep 2026)
  'NHCX-1002': 'Sender not registered in NHCX. Please register in NHCX portal and try again.',
  'NHCX-1003': 'Receiver not registered in NHCX. Please try again with valid receiver details.',
  'NHCX-1005': 'Invalid request header. Please try again with valid headers.',
  'NHCX-1006': 'Duplicate request. Request with same correlation id already exist in the system.',
  'NHCX-1007': 'Something went wrong while processing the request. Please check the request structure and values and try again.',
  'NHCX-1010': 'No Data with given Correlation id for call back request, please check status for more details',
  'NHCX-1011': 'Invalid Status, please check x-hcx-status value from the protected header',
  'NHCX-1012': 'No records found with the requested api caller id. Please try again with a valid api caller id.',
  'NHCX-1013': 'Invalid or blank request found.',
  'NHCX-1018': 'Invalid ABHA number received. ABHA number should be sent in the format XX-XXXX-XXXX-XXXX',
};

// entity_type in NHA's 202 and error bodies, per path, measured from real bodies (real sandbox bodies, 9 Sep to 24 Nov 2026).
// search/submit really answers "preauth" (48 rows). on_* paths not in the table use the path's entity.
const ENTITY = {
  'claim/submit': 'claim', 'communication/on_request': 'communication', 'coverageeligibility/check': 'coverageeligibility',
  'insuranceplan/request': 'insuranceplan', 'paymentnotice/on_request': 'payment', 'search/submit': 'preauth',
  'preauth/submit': 'preauthorization', 'predetermination/submit': 'predetermination', status: 'status', 'task/submit': 'task',
};
function entityType(action) {
  if (ENTITY[action]) return ENTITY[action];
  const e = String(action || '').split('/')[0];
  return e === 'paymentnotice' ? 'payment' : e === 'preauth' ? 'preauthorization' : e;
}

// The checks, for the UI and the report. real = status, code and body seen in real NHA traffic.
const CATALOGUE = {
  token: { name: 'Bearer token present, issued and not expired', code: 'NHCX-401', http: 401, real: true,
    source: 'real sandbox traffic (insuranceplan/request, 10 Sep 2026): 401, ids null; the reference HIMS code (The HIMS refreshes on 401)' },
  body: { name: 'Body is {"payload": "<JWE>"} and not blank', code: 'NHCX-1013', http: 400, real: false,
    source: 'the reference HIMS code (code and words); trigger predicted' },
  size: { name: 'Payload within the size limit', code: 'NHCX-1007', http: 400, real: false,
    source: 'no published limit found; limit and code predicted (PMJAY_MAX_PAYLOAD_BYTES)' },
  header: { name: 'JWE protected header is readable base64url JSON with 5 parts', code: 'NHCX-1005', http: 400, real: false,
    source: 'the reference HIMS code; trigger predicted' },
  alg: { name: 'alg RSA-OAEP-256 and enc A256GCM', code: 'NHCX-1005', http: 400, real: false,
    source: 'the reference HIMS code and every real request header (e.g. fixture two-packages-preauth); code predicted' },
  required: { name: 'x-hcx sender, recipient, api_call_id, correlation_id, timestamp, status present; workflow_id on a forward send', code: 'NHCX-1005', http: 400, real: false,
    source: 'G5 protocol headers (nhcx-claim skill); the reference HIMS code Create; code predicted' },
  uuid: { name: 'api_call_id, correlation_id (and request_id when sent) are UUIDs', code: 'NHCX-1005', http: 400, real: false,
    source: 'G5: "NHCX accepts no other spelling" (36 chars, 8-4-4-4-12); code predicted' },
  timestamp: { name: 'x-hcx-timestamp parses, is IST (+05:30) when ISO, and is inside the freshness window', code: 'NHCX-1005', http: 400, real: false,
    source: 'the reference HIMS code cites NHA handbook 1.3 ("UTC or other zones cause validation failures"); window and code predicted' },
  sender: { name: 'Sender is registered and active', code: 'NHCX-1002', http: 400, real: true,
    source: 'real sandbox traffic (predetermination/submit, 14 Sep 2026)' },
  senderToken: { name: 'Sender equals the participant the token was issued to', code: 'NHCX-401', http: 401, real: false,
    source: 'real 401 body (row 83) reused; trigger predicted' },
  recipient: { name: 'Recipient exists in the registry and is active', code: 'NHCX-1003', http: 400, real: true,
    source: 'real sandbox traffic (coverageeligibility/check, 29 Oct 2026)' },
  status: { name: 'x-hcx-status allowed for the action (request.initiated forward, response.* on on_*)', code: 'NHCX-1011', http: 400, real: false,
    source: 'the reference HIMS code ("sends response.complete on a submit and earns NHCX-1011"); no stored row; HTTP status predicted' },
  abha: { name: 'x-hcx-ben-abha-id empty, 14 digits, or XX-XXXX-XXXX-XXXX', code: 'NHCX-1018', http: 400, real: false,
    source: 'the reference HIMS code; 213 real sends with 14 bare digits were accepted (202); refusal trigger predicted' },
  apiCallUnique: { name: 'api_call_id not seen before (except /v1/status, which reuses the asked-about id)', code: 'NHCX-1006', http: 202, real: true,
    source: 'real sandbox traffic (preauth/submit, 18 Nov 2026): 202 with error NHCX-1006 and protocol_status request.queued; trigger (repeat of the same send) predicted' },
  conversation: { name: 'A reused correlation_id stays within one conversation (same two participants)', code: 'NHCX-1006', http: 202, real: false,
    source: 'real NHCX-1006 body; 15 real correlations carried more than one accepted forward send, so reuse itself is allowed; cross-pair trigger predicted' },
  onCorrelation: { name: 'on_* reply names a correlation the exchange knows', code: 'NHCX-1010', http: 400, real: true,
    source: 'real sandbox traffic (paymentnotice/on_request, Nov 2026); the reference HIMS code' },
  statusApiCall: { name: '/v1/status names a known api_call_id', code: 'NHCX-1012', http: 400, real: true,
    source: 'real sandbox traffic (status, 19 Oct 2026)' },
};

function pad(n, w) { return String(n).padStart(w || 2, '0'); }
/** NHA's body timestamp, IST: "dd/MM/yyyy HH:mm:ss" on a 202 (5129 of 6597 real 202s), with ":fff" on refusals (261 of 262 400s). */
function nhaStamp(ms, withMillis) {
  const d = new Date((ms == null ? Date.now() : ms) + 330 * 60000);
  const s = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMillis ? s + ':' + pad(d.getUTCMilliseconds(), 3) : s;
}

/** Real 202 body (fixture two-packages-preauth, 23 Nov 2026): error null, entity_type present. */
function ackBody(h, action, error) {
  h = h || {};
  return { timestamp: nhaStamp(), api_call_id: h['x-hcx-api_call_id'] || null, correlation_id: h['x-hcx-correlation_id'] || null,
    result: { sender_code: h['x-hcx-sender_code'] || null, recipient_code: h['x-hcx-recipient_code'] || null,
      entity_type: entityType(action), protocol_status: 'request.queued' }, error: error || null };
}
/** Real refusal body (real sandbox traffic): protocol_status request.error. On 401 the ids are null (row 83). */
function errorBody(h, action, code, message, nullIds) {
  h = nullIds ? {} : (h || {});
  return { timestamp: nhaStamp(null, true), api_call_id: h['x-hcx-api_call_id'] || null, correlation_id: h['x-hcx-correlation_id'] || null,
    result: { sender_code: h['x-hcx-sender_code'] || null, recipient_code: h['x-hcx-recipient_code'] || null,
      entity_type: entityType(action), protocol_status: 'request.error' },
    error: { code, message: message || MSG[code] || '' } };
}

/** Milliseconds since epoch, or null. Accepts ISO with offset, epoch millis or seconds (number or string). */
function parseTimestamp(v) {
  if (v == null || v === '') return { ms: null, why: 'missing' };
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return { ms: n < 1e12 ? n * 1000 : n, epoch: true };   // NHA's own ProtocolResponse sent seconds as a string (real sandbox traffic)
  }
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (!m) return { ms: null, why: 'not yyyy-MM-ddTHH:mm:ss+05:30 or epoch' };
  const ms = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (isNaN(ms)) return { ms: null, why: 'not a real date' };
  const off = m[8] === 'Z' ? '+00:00' : m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return { ms, offset: off };
}

function defaults() {
  return {
    enabled: process.env.PMJAY_PROTOCOL !== 'off',
    tokenTtlMs: 1200 * 1000,                     // the session answer's expiresIn 1200 (app.js)
    requireIssuedToken: true,
    maxPayloadBytes: Number(process.env.PMJAY_MAX_PAYLOAD_BYTES || 10 * 1024 * 1024),   // predicted
    maxPastMs: Number(process.env.PMJAY_TS_MAX_PAST_MS || 30 * 60 * 1000),              // predicted
    maxFutureMs: Number(process.env.PMJAY_TS_MAX_FUTURE_MS || 5 * 60 * 1000),           // predicted
    requireIst: true,
    // the code NHA puts on its /v1/on_status answer: NHCX-1019 from 2 Nov 2026 (12 rows), NHCX-1012 before (111 rows)
    statusAnswerCode: 'NHCX-1019',
  };
}

/**
 * opts: { participant(code) -> record|null, log (MessageLog), providerCode, settings }
 */
function create(opts) {
  const settings = Object.assign(defaults(), opts.settings || {});
  const tokens = new Map();      // token -> { issuedAt, expiresAt, participant }
  const apiCalls = new Map();    // api_call_id -> { action, correlationId }
  const conversations = new Map(); // correlation_id -> { a, b } participant pair (sorted)
  const now = opts.now || (() => Date.now());

  function issue(token, participant, ttlMs) {
    const t = now();
    tokens.set(token, { issuedAt: t, expiresAt: t + (ttlMs || settings.tokenTtlMs), participant: participant || opts.providerCode });
  }
  function expire(token) { const r = tokens.get(token); if (r) r.expiresAt = 0; }

  function bearerOf(headers) {
    const raw = headers['bearer_auth'] || headers['authorization'] || '';
    return String(raw).replace(/^Bearer\s+/i, '').trim();
  }
  function pair(a, b) { return [String(a || '').toLowerCase(), String(b || '').toLowerCase()].sort().join('|'); }

  /** Is a correlation known to the exchange: a request it carried, or a message the payer opened. */
  function knownCorrelation(corr) {
    if (conversations.has(corr)) return true;
    const items = (opts.log && opts.log.items) || [];
    return items.some(e => e.correlationId === corr ||
      (e.responses || []).some(r => r.header && r.header['x-hcx-correlation_id'] === corr));
  }
  function knownApiCall(id) {
    if (apiCalls.has(id)) return true;
    const items = (opts.log && opts.log.items) || [];
    return items.some(e => e.apiCallId === id);
  }

  /**
   * Run every check in order and stop at the first refusal, as an exchange would.
   * Returns { ok, checks: [{id, name, ok, detail, code, real, source}], refusal: {status, body} | null }.
   */
  function check({ action, headers, text, body }) {
    const checks = [];
    let refusal = null;
    let h = null;
    const pass = (id, detail) => { checks.push(Object.assign({ id, ok: true, detail: detail || '' }, CATALOGUE[id])); return true; };
    const fail = (id, detail, hdr, opt) => {
      const c = CATALOGUE[id];
      checks.push(Object.assign({ id, ok: false, detail }, c));
      const nullIds = c.http === 401;
      refusal = c.http === 202
        ? { status: 202, body: ackBody(hdr, action, { code: c.code, message: MSG[c.code] }) }
        : { status: c.http, body: errorBody(hdr, action, c.code, (opt && opt.message) || MSG[c.code], nullIds) };
      return false;
    };
    if (!settings.enabled) return { ok: true, checks: [], refusal: null, disabled: true };
    headers = headers || {};

    // 1. token
    const tok = bearerOf(headers);
    if (!tok) { fail('token', 'no bearer_auth header'); return done(); }
    const rec = tokens.get(tok);
    if (!rec && settings.requireIssuedToken) { fail('token', 'token was not issued by this exchange'); return done(); }
    if (rec && rec.expiresAt <= now()) { fail('token', 'token expired ' + Math.round((now() - rec.expiresAt) / 1000) + ' s ago'); return done(); }
    pass('token', rec ? 'issued ' + Math.round((now() - rec.issuedAt) / 1000) + ' s ago' : 'not tracked');

    // 2. body
    if (!body || typeof body.payload !== 'string' || !body.payload.trim()) { fail('body', 'expected {"payload": "<JWE>"}'); return done(); }
    pass('body');
    const size = Buffer.byteLength(text || body.payload);
    if (size > settings.maxPayloadBytes) { fail('size', size + ' bytes, limit ' + settings.maxPayloadBytes); return done(); }
    pass('size', size + ' bytes');

    // 3. header
    const parts = body.payload.split('.');
    try { h = jwe.peekHeader(body.payload); } catch (_) { h = null; }
    if (parts.length !== 5 || !h || typeof h !== 'object') { fail('header', parts.length !== 5 ? parts.length + ' JWE parts' : 'protected header not JSON'); return done(); }
    pass('header');
    if (h.alg !== 'RSA-OAEP-256' || h.enc !== 'A256GCM') { fail('alg', `alg ${h.alg} enc ${h.enc}`, h); return done(); }
    pass('alg');

    const isOn = /(^|\/)on_/.test(action);
    const need = ['x-hcx-sender_code', 'x-hcx-recipient_code', 'x-hcx-api_call_id', 'x-hcx-correlation_id', 'x-hcx-timestamp', 'x-hcx-status'];
    if (!isOn && action !== 'status') need.push('x-hcx-workflow_id');
    const missing = need.filter(k => h[k] == null || String(h[k]).trim() === '');
    if (missing.length) { fail('required', 'missing ' + missing.join(', '), h); return done(); }
    pass('required');

    const badIds = ['x-hcx-api_call_id', 'x-hcx-correlation_id', 'x-hcx-request_id'].filter(k => k in h && h[k] !== '' && !UUID.test(String(h[k])));
    if (badIds.length) { fail('uuid', badIds.map(k => k + '=' + h[k]).join(', '), h); return done(); }
    pass('uuid');

    const ts = parseTimestamp(h['x-hcx-timestamp']);
    if (ts.ms == null) { fail('timestamp', ts.why, h); return done(); }
    if (settings.requireIst && ts.offset && ts.offset !== '+05:30') { fail('timestamp', 'offset ' + ts.offset + ', NHCX wants IST +05:30', h); return done(); }
    const age = now() - ts.ms;
    if (age > settings.maxPastMs) { fail('timestamp', Math.round(age / 1000) + ' s old, window ' + Math.round(settings.maxPastMs / 1000) + ' s', h); return done(); }
    if (-age > settings.maxFutureMs) { fail('timestamp', Math.round(-age / 1000) + ' s in the future', h); return done(); }
    pass('timestamp', (age >= 0 ? Math.round(age / 1000) + ' s old' : Math.round(-age / 1000) + ' s ahead'));

    // 4. participants
    const sender = String(h['x-hcx-sender_code']);
    const recipient = String(h['x-hcx-recipient_code']);
    const sRec = opts.participant(sender);
    if (!sRec || String(sRec.status || '').toLowerCase() !== 'active') { fail('sender', sender + (sRec ? ' is ' + sRec.status : ' not in registry'), h); return done(); }
    pass('sender', sender);
    if (rec && rec.participant && sender.replace(/@hcx$/i, '').toLowerCase() !== String(rec.participant).replace(/@hcx$/i, '').toLowerCase()) {
      fail('senderToken', 'token belongs to ' + rec.participant + ', header says ' + sender, h); return done();
    }
    pass('senderToken');
    const rRec = opts.participant(recipient);
    if (!rRec || String(rRec.status || '').toLowerCase() !== 'active') { fail('recipient', recipient + (rRec ? ' is ' + rRec.status : ' not in registry'), h); return done(); }
    pass('recipient', recipient);

    // 5. status for the action
    const st = String(h['x-hcx-status']);
    const okStatus = isOn ? RESPONSE_STATUSES.includes(st) : st === 'request.initiated';
    if (!okStatus) { fail('status', st + ' on ' + action, h); return done(); }
    pass('status', st);

    const abha = h['x-hcx-ben-abha-id'];
    if (abha != null && abha !== '' && !/^\d{14}$/.test(String(abha)) && !/^\d{2}-\d{4}-\d{4}-\d{4}$/.test(String(abha))) { fail('abha', 'ben-abha-id ' + abha, h); return done(); }
    pass('abha');

    // 6. ids against what the exchange has seen
    const api = String(h['x-hcx-api_call_id']);
    const corr = String(h['x-hcx-correlation_id']);
    if (action === 'status') {
      if (!knownApiCall(api)) { fail('statusApiCall', 'api_call_id ' + api + ' never seen', h); return done(); }
      pass('statusApiCall');
    } else {
      if (apiCalls.has(api) || knownApiCall(api)) { fail('apiCallUnique', 'api_call_id ' + api + ' already used', h); return done(); }
      pass('apiCallUnique');
    }
    if (isOn) {
      if (!knownCorrelation(corr)) { fail('onCorrelation', 'correlation ' + corr + ' unknown', h); return done(); }
      pass('onCorrelation');
    } else if (action !== 'status') {
      const conv = conversations.get(corr);
      if (conv && conv !== pair(sender, recipient)) { fail('conversation', 'correlation ' + corr + ' belongs to ' + conv.replace('|', ' and '), h); return done(); }
      pass('conversation', conv ? 'continues a conversation' : 'new conversation');
    }
    return done();

    function done() {
      const ok = !refusal;
      if (ok && h) {
        if (action !== 'status') apiCalls.set(String(h['x-hcx-api_call_id']), { action, correlationId: h['x-hcx-correlation_id'] });
        const c = String(h['x-hcx-correlation_id']);
        if (!conversations.has(c)) conversations.set(c, pair(h['x-hcx-sender_code'], h['x-hcx-recipient_code']));
      }
      return { ok, checks, refusal, header: h };
    }
  }

  /** Record a correlation the payer opened (communication/request, paymentnotice/request), so the reply is known. */
  function opened(correlationId, a, b) { if (correlationId) conversations.set(String(correlationId), pair(a, b)); }

  return { check, issue, expire, opened, settings, tokens, ackBody, errorBody, entityType };
}

module.exports = { create, CATALOGUE, MSG, ackBody, errorBody, entityType, nhaStamp, parseTimestamp, UUID };
