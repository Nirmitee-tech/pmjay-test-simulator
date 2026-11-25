'use strict';
// Test-side JWE encoder written step by step from the reference HIMS crypto code,
// kept separate from src/server/jwe.js so the round trip checks one implementation against another.
// It is a transcription, not output from the HIMS itself: no .NET runtime is on this machine.
const crypto = require('crypto');
const http = require('http');

function base64Url(bytes) { // the reference HIMS crypto: base64, trim '=', '+'->'-', '/'->'_'
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// The reference HIMS time stamp: yyyy-MM-ddTHH:mm:ss+, now (the exchange checks freshness)
function istStamp(ms) { return new Date((ms == null ? Date.now() : ms) + 330 * 60000).toISOString().replace(/\.\d+Z$/, '+05:30'); }

// The reference HIMS header builder, field order as the HIMS writes them
function himsHeader({ sender = '1000000001@hcx', recipient = '1518@hcx', workflowId = '12', correlationId = crypto.randomUUID(), status = 'request.initiated', apiCallId = crypto.randomUUID() } = {}) {
  return {
    alg: 'RSA-OAEP-256', enc: 'A256GCM',
    'x-hcx-sender_code': sender, 'x-hcx-recipient_code': recipient,
    'x-hcx-correlation_id': correlationId, 'x-hcx-api_call_id': apiCallId,
    'x-hcx-request_id': crypto.randomUUID(), 'x-hcx-workflow_id': workflowId, 'x-hcx-use_case': 'New',
    'x-hcx-status': status, 'x-hcx-timestamp': istStamp(), 'x-hcx-ben-abha-id': '',
  };
}

function himsEncrypt(payload, recipientPem, header, { oaepHash = 'sha256' } = {}) {
  const protectedHeader = base64Url(Buffer.from(JSON.stringify(header), 'utf8'));
  const aad = Buffer.from(protectedHeader, 'ascii');           // GCM AAD = ASCII of part [0]
  const cek = crypto.randomBytes(256 / 8);                     // CekBits 256
  const iv = crypto.randomBytes(12);                           // IvBytes 12
  const c = crypto.createCipheriv('aes-256-gcm', cek, iv, { authTagLength: 128 / 8 });
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(Buffer.from(payload, 'utf8')), c.final()]);
  const tag = c.getAuthTag();                                  // carried separately, part [4]
  const pub = recipientPem.includes('BEGIN CERTIFICATE') ? new crypto.X509Certificate(recipientPem).publicKey : crypto.createPublicKey(recipientPem);
  // OaepEncoding(RsaEngine, Sha256Digest): BouncyCastle uses the same digest for MGF1
  const encryptedKey = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, cek);
  return [protectedHeader, base64Url(encryptedKey), base64Url(iv), base64Url(ciphertext), base64Url(tag)].join('.');
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function preauthBundle(total = 25000) {
  return {
    resourceType: 'Bundle', id: crypto.randomUUID(), type: 'collection', timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: 'Claim/c1', resource: { resourceType: 'Claim', id: 'c1', status: 'active', use: 'preauthorization',
        patient: { reference: 'Patient/p1' }, total: { value: total, currency: 'INR' },
        insurer: { reference: 'Organization/payer' }, provider: { reference: 'Organization/hosp' } } },
      { fullUrl: 'Patient/p1', resource: { resourceType: 'Patient', id: 'p1', name: [{ text: 'Test Patient' }] } },
    ],
  };
}

function request(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }, headers || {}) }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, text: d, json: j }); });
    });
    r.on('error', reject); r.end(text);
  });
}

/** A stand-in for the HIMS's callback receiver: records each POST and answers 202 with the HIMS's ack shape. */
function listener() {
  const got = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    let d = ''; req.on('data', c => { d += c; });
    req.on('end', () => {
      got.push({ path: req.url, body: d, headers: req.headers });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { protocol_status: 'request.queued' }, error: { code: '', message: '' } }));
      for (const w of waiters.splice(0)) w();
    });
  });
  function waitFor(n, ms = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`expected ${n} callbacks, got ${got.length}`)), ms);
      const check = () => { if (got.length >= n) { clearTimeout(t); resolve(got); } else waiters.push(check); };
      check();
    });
  }
  return { server, got, waitFor };
}

/** A session token from the mock, as the HIMS gets one. */
async function session(port) { return (await request(port, 'POST', '/gateway/v0.5/sessions', { clientId: 'x', clientSecret: 'y' })).json.accessToken; }

module.exports = { istStamp, session, base64Url, himsHeader, himsEncrypt, keyPair, preauthBundle, request, listener };
