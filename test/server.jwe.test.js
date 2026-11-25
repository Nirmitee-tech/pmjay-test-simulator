'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jwe = require('../src/server/jwe');
const H = require('./server.helpers');

const pair = H.keyPair();

test('a JWE built the reference HIMS crypto way opens with the mock', () => {
  const header = H.himsHeader();
  const payload = JSON.stringify(H.preauthBundle());
  const token = H.himsEncrypt(payload, pair.publicPem, header);
  assert.strictEqual(token.split('.').length, 5);
  const out = jwe.decrypt(token, pair.privatePem);
  assert.strictEqual(out.payload, payload);
  assert.deepStrictEqual(out.header, header);
});

test('the mock encrypts so the reference HIMS crypto steps can open it (decrypt mirrors the reference HIMS crypto)', () => {
  const header = { alg: 'RSA-OAEP-256', enc: 'A256GCM', 'x-hcx-timestamp': Date.now() };
  const token = jwe.encrypt('{"a":1}', pair.publicPem, header);
  const [p0, ek, iv, ct, tag] = token.split('.');
  const cek = crypto.privateDecrypt({ key: pair.privatePem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, jwe.fromB64u(ek));
  assert.strictEqual(cek.length, 32);
  assert.strictEqual(jwe.fromB64u(iv).length, 12);
  assert.strictEqual(jwe.fromB64u(tag).length, 16);
  const d = crypto.createDecipheriv('aes-256-gcm', cek, jwe.fromB64u(iv));
  d.setAAD(Buffer.from(p0, 'ascii')); d.setAuthTag(jwe.fromB64u(tag));
  assert.strictEqual(Buffer.concat([d.update(jwe.fromB64u(ct)), d.final()]).toString(), '{"a":1}');
  assert.strictEqual(jwe.peekHeader(token)['x-hcx-timestamp'], header['x-hcx-timestamp']);
});

test('a self-signed certificate works as the recipient key', () => {
  const kp = require('../src/server/keys').ensure(require('path').join(__dirname, '..', 'data', 'test-keys'), '1518@hcx');
  const token = H.himsEncrypt('x', kp.certPem, H.himsHeader());
  assert.strictEqual(jwe.decrypt(token, kp.privatePem).payload, 'x');
});

test('OAEP with SHA-1 (the ABDM setting) is refused as an unwrap failure', () => {
  const token = H.himsEncrypt('x', pair.publicPem, H.himsHeader(), { oaepHash: 'sha1' });
  assert.throws(() => jwe.decrypt(token, pair.privatePem), e => e.code === 'UNWRAP');
});

test('an altered protected header fails the GCM tag', () => {
  const token = H.himsEncrypt('x', pair.publicPem, H.himsHeader()).split('.');
  const h = JSON.parse(jwe.fromB64u(token[0]).toString());
  h['x-hcx-recipient_code'] = 'someone-else@hcx';
  token[0] = H.base64Url(Buffer.from(JSON.stringify(h)));
  assert.throws(() => jwe.decrypt(token.join('.'), pair.privatePem), e => e.code === 'TAG');
});

test('a truncated JWE is refused with the part count', () => {
  const token = H.himsEncrypt('x', pair.publicPem, H.himsHeader());
  assert.throws(() => jwe.decrypt(token.split('.').slice(0, 4).join('.'), pair.privatePem), e => e.code === 'PARTS');
});

test('a key from another pair cannot open it', () => {
  const other = H.keyPair();
  const token = H.himsEncrypt('x', pair.publicPem, H.himsHeader());
  assert.throws(() => jwe.decrypt(token, other.privatePem), e => e.code === 'UNWRAP');
});
