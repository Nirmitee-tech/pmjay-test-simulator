'use strict';
// Builds request bundles in the shape the HIMS sends to 1518 (checked against the 19 Nov backup payloads:
// out-f469014d SN063D pre-auth, out-a59ca9d2 SB017A + IMP0129, out-c102a742 SN063D claim, out-e977c8d1 cancel Task).
// No personal data: synthetic names, the sandbox member SBXSTG269 only.

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\nxref\n0 1\n0000000000 65535 f \ntrailer<<>>\nstartxref\n9\n%%EOF').toString('base64');
const BAD_PDF = Buffer.from('not a pdf at all').toString('base64');

function line(code, o = {}) {
  const it = {
    sequence: o.sequence || 1,
    category: o.speciality === null ? undefined : { coding: [{ system: 'https://payer.pmjay.nha.gov.in', code: o.speciality || 'SG' }] },
    productOrService: { coding: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-procedure-code', code }] },
    quantity: o.quantity === undefined ? { value: 1 } : o.quantity === null ? undefined : { value: o.quantity },
    unitPrice: { value: o.amount != null ? o.amount : 12000, currency: 'INR' },
    net: { value: o.amount != null ? o.amount : 12000, currency: 'INR' },
  };
  if (o.strat) it.modifier = [{ coding: [{ system: 'https://payer.pmjay.nha.gov.in', code: o.strat, display: 'Routine Ward' }] }];
  if (o.informationSequence) it.informationSequence = o.informationSequence;
  return it;
}

function bundle(o = {}) {
  const use = o.use || 'preauthorization';
  const items = (o.items || [line('SG059A')]).map((it, i) => Object.assign(it, { sequence: i + 1 }));
  const total = o.total != null ? o.total : items.reduce((s, it) => s + it.net.value, 0);
  const si = [];
  if (o.admission !== false) si.push({ sequence: 1, category: { coding: [{ code: 'ONS' }] }, code: { coding: [{ code: 'ADDD' }] }, valueString: o.admitted || '2026-11-16T09:00:00+05:30' });
  if (o.discharged) si.push({ sequence: 2, category: { coding: [{ code: 'ONS' }] }, code: { coding: [{ code: 'DSDE' }] }, valueString: o.discharged });
  if (o.dis) si.push({ sequence: 3, category: { coding: [{ code: 'DIS' }] }, code: { coding: [{ code: o.dis[0] }] }, valueString: o.dis[1] });
  if (o.attachment !== undefined) si.push({ sequence: 4, category: { coding: [{ code: o.attachCategory || 'ATT' }] }, code: { coding: [{ code: 'FB' }] }, valueAttachment: { contentType: 'application/pdf', data: o.attachment === null ? undefined : o.attachment } });
  const claim = {
    resourceType: 'Claim', use, status: 'active',
    identifier: [{ value: o.admissionId || 'A/9027/26' }],
    billablePeriod: { start: o.admitted || '2026-11-16T09:00:00+05:30', end: o.discharged || '2026-11-18' },
    insurance: [Object.assign({ sequence: 1, focal: true, coverage: { reference: 'urn:uuid:cov' } }, o.preAuthRef ? { preAuthRef: [o.preAuthRef] } : {})],
    item: items, supportingInfo: si, total: { value: total, currency: 'INR' },
  };
  const entry = [
    { fullUrl: 'urn:uuid:claim', resource: claim },
    { fullUrl: 'urn:uuid:pat', resource: { resourceType: 'Patient', name: [{ text: 'TEST PARENT' }], gender: 'female', identifier: [{ type: { coding: [{ code: 'PMJAY' }] }, value: o.member || 'SBXSTG269' }],
      link: o.newborn ? [{ type: 'refer', other: { reference: 'urn:uuid:child' } }] : undefined } },
    { fullUrl: 'urn:uuid:cov', resource: { resourceType: 'Coverage', subscriberId: o.member || 'SBXSTG269', identifier: (o.policies || ['PMJAY/HP/S/G', 'PMJAY/HP/S/G']).map(v => ({ value: v })) } },
  ];
  if (o.newborn) entry.push({ fullUrl: 'urn:uuid:child', resource: { resourceType: 'Patient', name: [{ text: 'TEST CHILD' }], gender: 'male', birthDate: '2026-11-15' } });
  return { resourceType: 'Bundle', type: 'collection', entry };
}

function cover(o = {}) {
  const items = o.items || [{ productOrService: { coding: [{ code: 'SG059A' }] }, quantity: { value: 1 }, category: { coding: [{ code: 'SG' }] } }];
  return { resourceType: 'Bundle', entry: [
    { resource: { resourceType: 'CoverageEligibilityRequest', purpose: ['auth-requirements'], item: items } },
    { resource: { resourceType: 'Coverage', subscriberId: o.member || 'SBXSTG269', identifier: (o.policies || ['PMJAY/HP/S/G']).map(v => ({ value: v })) } },
  ] };
}
function ceLine(code, o = {}) {
  const it = { productOrService: { coding: [{ code }] }, quantity: o.quantity === undefined ? { value: 1 } : { value: o.quantity } };
  if (o.speciality !== null) it.category = { coding: [{ code: o.speciality || 'SG' }] };
  if (o.strat) it.modifier = [{ coding: [{ code: o.strat }] }];
  return it;
}

function cancelTask(caseNumber) {
  return { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Task', status: 'requested', intent: 'order',
    code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/financialtaskcode', code: 'cancel' }] },
    input: [{ type: { coding: [{ code: 'claimNumber' }] }, valueString: caseNumber }] } }] };
}
function planTask(policy) {
  return { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Task', code: { coding: [{ code: 'poll' }] },
    input: [{ type: { coding: [{ code: 'policyNumber' }] }, valueString: policy }] } }] };
}

let n = 0;
function req(action, b, headers) { n++; return { action, apiCallId: 'api-' + n, correlationId: 'corr-' + n, sender: 'hims@hcx', recipient: '1518@hcx', headers: headers || {}, bundle: b }; }

module.exports = { PDF, BAD_PDF, line, bundle, cover, ceLine, cancelTask, planTask, req };
