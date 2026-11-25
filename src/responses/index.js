'use strict';
// Response builders shaped like the real 1518@hcx answers kept in fixtures/.
// Each shape below was copied from a real decrypted 1518 payload; the fixture folder that shows
// it is named next to each builder. Tests in test/responses.test.js compare the structure of
// every builder's output with that fixture.
//
// build(kind, ctx) -> FHIR object (a Bundle, or a ProtocolResponse object for kind 'error').
// Common ctx fields (all optional except where noted):
//  caseNumber  'A/9022/26' (falls back to the Claim identifier in ctx.bundle)
//  memberId   'SBXSTG269' (falls back to Coverage.subscriberId in ctx.bundle)
//  bundle    the decrypted request bundle the HIMS sent
//  now     Date used for timestamps (default: current time)
//  disposition free text
//  preAuthRef  'PMJAY/HP/S/2024/R2/2026112090000014' (default: made from date + ctx.seq)
//  items    [{sequence, submitted, approved, quantity, status}] (default: from Claim.item)

const SUBSETTED = { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED', display: 'Resource encoded in summary mode' };
const ADJ = 'https://hl7.org/fhir/R4/valueset-adjudication.html';
const CLN = { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code', code: 'CLN', display: 'Claim number' }] };
const PAYER_CODE = '1518';
// 1518 names the provider by its PMJAY hospital id on pre-auth answers and by its facility registry id
// on claim, coverage and payment answers (fixtures happy-preauth vs happy-claim). Both come from
// config (PMJAY_PROVIDER_ID, PMJAY_PROVIDER_REGISTRY_ID); the defaults are fakes the fixtures also use.
const PROVIDER = require('../server/config').load();
const PROVIDER_PREAUTH = PROVIDER.providerId;
const PROVIDER_OTHER = PROVIDER.providerRegistryId;
const PROVIDER_NAME = PROVIDER.providerName;

const STATUS = {
  queued: { outcome: 'queued', code: 'submitted', display: 'Submitted', item: 'Requested' },
  approved: { outcome: 'complete', code: 'approved', display: 'Approved', item: 'Approved' },
  // No real 1518 answer approved less than was claimed (see fixtures/INDEX.md). 'partial' keeps
  // the approved shape and lowers the eligible and benefit amounts; that amount split is a guess.
  partial: { outcome: 'complete', code: 'approved', display: 'Approved', item: 'Approved' },
  queried: { outcome: 'partial', code: 'queried', display: 'Queried', item: 'Queried' },
  rejected: { outcome: 'error', code: 'rejected', display: 'Rejected', item: 'Rejected' },
};

const DEFAULT_DISPOSITION = {
  queued: 'Request acknowledged and accepted for further processing.',
  queuedClaim: 'Claim request acknowledged and accepted for further processing.',
  approved: 'ok',
  partial: 'ok',
  queried: 'Provide Treating Doctors Prescription advising Hospitalization with diagnosis',
  rejected: 'The documents submitted do not support the claimed package for the stated diagnosis and duration of stay, hence the claim is rejected.',
};

// ---------------------------------------------------------------- helpers
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
// 1518 stamps IST with an explicit + offset.
function ist(d, ms) {
  const t = new Date(d.getTime() + 330 * 60000);
  const base = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  return (ms ? `${base}.${pad(t.getUTCMilliseconds(), 3)}` : base) + '+05:30';
}
function istDate(d) { return ist(d).slice(0, 10); }
function meta() { return { tag: [{ ...SUBSETTED }] }; }
function resources(bundle) { return ((bundle && bundle.entry) || []).map((e) => e.resource).filter(Boolean); }
function first(bundle, type) { return resources(bundle).find((r) => r.resourceType === type); }

function caseNumberOf(ctx) {
  if (ctx.caseNumber) return ctx.caseNumber;
  const c = first(ctx.bundle, 'Claim') || first(ctx.bundle, 'Task');
  const id = c && (c.identifier || []).find((i) => i.value);
  if (id) return id.value;
  const t = first(ctx.bundle, 'Task');
  const inp = t && (t.input || []).find((i) => i.valueString);
  return (inp && inp.valueString) || 'A/9001/26';
}
function memberIdOf(ctx) {
  if (ctx.memberId) return ctx.memberId;
  const cov = first(ctx.bundle, 'Coverage');
  return (cov && cov.subscriberId) || 'SBXSTG269';
}
// Bundle.id and ClaimResponse.id on every 1518 answer were the last segment of the case number
// ('26' for A/9022/26).
function shortId(caseNumber) { const p = String(caseNumber).split('/'); return p[p.length - 1]; }

// Real format: PMJAY/HP/S/2024/R2/ + yyyyMMdd + 8 digits starting 1000 (e.g. 2026112090000014).
function preAuthRefOf(ctx, now) {
  if (ctx.preAuthRef) return ctx.preAuthRef;
  const seq = String(ctx.seq != null ? ctx.seq : 1).padStart(4, '0');
  return `PMJAY/HP/S/2024/R2/${istDate(now).replace(/-/g, '')}1000${seq}`;
}

function itemsOf(ctx) {
  if (Array.isArray(ctx.items) && ctx.items.length) return ctx.items;
  const c = first(ctx.bundle, 'Claim');
  return ((c && c.item) || []).map((it) => ({
    sequence: it.sequence,
    submitted: Number((it.net && it.net.value) ?? (it.unitPrice && it.unitPrice.value) ?? 0),
    quantity: Number((it.quantity && it.quantity.value) ?? 1),
  }));
}
// 1518 priced each item at its own package rate: the item 'submitted' adjudication echoes what
// the hospital asked (500 for MN001A on A/9022/26) while 'eligible' and the totals use the
// package rate (1500). item.rate carries that rate; without it the asked amount is used.
// item.prior marks a package approved earlier (enhancement): it counts in the eligible total
// only, as in fixture enhancement-approved (submitted 12000, benefit 12000, eligible 13800).
function rateOf(it) { return Number(it.rate != null ? it.rate : (it.submitted || 0));
}

// ctx.disposition === null gives no disposition at all (some real approvals had none, fixture
// room-level-sn063d); undefined gives the default text.
function hasDispoValue(ctx) { return ctx.disposition !== undefined; }

function cat(code, display, withSystem = true) {
  return { coding: [withSystem ? { system: ADJ, code, display } : { code, display }] };
}

function total(code, display, value) { return { category: cat(code, display), amount: { value } }; }

function base(use, endpointPath) {
  return `https://payer.nha.gov.in/${endpointPath}/claimresponse`;
}

function payerOrg(prefix) {
  return {
    id: `${prefix}/organization/payer/${PAYER_CODE}`, fullUrl: `${prefix}/organization/payer/${PAYER_CODE}`,
    resource: {
      resourceType: 'Organization', id: PAYER_CODE, meta: meta(),
      identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NIIP', display: 'National Insurance Payor Identifier (Payor)' }] }, system: 'https://facility.abdm.gov.in', value: PAYER_CODE }],
      active: true,
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'pay', display: 'Payer' }] }],
      name: 'PMJAY',
    },
  };
}
function providerOrg(prefix, code) {
  return {
    id: `${prefix}/organization/provider/${code}`, fullUrl: `${prefix}/organization/provider/${code}`,
    resource: {
      resourceType: 'Organization', id: code, meta: meta(),
      identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NPI', display: 'National provider identifier' }] }, system: 'https://facility.abdm.gov.in', value: code }],
      active: true,
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider' }] }],
      name: PROVIDER_NAME,
    },
  };
}
function patientEntry(prefix, memberId, now, withDemographics = true) {
  const r = {
    resourceType: 'Patient', id: memberId,
    meta: { versionId: '1', lastUpdated: ist(now, true), tag: [{ ...SUBSETTED }] },
    identifier: [{ type: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code', code: 'PMJAY', display: 'Pradhan Mantri Jan Aarogya Yojana (PMJAY) ID' }] }, system: 'https://bis.pmjay.gov.in', value: memberId }],
  };
  if (withDemographics) {
    r.name = [{ text: 'TEST PATIENT', family: 'TEST PATIENT', given: ['TEST PATIENT'] }];
    r.gender = 'other';
    r.birthDate = '1990-01-01';
  }
  return { id: `${prefix}/patient/${memberId}`, fullUrl: `${prefix}/patient/${memberId}`, resource: r };
}
function coverageEntry(prefix, memberId, withClassValue) {
  const cls = { id: '100185', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'XV', display: 'Health Plan Identifier' }] } };
  if (withClassValue) cls.value = 'PMJAY/HP/S/2024/R2';
  return {
    id: `${prefix}/coverage/100155`, fullUrl: `${prefix}/coverage/100155`,
    resource: {
      resourceType: 'Coverage', id: '100155', meta: meta(),
      identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NH', display: 'National Health Plan Identifier' }] }, system: 'https://payer.pmjay.gov.in', value: 'PMJAY/HP/S/G' }],
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'HIP', display: 'health insurance plan policy' }] },
      beneficiary: { reference: `${prefix}/patient/${memberId}` },
      period: { start: '2023-04-02T00:00:00+05:30', end: '2028-04-02T00:00:00+05:30' },
      payor: [{ reference: `${prefix}/organization/payer/${PAYER_CODE}` }],
      class: [cls],
    },
  };
}

function collection(caseNumber, now, entries, identifierSystem = 'https://payer.pmjay.nha.gov.in') {
  return {
    resourceType: 'Bundle', id: shortId(caseNumber),
    meta: { lastUpdated: ist(now, true), tag: [{ ...SUBSETTED }] },
    identifier: { system: identifierSystem, value: caseNumber },
    type: 'collection', timestamp: ist(now, true),
    entry: entries,
  };
}

// ---------------------------------------------------------------- ClaimResponse
// Shapes: fixtures happy-preauth (ack + approved), happy-claim, preauth-rejected, preauth-queried,
// claim-queried, claim-rejected, enhancement-approved (two items).
function claimResponse(use, status, ctx) {
  const st = STATUS[status];
  if (!st) throw new Error(`unknown claim status ${status}`);
  const now = ctx.now || new Date();
  const caseNumber = caseNumberOf(ctx);
  const memberId = memberIdOf(ctx);
  const isPreauth = use === 'preauthorization';
  const prefix = isPreauth
    ? base(use, 'preauthorization/v1/preauth/on_submit')
    : base(use, 'claim/v1/claim/on_submit');
  const provider = isPreauth ? PROVIDER_PREAUTH : PROVIDER_OTHER;
  const items = itemsOf(ctx);
  const dispo = hasDispoValue(ctx) ? ctx.disposition : (status === 'queued' ? (isPreauth ? DEFAULT_DISPOSITION.queued : DEFAULT_DISPOSITION.queuedClaim) : DEFAULT_DISPOSITION[status]);
  const reasonText = ctx.itemReason || (status === 'approved' || status === 'partial' || status === 'queued' ? ` : ${DEFAULT_DISPOSITION.queued}` : (dispo || ''));

  let submittedTotal = 0;
  let eligibleTotal = 0;
  let newEligible = 0;
  const outItems = items.map((it) => {
    const submitted = Number(it.submitted || 0);
    const rate = rateOf(it);
    const qty = Number(it.quantity || 1);
    let eligible = 0;
    let pct = 0;
    let quant = 0;
    if (status === 'approved' || status === 'partial') {
      eligible = it.approved != null ? Number(it.approved) : rate;
      if (status === 'partial' && it.approved == null) eligible = Math.round(rate * (ctx.approvedRatio ?? 0.8));
      pct = rate ? Math.round((eligible / rate) * 100) : 0;
      quant = qty;
    } else if (status === 'queried') {
      eligible = rate; // real: eligible kept, eligpercent 0 (preauth) or 100 (claim)
      pct = isPreauth ? 0 : 100;
    }
    if (!it.prior) { submittedTotal += rate; newEligible += eligible; }
    eligibleTotal += eligible;
    const itemStatus = it.status || st.item;
    return {
      id: `Item/Item/${it.sequence}`,
      itemSequence: it.sequence,
      adjudication: [
        { category: cat('submitted', 'Submitted Amount'), amount: { value: submitted } },
        { category: cat('eligible', 'Eligible Amount'), amount: { value: eligible } },
        { category: cat('reason', 'Reason for Adjudication'), reason: { coding: [{ display: reasonText }] } },
        { category: cat('eligpercent', 'Eligible %'), value: pct },
        { category: cat('eligquant', 'Eligible Quantity'), value: quant },
        { category: cat('status', 'Item adjudication status'), reason: { coding: [{ code: itemStatus, display: itemStatus }] } },
      ],
    };
  });
  const benefit = status === 'approved' || status === 'partial' ? (ctx.benefit != null ? ctx.benefit : newEligible) : 0;
  const submittedSum = ctx.submittedTotal != null ? ctx.submittedTotal : submittedTotal;

  const cr = {
    resourceType: 'ClaimResponse', id: shortId(caseNumber), meta: meta(),
    identifier: [{ type: CLN, system: 'https://hcx.pmjay.gov.in/v1/preauthorization', value: caseNumber }],
    status: 'active',
  };
  // Only the pre-auth ack carried ClaimResponse.type in the real answers.
  if (isPreauth && status === 'queued') cr.type = { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/ValueSet/ndhm-claim-type', code: '737481003', display: 'Inpatient care management (procedure)' }] };
  Object.assign(cr, {
    use,
    patient: { reference: `${prefix}/patient/${memberId}` },
    created: ist(now),
    insurer: { reference: `${prefix}/organization/payer/${PAYER_CODE}` },
    requestor: { reference: `${prefix}/organization/provider/${provider}` },
    outcome: st.outcome,
  });
  if (dispo != null) cr.disposition = dispo;
  // Real: pre-auth answers always carry preAuthRef; claim answers only on the queued ack.
  if (isPreauth || status === 'queued') cr.preAuthRef = preAuthRefOf(ctx, now);
  cr.payeeType = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/payeetype', code: 'provider', display: 'Provider' }] };
  cr.item = outItems;
  cr.adjudication = [{ category: cat('status', 'Status', false), reason: { coding: [{ code: st.code, display: st.display }] } }];
  cr.total = [
    total('benefit', 'Benefit Amount', benefit),
    total('submitted', 'Submitted Amount', submittedSum),
    total('tax', 'Tax', 0),
    total('incentive', 'Hospital Incentive', 0),
    { id: `${memberId}/PMJAY-T`, category: cat('eligible', 'Eligible Amount', false), amount: { value: status === 'rejected' ? 0 : (status === 'queued' ? 0 : (status === 'queried' && isPreauth ? 0 : eligibleTotal)) } },
  ];
  // The claim ack's eligible total had no amount at all (fixture happy-claim/response-ack).
  if (!isPreauth && status === 'queued') delete cr.total[4].amount;

  return collection(caseNumber, now, [
    { id: `${prefix}/${caseNumber}`, fullUrl: `${prefix}/${caseNumber}`, resource: cr },
    patientEntry(prefix, memberId, now),
    payerOrg(prefix),
    providerOrg(prefix, provider),
    // Coverage.class.value was present on pre-auth answers and the claim ack, absent on final claim answers.
    coverageEntry(prefix, memberId, isPreauth || status === 'queued'),
  ]);
}

// ---------------------------------------------------------------- CoverageEligibilityResponse
// Shape: fixture happy-coverage. 1518 echoes every request entry (with SUBSETTED tags added and
// ids dropped) and appends its own response, patient, coverage and organizations.
function coverageResponse(ctx) {
  const now = ctx.now || new Date();
  const memberId = memberIdOf(ctx);
  const prefix = 'https://payer.nha.gov.in/coverageeligibility/v1/coverageeligibility/on_check/coverageeligibilityresponse';
  const req = first(ctx.bundle, 'CoverageEligibilityRequest');
  const reqEntry = ((ctx.bundle && ctx.bundle.entry) || []).find((e) => e.resource && e.resource.resourceType === 'CoverageEligibilityRequest');
  const reqUrl = (reqEntry && reqEntry.fullUrl) || `urn:uuid:${(req && req.id) || '00000000-0000-0000-0000-000000000000'}`;
  const bundleId = reqUrl.startsWith('urn:uuid:') ? reqUrl : `urn:uuid:${reqUrl}`;
  const echoed = ((ctx.bundle && ctx.bundle.entry) || []).map((e) => {
    const r = JSON.parse(JSON.stringify(e.resource));
    delete r.id;
    r.meta = Object.assign({}, r.meta, { tag: [{ ...SUBSETTED }] });
    return { fullUrl: e.fullUrl, resource: r };
  });
  const allowed = ctx.allowed != null ? ctx.allowed : 395300.0;
  const used = ctx.used != null ? ctx.used : 104700.0;
  const respId = `${memberId}-${PROVIDER_OTHER}`;
  const resp = {
    resourceType: 'CoverageEligibilityResponse', id: respId,
    meta: { profile: ['http://hl7.org/fhir/StructureDefinition/CoverageEligibilityResponse'], tag: [{ ...SUBSETTED }] },
    identifier: [{ system: 'https://hcx.pmjay.gov.in/v1/coverageeligibility/check', value: respId }],
    status: 'active', purpose: ['validation'],
    patient: { reference: `${prefix}/patient/${memberId}` },
    created: ist(now),
    requestor: { reference: `${prefix}/organization/provider/${PROVIDER_OTHER}` },
    request: { reference: bundleId },
    outcome: 'complete',
    disposition: ctx.disposition || 'Policy is currently in-force',
    insurer: { reference: `${prefix}/organization/payer/${PAYER_CODE}@hcx` },
    insurance: [{
      coverage: { reference: `${prefix}/coverage/100155${memberId}` },
      inforce: ctx.inforce !== false,
      item: [{
        productOrService: { coding: [{ system: 'http://snomed.info/sct0', code: '305056002', display: 'Admission procedure' }] },
        benefit: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/benefit-type', code: 'benefit', display: 'Benefit' }] }, allowedMoney: { value: allowed, currency: 'INR' }, usedMoney: { value: used, currency: 'INR' } }],
        authorizationRequired: true,
      }],
    }],
  };
  // Payer-side entries as in fixture happy-coverage: full demographics (fake here), two payer
  // Organizations (…/1518 and …/1518@hcx, both valued 1518@hcx, named SHA HP), no Organization ids.
  const pat = patientEntry(prefix, memberId, now, true);
  Object.assign(pat.resource, {
    identifier: [
      ...pat.resource.identifier,
      { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'JHN', display: 'Jurisdictional health number' }] }, system: 'https://bis.pmjay.gov.in', value: 'FAKE00000001' },
      { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PI', display: 'Patient internal identifier' }] }, system: 'https://provider.pmjay.gov.in', value: 'FAKE00000002' },
      { type: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code', code: 'ABHA', display: 'Ayushman Bharat Health Account (ABHA) ID' }] }, system: 'https://bis.pmjay.gov.in', value: '91-0000-0000-0000' },
      { type: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code', code: 'ADN', display: 'Adhaar number' }] }, system: 'https://bis.pmjay.gov.in', value: 'FAKE00000003' },
    ],
    telecom: [{ system: 'phone', value: '9000000000', use: 'home' }],
    gender: 'female', birthDate: '1990-01-01', deceasedBoolean: false,
    address: [{ use: 'home', type: 'both', line: ['1 Test Street'], district: 'TEST DISTRICT', state: 'HIMACHAL PRADESH', postalCode: '000000' }],
  });
  const cov = coverageEntry(prefix, memberId, true);
  cov.fullUrl = cov.id = `${prefix}/coverage/100155${memberId}`;
  const cr = cov.resource;
  const { beneficiary, period, payor } = cr;
  delete cr.beneficiary; delete cr.period; delete cr.payor; delete cr.class;
  Object.assign(cr, {
    subscriber: { reference: `${prefix}/patient/${memberId}` }, beneficiary,
    relationship: { coding: [{ system: 'https://terminology.hl7.org/6.5.0/CodeSystem-subscriber-relationship.html', code: 'self', display: 'Self' }] },
    period, payor,
    class: [{ id: '100185', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'XV', display: 'Health Plan Identifier' }] }, value: 'PMJAY/HP/S/2024/R2', name: 'PMJAY for Himachal' }],
  });
  const shaPayer = (url) => {
    const e = payerOrg(prefix);
    e.fullUrl = e.id = url;
    delete e.resource.id;
    e.resource.identifier[0].value = `${PAYER_CODE}@hcx`;
    e.resource.name = 'SHA HP';
    e.resource.contact = [{ telecom: [{ system: 'phone', value: '9000000001' }] }];
    return e;
  };
  const payer = shaPayer(`${prefix}/organization/payer/${PAYER_CODE}`);
  const payerHcx = shaPayer(`${prefix}/organization/payer/${PAYER_CODE}@hcx`);
  const prov = providerOrg(prefix, PROVIDER_OTHER);
  delete prov.resource.id;
  prov.resource.name = PROVIDER_NAME;
  prov.resource.contact = [{ telecom: [{ system: 'phone', value: 'NA' }] }];
  return {
    resourceType: 'Bundle', id: bundleId,
    meta: { lastUpdated: ist(now, true), tag: [{ ...SUBSETTED }] },
    identifier: { system: 'https://payer.pmajy.nha.gov.in', value: bundleId },
    type: 'collection', timestamp: ist(now, true),
    entry: [
      ...echoed,
      { id: `${prefix}/${memberId}`, fullUrl: `${prefix}/${memberId}`, resource: resp },
      pat, cov, payer, payerHcx, prov,
    ].map((e) => { const o = { fullUrl: e.fullUrl, resource: e.resource }; if (e.id) o.id = e.id; return o; }),
  };
}

// ---------------------------------------------------------------- Task replies
// Shapes: preauth-cancel (fixture preauth-cancel, completed, ClaimResponse status cancelled) and claim-reprocess
// (fixture claim-reprocess, accepted, ClaimResponse queued). Note 'payer.pmajy' is 1518's own spelling.
function taskReply(mode, ctx) {
  const now = ctx.now || new Date();
  const caseNumber = caseNumberOf(ctx);
  const memberId = memberIdOf(ctx);
  const reqTask = first(ctx.bundle, 'Task');
  const prefix = 'https://payer.nha.gov.in/v1/task/on_submit/claimresponse';
  const isCancel = mode === 'cancel';
  const description = ctx.disposition || (isCancel
    ? ((reqTask && reqTask.description) || 'Pre-auth cancelled.')
    : 'Arbitration claim submission process completed successfully. Case is now available with the payer for further adjudication.');
  const task = {
    resourceType: 'Task', meta: meta(),
    status: isCancel ? 'completed' : 'accepted',
    intent: 'order',
    code: { coding: [{ system: 'http://hl7.org/fhir/CodeSystem/task-code', code: 'approve', display: 'Activate/approve the focal resource' }] },
    description,
    authoredOn: ist(now),
    requester: { reference: `${prefix}/organization/payer/${PAYER_CODE}` },
    owner: { reference: `${prefix}/organization/provider/${PROVIDER_PREAUTH}` },
    output: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype', code: 'include', display: 'Include' }] }, valueReference: { reference: `${prefix}/${caseNumber}` } }],
  };
  const zero = (c, d) => total(c, d, 0);
  const cr = {
    resourceType: 'ClaimResponse', id: shortId(caseNumber), meta: meta(),
    identifier: [{ type: CLN, system: 'https://hcx.pmjay.gov.in/v1/preauthorization', value: caseNumber }],
    status: 'active',
    type: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/ValueSet/ndhm-claim-type', code: '737492002', display: 'Outpatient care management (procedure)' }] },
    use: isCancel ? 'preauthorization' : 'claim',
    patient: { reference: `${prefix}/patient/${memberId}` },
    created: ist(now),
    insurer: { reference: `${prefix}/organization/payer/${PAYER_CODE}` },
    requestor: { reference: `${prefix}/organization/provider/${PROVIDER_PREAUTH}` },
    outcome: isCancel ? 'complete' : 'queued',
    disposition: description,
    payeeType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/payeetype', code: 'provider', display: 'Provider' }] },
    adjudication: [{ category: cat('status', 'Status', false), reason: { coding: isCancel ? [{ code: 'cancelled', display: 'Cancelled' }] : [{ code: 'submitted', display: 'Submitted' }] } }],
    total: [zero('benefit', 'Benefit Amount'), zero('submitted', 'Submitted Amount'), zero('tax', 'Tax'), zero('incentive', 'Hospital Incentive')],
  };
  const pat = patientEntry(prefix, memberId, now, false);
  return collection(caseNumber, now, [
    { fullUrl: `https://payer.nha.gov.in/v1/task/on_submit/${caseNumber}`, resource: task },
    { id: `${prefix}/${caseNumber}`, fullUrl: `${prefix}/${caseNumber}`, resource: cr },
    pat,
    payerOrg(prefix),
    providerOrg(prefix, PROVIDER_PREAUTH),
    // Both task replies put Coverage under the claim url. The cancel reply kept class.value and
    // the reprocess reply dropped it. Copied as seen.
    coverageEntry('https://payer.nha.gov.in/claim/v1/claim/on_submit/claimresponse', memberId, isCancel),
  ], 'https://payer.pmajy.nha.gov.in');
}

// ---------------------------------------------------------------- Payment notice (1518 -> the HIMS)
// Shape: fixture payment-notice request.json (fixture payment-notice).
function paymentNotice(ctx) {
  const now = ctx.now || new Date();
  const caseNumber = caseNumberOf(ctx);
  const amount = Number(ctx.amount != null ? ctx.amount : 0);
  const pre = 'https://payer.nha.gov.in/v1/paymentnotice/request';
  const ref = preAuthRefOf(ctx, now).split('/').pop();
  const placer = `${PROVIDER_PREAUTH}/${ref}/N`;
  const task = {
    resourceType: 'Task', meta: meta(), status: 'requested', intent: 'order',
    code: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-task-codes', code: 'deliver', display: 'deliver' }] },
    description: 'Payment initiated',
    authoredOn: ist(now),
    requester: { reference: `${pre}/organization/payer/${PAYER_CODE}` },
    owner: { reference: `${pre}/organization/provider/${PROVIDER_OTHER}` },
    input: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype', code: 'status', display: 'Status code' }] }, valueReference: { reference: `${pre}/${caseNumber}` } }],
  };
  const notice = {
    resourceType: 'PaymentNotice', meta: meta(),
    identifier: [{ type: CLN, system: 'https://hcx.pmjay.gov.in/v1/preauthorization', value: caseNumber }],
    status: 'active', created: ist(now),
    payment: { reference: `${pre}/paymentreconciliation/${caseNumber}` },
    recipient: { reference: `${pre}/organization/provider/${PROVIDER_OTHER}` },
    amount: { value: amount, currency: 'INR' },
    paymentStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/paymentstatus', code: 'paid', display: 'Paid' }] },
  };
  const recon = {
    resourceType: 'PaymentReconciliation', meta: meta(),
    identifier: [{ type: CLN, system: 'https://hcx.pmjay.gov.in/v1/preauthorization', value: caseNumber }],
    status: 'active', created: ist(now), disposition: 'Payment initiated',
    paymentDate: istDate(now),
    paymentAmount: { value: amount, currency: 'INR' },
    paymentIdentifier: { type: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code', code: 'UTR', display: 'Unique Transaction Reference' }] }, system: 'https://payer.gov.in', value: ctx.utr || 'NA' },
    // 'https://https://' is how 1518 sent it.
    detail: [{ id: placer, identifier: { type: { coding: [{ system: 'https://https://nrces.in/ndhm/fhir/r4/ValueSet-ndhm-identifier-type-code.html', code: 'PLAC', display: 'Placer Identifier' }] }, system: 'https://hcx.pmjay.gov.in/v1/claim', value: placer }, type: { coding: [{ system: 'http://hl7.org/fhir/ValueSet/payment-type', code: 'Payment', display: 'Payment' }] }, date: istDate(now), amount: { value: amount } }],
  };
  const prov = providerOrg(pre, PROVIDER_OTHER);
  const payer = payerOrg(pre);
  delete payer.resource.name; // the real payment notice payer Organization had no name
  return collection(caseNumber, now, [
    { fullUrl: `https://payer.nha.gov.in/task/v1/paymentnotice/request/${caseNumber}`, resource: task },
    { fullUrl: `${pre}/${caseNumber}`, resource: notice },
    { id: `${pre}/paymentreconciliation/${caseNumber}`, fullUrl: `${pre}/paymentreconciliation/${caseNumber}`, resource: recon },
    prov, payer,
  ], 'https://payer.pmajy.nha.gov.in');
}

// ---------------------------------------------------------------- Communication request
// No real 1518 communication/request exists (fixtures/INDEX.md). This follows the 1518
// conventions above (SUBSETTED tags, payer.nha.gov.in urls, CLN identifier) plus the NRCES
// CommunicationRequest fields. It is a prediction of the shape, not a copy of a real one.
function communicationRequest(ctx) {
  const now = ctx.now || new Date();
  const caseNumber = caseNumberOf(ctx);
  const memberId = memberIdOf(ctx);
  const pre = 'https://payer.nha.gov.in/v1/communication/request';
  const cr = {
    resourceType: 'CommunicationRequest', meta: meta(),
    identifier: [{ type: CLN, system: 'https://hcx.pmjay.gov.in/v1/preauthorization', value: caseNumber }],
    status: 'active',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/communication-category', code: 'instruction', display: 'Instruction' }] }],
    priority: 'routine',
    subject: { reference: `${pre}/patient/${memberId}` },
    about: [{ reference: `${pre}/claimresponse/${caseNumber}` }],
    payload: [{ contentString: ctx.disposition || 'Please upload the requested document.' }],
    authoredOn: ist(now),
    requester: { reference: `${pre}/organization/payer/${PAYER_CODE}` },
    recipient: [{ reference: `${pre}/organization/provider/${PROVIDER_OTHER}` }],
  };
  return collection(caseNumber, now, [
    { fullUrl: `${pre}/${caseNumber}`, resource: cr },
    patientEntry(pre, memberId, now, false),
    payerOrg(pre),
    providerOrg(pre, PROVIDER_OTHER),
  ], 'https://payer.pmajy.nha.gov.in');
}

// ---------------------------------------------------------------- ProtocolResponse error
// Shape: every error-* fixture. 1518 used sender '1518@hcx' on coverage errors and '1518' on
// pre-auth and claim errors; x-hcx-entity-type was 'coverageeligibility' on coverage errors and
// null elsewhere.
// Two header styles were seen, apparently from two stages inside 1518:
//  sender '1518@hcx' + entity type of the endpoint: every coverage error, claim PAYR-1008 and
//  PAYR-1372, insuranceplan PAYR-1402 (entity null there, workflow id '4');
//  sender '1518' + entity null: pre-auth errors and claim PAYR-1323, PAYR-1357; search errors
//  use sender '1518' with entity 'search'.
// GATEWAY_STYLE_CODES records the 1518@hcx style per code as seen; unknown codes follow the endpoint default.
const GATEWAY_STYLE_CODES = new Set(['PAYR-1008', 'PAYR-1372', 'PAYR-1402']);
function protocolError(ctx) {
  const now = ctx.now || new Date();
  const ep = String(ctx.endpoint || ctx.action || '');
  const entity = (ep.replace(/^\/?(v1\/)?/, '').split('/')[0]) || null;
  const isCoverage = entity === 'coverageeligibility';
  const gateway = isCoverage || GATEWAY_STYLE_CODES.has(ctx.code) || ctx.stage === 'gateway';
  let entityType = null;
  if (entity === 'search') entityType = 'search';
  else if (gateway && entity !== 'insuranceplan') entityType = entity;
  return {
    type: 'ProtocolResponse',
    'x-hcx-sender_code': ctx.sender || (gateway ? '1518@hcx' : '1518'),
    'x-hcx-recipient_code': ctx.recipient || PROVIDER.providerCode.replace(/@hcx$/i, ''),
    // 1518's refusal carries an api_call_id of its own, not the request's (real sandbox traffic -> real sandbox traffic -> real sandbox traffic)
    'x-hcx-api_call_id': ctx.responseApiCallId || require('crypto').randomUUID(),
    'x-hcx-correlation_id': ctx.correlationId || null,
    'x-hcx-workflow_id': ctx.workflowId != null ? String(ctx.workflowId) : null,
    'x-hcx-timestamp': String(Math.floor(now.getTime() / 1000) * 1000),
    'x-hcx-debug_flag': null,
    'x-hcx-status': 'response.error',
    'x-hcx-redirect_to': null,
    'x-hcx-error_details': { code: ctx.code || 'PAYR-1000', message: ctx.message || 'Request will not be processed further.', trace: null },
    'x-hcx-debug_details': null,
    'x-hcx-domain-header': null,
    'x-hcx-entity-type': entityType,
    'x-hcx-ben-abha-id': null,
  };
}

// ---------------------------------------------------------------- dispatch
const KINDS = {
  coverage: (ctx) => coverageResponse(ctx),
  'preauth.queued': (ctx) => claimResponse('preauthorization', 'queued', ctx),
  'preauth.approved': (ctx) => claimResponse('preauthorization', 'approved', ctx),
  'preauth.partial': (ctx) => claimResponse('preauthorization', 'partial', ctx),
  'preauth.queried': (ctx) => claimResponse('preauthorization', 'queried', ctx),
  'preauth.rejected': (ctx) => claimResponse('preauthorization', 'rejected', ctx),
  'claim.queued': (ctx) => claimResponse('claim', 'queued', ctx),
  'claim.approved': (ctx) => claimResponse('claim', 'approved', ctx),
  'claim.partial': (ctx) => claimResponse('claim', 'partial', ctx),
  'claim.queried': (ctx) => claimResponse('claim', 'queried', ctx),
  'claim.rejected': (ctx) => claimResponse('claim', 'rejected', ctx),
  'task.cancel': (ctx) => taskReply('cancel', ctx),
  'task.reprocess': (ctx) => taskReply('reprocess', ctx),
  'communication.request': (ctx) => communicationRequest(ctx),
  'paymentnotice.request': (ctx) => paymentNotice(ctx),
  error: (ctx) => protocolError(ctx),
};
// Which builders copy a real 1518 shape and which are predictions.
const SHAPE_SOURCE = {
  coverage: 'happy-coverage', 'preauth.queued': 'happy-preauth/response-ack', 'preauth.approved': 'happy-preauth',
  'preauth.partial': 'none (approved shape, amounts predicted)', 'preauth.queried': 'preauth-queried', 'preauth.rejected': 'preauth-rejected',
  'claim.queued': 'happy-claim/response-ack', 'claim.approved': 'happy-claim', 'claim.partial': 'none (approved shape, amounts predicted)',
  'claim.queried': 'claim-queried', 'claim.rejected': 'claim-rejected', 'task.cancel': 'preauth-cancel', 'task.reprocess': 'claim-reprocess',
  'communication.request': 'none (predicted)', 'paymentnotice.request': 'payment-notice/request', error: 'error-*',
};

function build(kind, ctx = {}) {
  const fn = KINDS[kind];
  if (!fn) throw new Error(`unknown response kind '${kind}'. Known: ${Object.keys(KINDS).join(', ')}`);
  return fn(ctx);
}

module.exports = { build, kinds: Object.keys(KINDS), SHAPE_SOURCE, _internal: { ist, preAuthRefOf, caseNumberOf } };
