'use strict';
// The mock 1518@hcx key pair and self-signed certificate, made once into data/ (gitignored).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function ensure(dataDir, payerCode) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, 'payer-1518.key');
  const certPath = path.join(dataDir, 'payer-1518.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-keyout', keyPath, '-out', certPath, '-subj', `/CN=${payerCode} mock/O=pmjaymock`], { stdio: 'ignore' });
    } catch (e) {
      // No openssl: a bare public key. The HIMS's PublicKeyFromPem reads either form.
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      fs.writeFileSync(certPath, publicKey.export({ type: 'spki', format: 'pem' }));
    }
  }
  return {
    privatePem: fs.readFileSync(keyPath, 'utf8'),
    certPem: fs.readFileSync(certPath, 'utf8'),
    keyPath, certPath,
  };
}

module.exports = { ensure };
