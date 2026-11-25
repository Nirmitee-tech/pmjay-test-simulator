'use strict';
// Every setting has an env var; nothing secret lives here.
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

function env(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}

function load(over) {
  const c = {
    port: Number(env('PMJAY_PORT', 9300)),
    host: env('PMJAY_HOST', '0.0.0.0'),
    dataDir: env('PMJAY_DATA_DIR', path.join(ROOT, 'data')),
    // Where callbacks go. NHCX appends /v1/<entity>/on_* to the registered endpoint_url.
    callbackBase: env('PMJAY_CALLBACK_BASE', 'http://localhost:8081'),
    // The HIMS's public certificate (PEM file), to encrypt callbacks to. No default: set PMJAY_HIMS_CERT, or let
    // the HIMS register one through participant/update. Without either, callbacks are not sent and the UI says so.
    himsCertPath: env('PMJAY_HIMS_CERT', ''),
    payerCode: env('PMJAY_PAYER_CODE', '1518@hcx'),
    // NHA's registry name for 1518@hcx (participant/search, a real sandbox answer of 2026-11-20)
    payerName: env('PMJAY_PAYER_NAME', 'SHA HP'),
    // NHA's sandbox dummy payer. The mock answers as it too: holds pre-auths and claims until
    // /process/request names a decision, and sends a payment notice on /paymentNotice/init.
    dummyPayerCode: env('PMJAY_DUMMY_PAYER_CODE', '1000003538@hcx'),
    // The HIMS under test, as NHA's registry and 1518 name it. The defaults are clearly fake; set your own.
    providerCode: env('PMJAY_PROVIDER_PARTICIPANT_CODE', env('PMJAY_PROVIDER_CODE', '1000000001@hcx')),
    providerRegistryId: env('PMJAY_PROVIDER_REGISTRY_ID', 'IN0000000000'),
    providerId: env('PMJAY_PROVIDER_ID', '10001'),
    providerName: env('PMJAY_PROVIDER_NAME', 'TEST HOSPITAL'),
    // Optional JSON file of registry policy lists by "<identifiertype>:<value>", in the shape NHA's
    // participant/get/policies answers (see examples/policies.example.json). Unset: one mock policy per known member.
    policiesPath: env('PMJAY_POLICIES', ''),
    // Names for other payer codes on those lists (NHA's registry name for 1000003315@hcx).
    participantNames: JSON.parse(env('PMJAY_PARTICIPANT_NAMES', '{"1000003315@hcx":"ADITYA BIRLA HEALTH INSURANCE"}')),
    // get/policies finds a policy only for these; anything else is HTTP 400 NHCX-1016, as NHA answers it.
    // Members by id (the sandbox member SBXSTG269), and "<identifiertype>:<value>" pairs such as "MobileNo:9000000000".
    policyMembers: env('PMJAY_POLICY_MEMBERS', 'SBXSTG269').split(',').map(x => x.trim()).filter(Boolean),
    policyHolders: env('PMJAY_POLICY_HOLDERS', '').split(',').map(x => x.trim()).filter(Boolean),
    // When a pre-auth that needs 1518's review is decided in scenario auto. Empty (the default): it waits for the
    // desk, as 1518's human desk decided them (p50 8 min, up to days). A number: decided (approved) that many ms
    // after the request. Also settable with POST /mock/timing {"decisionDelayMs": n | null}.
    decisionDelayMs: env('PMJAY_DECISION_DELAY_MS', '') === '' ? null : Number(env('PMJAY_DECISION_DELAY_MS', '')),
    // NHA's on_status came 0.96 s and 1.18 s after the /v1/status 202 (real sandbox traffic, 13 Nov 2026).
    statusDelayMs: Number(env('PMJAY_STATUS_DELAY_MS', 1000)),
    // When set, the session refuses any other client id or secret (refusal body predicted; see README).
    clientId: env('PMJAY_CLIENT_ID', ''),
    clientSecret: env('PMJAY_CLIENT_SECRET', ''),
    defaultDelayMs: Number(env('PMJAY_DELAY_MS', 1500)),
    callbackTimeoutMs: Number(env('PMJAY_CALLBACK_TIMEOUT_MS', 20000)),
    logToFile: env('PMJAY_LOG_FILE', '1') !== '0',
  };
  return Object.assign(c, over || {});
}

module.exports = { load, ROOT };
