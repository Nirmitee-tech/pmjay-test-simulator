'use strict';
// JWE compact serialisation exactly as the reference HIMS code builds it:
// alg RSA-OAEP-256 (OAEP with SHA-256 and MGF1 SHA-256, BouncyCastle OaepEncoding(RsaEngine, Sha256Digest)),
// enc A256GCM, 12-byte IV, 16-byte tag, AAD = ASCII bytes of the base64url protected header.
const crypto = require('crypto');

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toKeyObject(pem, isPrivate) {
  if (pem && typeof pem === 'object' && pem.type) return pem; // already a KeyObject
  if (isPrivate) return crypto.createPrivateKey(pem);
  // a certificate or a bare public key, both occur (the reference HIMS crypto)
  if (String(pem).includes('BEGIN CERTIFICATE')) return new crypto.X509Certificate(pem).publicKey;
  return crypto.createPublicKey(pem);
}

function encrypt(payload, publicPem, header) {
  const protectedHeader = b64u(Buffer.from(JSON.stringify(header), 'utf8'));
  const aad = Buffer.from(protectedHeader, 'ascii');
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ek = crypto.publicEncrypt(
    { key: toKeyObject(publicPem, false), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek);
  return [protectedHeader, b64u(ek), b64u(iv), b64u(ct), b64u(tag)].join('.');
}

class JweError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function peekHeader(jwe) {
  const first = String(jwe || '').split('.')[0];
  return JSON.parse(fromB64u(first).toString('utf8'));
}

function decrypt(jwe, privatePem) {
  if (!jwe) throw new JweError('EMPTY', 'Empty JWE.');
  const parts = String(jwe).split('.');
  if (parts.length !== 5) throw new JweError('PARTS', `Expected 5 JWE parts, got ${parts.length}.`);
  let header;
  try { header = JSON.parse(fromB64u(parts[0]).toString('utf8')); }
  catch (e) { throw new JweError('HEADER', 'Protected header is not base64url JSON.'); }
  if (header.alg !== 'RSA-OAEP-256' || header.enc !== 'A256GCM')
    throw new JweError('ALG', `Unsupported alg/enc ${header.alg}/${header.enc}; NHCX takes RSA-OAEP-256/A256GCM.`);
  let cek;
  try {
    cek = crypto.privateDecrypt(
      { key: toKeyObject(privatePem, true), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      fromB64u(parts[1]));
  } catch (e) {
    throw new JweError('UNWRAP', 'Could not unwrap the content key: the sender encrypted to a different certificate. ' + e.message);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', cek, fromB64u(parts[2]), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(parts[0], 'ascii'));
  decipher.setAuthTag(fromB64u(parts[4]));
  let pt;
  try { pt = Buffer.concat([decipher.update(fromB64u(parts[3])), decipher.final()]); }
  catch (e) { throw new JweError('TAG', 'GCM tag mismatch: payload or protected header altered.'); }
  return { header, payload: pt.toString('utf8') };
}

module.exports = { encrypt, decrypt, peekHeader, b64u, fromB64u, JweError };
