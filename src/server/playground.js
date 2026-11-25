'use strict';
// Learning playground: pick a scenario and a patient, see what the mock 1518 will do, then send it.
// Every request starts from a real request the HIMS sent to 1518 (fixtures/<folder>/request.json), with the member swapped
// and the case number linked to the case the mock opened earlier in the same run. It then goes through engine.handle(),
// the same path a HIMS request takes (rules.validate, the decision, responses.build). Nothing here calls NHA or 1518.
//
// The playground keeps its own case store (state.use), so a run never changes the cases the HIMS is working on.
// Expected answers below are what the mock gives; "real" says whether 1518 gave that answer to this request in the
// fixture (meta.json response id), "predicted" means there is no real answer to compare with.
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const state = require('../engine/state');
const rules = require('../engine/rules');
const B = require('../engine/bundle');
const plan = require('../engine/plan.json');

const FIX = path.join(__dirname, '..', '..', 'fixtures');
const DEFAULT_MEMBER = 'SBXSTG269';

const CALL = {
  'coverageeligibility/check': 'Cover check', 'preauth/submit': 'Pre-auth', 'claim/submit': 'Claim',
  'task/submit': 'Task', 'insuranceplan/request': 'Plan request', 'search/submit': 'Search',
};

function load(folder, file) {
  const p = path.join(FIX, folder, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function meta(folder) { return load(folder, 'meta.json'); }
function realAnswer(folder) {
  const m = meta(folder);
  if (!m || !m.response) return null;
  return { id: m.response.id, at: m.response.at, hcxStatus: m.response.hcxStatus,
    code: m.response.errorCode && m.response.errorCode !== '100' ? m.response.errorCode : null, outcome: m.outcome };
}

// step: { fixture, call (label), expect, real (true when 1518's own answer to this request is in the fixture),
//  scenario (engine scenario for this step), link (point the case reference at the case opened earlier), focus }
const s = (fixture, expect, o) => Object.assign({ fixture, expect, real: true }, o || {});

const ENGINE_SCENARIOS = [
  { id: 'auto', label: 'Rules decide', plain: 'The rules check each call; if all pass, it is approved.',
    steps: [s('happy-coverage', 'Covered'), s('happy-preauth', 'Approved'), s('happy-claim', 'Approved', { link: true, focus: true })] },
  { id: 'approve', label: 'Approve', plain: 'Pre-auth and claim are both approved in full.',
    steps: [s('happy-preauth', 'Approved'), s('happy-claim', 'Approved', { link: true, focus: true })] },
  { id: 'partial', label: 'Approve part', plain: 'Half the amount is approved. 1518 never did this for us, so it is a guess.',
    steps: [s('happy-preauth', 'Approved part', { real: false, focus: true }), s('happy-claim', 'Approved part', { link: true, real: false })] },
  { id: 'query', label: 'Ask a question', plain: '1518 asks for a document on the pre-auth; the reply is approved.',
    steps: [s('preauth-queried', 'Queried', { focus: true }), s('preauth-resend-approved', 'Approved', { link: true })] },
  { id: 'reject', label: 'Reject', plain: 'The first pre-auth is rejected; the one sent again on the same stay is approved.',
    steps: [s('preauth-rejected', 'Rejected', { focus: true }), s('preauth-resend-approved', 'Approved')] },
  { id: 'pending', label: 'Wait for the desk', plain: 'Only the queued answer comes back. Someone decides it on the payer desk.',
    steps: [s('happy-preauth', 'Queued', { real: false, focus: true })] },
  { id: 'cancel', label: 'Cancel', plain: 'An approved pre-auth is cancelled and the case closes.',
    steps: [s('room-level-sn063d', 'Approved', { focus: true }), s('preauth-cancel', 'Cancelled', { link: true })] },
  { id: 'enhancement', label: 'Top-up', plain: 'The pre-auth is approved, then a top-up adds a package.',
    steps: [s('error-payr-1238-beneficiary-is-having-an-active-preautho', 'Approved', { real: false }),
      s('enhancement-approved', 'Approved', { link: true, focus: true })] },
  { id: 'implant', label: 'Implant', plain: 'A package that needs an implant, sent with its implant line.',
    steps: [s('implant-preauth', 'Approved', { focus: true }), s('implant-claim', 'Approved', { link: true })] },
  { id: 'newborn', label: 'Newborn', plain: 'The baby is sent as a second patient on the mother\'s card.',
    steps: [s('newborn-preauth', 'Approved', { focus: true }), s('newborn-claim', 'Approved', { link: true })] },
  { id: 'lama', label: 'LAMA discharge', plain: 'Patient left against medical advice. The claim says LAMA.',
    steps: [s('lama-claim', 'Approved', { focus: true })], note: 'The real request says DAMA, so the scenario check adds a note.' },
  { id: 'dama', label: 'DAMA discharge', plain: 'Patient discharged against medical advice. The claim says DAMA.',
    steps: [s('dama-claim', 'Approved', { focus: true })] },
  { id: 'death-before', label: 'Death before surgery', plain: 'Claim for a patient who died before surgery.',
    steps: [s('death-before-surgery-claim', 'Approved', { focus: true })] },
  { id: 'death-after', label: 'Death after surgery', plain: 'Pre-auth, then a claim for a patient who died after surgery.',
    steps: [s('death-after-surgery-preauth', 'Approved'), s('death-after-surgery-claim', 'Approved', { link: true, focus: true })] },
  { id: 'two-packages', label: 'Two packages', plain: 'Two packages on one pre-auth.',
    steps: [s('two-packages-preauth', 'Approved', { real: false, focus: true })], note: '1518 sent only the queued answer; the decision is a guess.' },
  { id: 'erroneous', label: 'Erroneous claim', plain: 'The claim is paid short, two payment notices follow, then a claim for the rest.',
    steps: [s('happy-preauth', 'Approved', { real: false }), s('happy-claim', 'Approved part', { link: true, real: false, focus: true }),
      s('happy-claim', 'Approved', { link: true, real: false })] },
  { id: 'reprocess', label: 'Reprocess', plain: 'The claim is rejected, then sent for reprocessing and approved.',
    steps: [s('claim-rejected', 'Rejected', { focus: true }), s('claim-reprocess', 'Approved', { real: false })],
    note: '1518 queued the real reprocess (fixture claim-reprocess); its final decision was never seen.' },
  { id: 'payment', label: 'Payment notice', plain: 'The claim is approved and two payment notices follow.',
    steps: [s('happy-preauth', 'Approved'), s('happy-claim', 'Approved', { link: true, focus: true })] },
].map(x => Object.assign(x, { kind: 'flow', engineScenario: x.id }));

// One scenario per real refusal. setup puts a case in the store the way 1518 held it when it refused.
const ERROR_SETUP = {
  'PAYR-1238': [{ number: 'PMJAY/HP/S/2024/R2/2026111890000009', member: DEFAULT_MEMBER, admission: 'A/9016/26', status: 'approved' }],
  'PAYR-1245/enh': [{ number: 'PMJAY/HP/S/2024/R2/2026110990000001', member: DEFAULT_MEMBER, admission: 'A/9007/26', packages: [{ code: 'SB017A', eligible: 17000 }, { code: 'IMP0129', eligible: 3000 }] }],
  'PAYR-1372': [{ number: 'PMJAY/HP/S/2024/R2/2026111390000002', member: DEFAULT_MEMBER, admission: 'A/9008/26', packages: [{ code: 'SG059A', eligible: 12000 }],
    pendingEvent: { action: 'preauth/submit', correlationId: 'c19370c6-1127-4bab-90e6-3a087c0c4722', kind: 'enhancement' } }],
};
// Refusals the mock answers differently, from test/engine.fixtures.test.js KNOWN_GAPS.
const MOCK_ANSWERS = { 'HBP016': 'HBP0006', 'HBP039': 'HBP0006', 'PAYR-1123': 'Covered', 'ERR-PYR-SR-002': 'Answered' };
const PLAIN_ERROR = {
  'ERR-PYR-SR-002': 'A claim search that found nothing.',
  'HBP0006': 'Cover check with a private policy, not the PMJAY one.',
  'HBP016': 'Cover check with a private policy 1518 has no plan for.',
  'HBP039': 'Cover check with a policy code 1518 does not know.',
  'PAYR-1008': 'Claim with an attachment that is not valid base64.',
  'PAYR-1045': 'Cover check where a line has quantity 0.',
  'PAYR-1111/implant': 'Cover check for a package that needs an implant, without the implant.',
  'PAYR-1111/strat': 'Cover check without the room level the package needs.',
  'PAYR-1114': 'Cover check with a line that has no speciality.',
  'PAYR-1123': 'Cover check refused during an NHA outage; the request itself was fine.',
  'PAYR-1238': 'New pre-auth while the patient still has another open one.',
  'PAYR-1245/enh': 'Top-up on a package that does not allow top-ups.',
  'PAYR-1245/cons': 'Two medical packages on one pre-auth.',
  'PAYR-1250': 'Pre-auth with policy 100217 instead of PMJAY/HP/S/G.',
  'PAYR-1263': 'Newborn pre-auth where the package line lists documents.',
  'PAYR-1323': 'Claim larger than what is left in the family wallet.',
  'PAYR-1357': 'Claim where admission is after discharge.',
  'PAYR-1372': 'Claim while a top-up is still waiting.',
  'PAYR-1402': 'Plan request with policy 100217.',
};

function errorScenarios() {
  if (!fs.existsSync(FIX)) return [];
  return fs.readdirSync(FIX).filter(d => d.startsWith('error-')).sort().map(d => {
    const m = meta(d);
    const code = m.response.errorCode;
    const key = code === 'PAYR-1111' ? code + (/implant/.test(d) ? '/implant' : '/strat')
      : code === 'PAYR-1245' ? code + (/enhancement/.test(d) ? '/enh' : '/cons') : code;
    const mockAnswer = MOCK_ANSWERS[code] || code;
    let fixture = d; let preset = null;
    if (!load(d, 'request.json')) { fixture = 'implant-preauth'; preset = { id: 'quantity-0' }; }
    const step = s(fixture, mockAnswer, { focus: true, real: mockAnswer === code && !preset, realFolder: d, preset });
    if (code === 'PAYR-1238') step.engineState = 'new';
    return { id: 'err:' + d, kind: 'error', label: code + ' ' + (m.response.errorMessage || '').slice(0, 48),
      plain: PLAIN_ERROR[key] || m.response.errorMessage, code, engineScenario: 'auto', steps: [step], setup: ERROR_SETUP[key] || null,
      note: mockAnswer !== code ? `1518 answered ${code}; the mock answers ${mockAnswer}.`
        : preset ? 'No real request was kept for this refusal. The request is the real SB017A pre-auth with quantity 0, so the answer is predicted.' : null };
  });
}

let CATALOGUE = null;
function catalogue() {
  if (!CATALOGUE) CATALOGUE = ENGINE_SCENARIOS.concat(errorScenarios());
  return CATALOGUE;
}
function scenarioById(id) { return catalogue().find(x => x.id === id) || null; }

// ---------------------------------------------------------------- patients and packages
function patients() {
  const seen = {};
  if (fs.existsSync(FIX)) for (const d of fs.readdirSync(FIX)) {
    const b = load(d, 'request.json');
    const m = b && B.member(b);
    if (!m) continue;
    const pols = B.policies(b);
    seen[m] = seen[m] || { id: m, policies: new Set(), fixtures: 0 };
    pols.forEach(p => seen[m].policies.add(p));
    seen[m].fixtures++;
  }
  return Object.values(seen).map(p => ({ id: p.id, policies: [...p.policies], fixtures: p.fixtures,
    known: p.id === DEFAULT_MEMBER, wallet: p.id === DEFAULT_MEMBER ? state.walletStart() : null,
    label: p.id === DEFAULT_MEMBER ? 'Sandbox PMJAY member, family wallet' : 'Private policy holder, not a PMJAY member on 1518' }))
    .sort((a, b) => (b.known - a.known));
}
function packageInfo(code) {
  const p = plan.packages[code];
  if (!p) return { code, name: 'Not in the 1518 plan', amount: null };
  const r = p.rules || {};
  return { code, name: p.name, speciality: p.speciality, amount: p.amount, rates: p.rates || [],
    implantNeeded: rules.yes(p, 'ImplantApplicable'), roomLevelNeeded: rules.yes(p, 'StratificationAllowed'),
    topUpAllowed: rules.yes(p, 'EnhancementAllowed'), noReview: rules.yes(p, 'ApprovalNotRequired'), type: r.ProcedureType || null };
}
function packagesFor(sc) {
  const codes = new Set();
  for (const st of sc.steps) { const b = load(st.fixture, 'request.json'); if (b) B.items(b).forEach(i => i.code && codes.add(i.code)); }
  return [...codes].map(packageInfo);
}
function allFixturePackages() {
  const codes = new Set();
  if (fs.existsSync(FIX)) for (const d of fs.readdirSync(FIX)) { const b = load(d, 'request.json'); if (b) B.items(b).forEach(i => i.code && !i.isImplant && codes.add(i.code)); }
  return [...codes].sort().map(packageInfo);
}

// ---------------------------------------------------------------- edits a user can make before sending
const EDITS = [
  { id: 'remove-implant', label: 'Remove the implant line', watch: 'PAYR-1111' },
  { id: 'policy-100217', label: 'Change the policy to 100217', watch: 'PAYR-1250 / HBP0006' },
  { id: 'speciality-null', label: 'Empty the speciality of line 1', watch: 'PAYR-1114' },
  { id: 'quantity-0', label: 'Set quantity of line 1 to 0', watch: 'PAYR-1045' },
  { id: 'remove-room-level', label: 'Remove the room level', watch: 'PAYR-1111' },
  { id: 'discharge-before-admission', label: 'Put discharge before admission', watch: 'PAYR-1357' },
  { id: 'bad-attachment', label: 'Break the first attachment', watch: 'PAYR-1008' },
  { id: 'total-600000', label: 'Ask for 6,00,000 in total', watch: 'PAYR-1323' },
  { id: 'field', label: 'Set any field', watch: null },
];

function claimOf(b) { return B.first(b, 'Claim') || B.first(b, 'CoverageEligibilityRequest'); }
function setPath(obj, p, value) {
  const parts = String(p).split('.').filter(Boolean);
  if (!parts.length) throw new Error('Field path is empty.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[k];
  }
  const last = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
  if (value === undefined) { if (Array.isArray(o)) o.splice(last, 1); else delete o[last]; } else o[last] = value;
}
function parseValue(v) {
  if (v === '' || v == null) return undefined;
  try { return JSON.parse(v); } catch (_) { return String(v); }
}

// Returns a note saying what changed, or throws when the edit does not apply to this request.
function applyEdit(b, edit) {
  if (!edit || !edit.id) return null;
  const c = claimOf(b);
  const lines = c ? (c.item || []) : [];
  const need = (ok, why) => { if (!ok) throw new Error(why); };
  switch (edit.id) {
    case 'remove-implant': {
      const n = lines.length;
      c.item = lines.filter(i => !/^IMP/i.test(B.code(i.productOrService) || ''));
      need(c.item.length < n, 'This request has no implant line.');
      return 'Removed the implant line.';
    }
    case 'policy-100217': {
      const covs = B.resources(b, 'Coverage');
      need(covs.length, 'This request has no Coverage.');
      for (const cov of covs) for (const id of cov.identifier || []) id.value = '100217';
      const t = B.first(b, 'Task');
      if (t) for (const i of t.input || []) if (B.code(i.type) === 'policyNumber') i.valueString = '100217';
      return 'Policy set to 100217.';
    }
    case 'speciality-null': need(lines[0], 'This request has no lines.'); delete lines[0].category; return 'Line 1 has no speciality.';
    case 'quantity-0': need(lines[0], 'This request has no lines.'); lines[0].quantity = { value: 0 }; return 'Line 1 quantity is 0.';
    case 'remove-room-level': {
      let n = 0;
      for (const i of lines) { const before = (i.modifier || []).length; i.modifier = (i.modifier || []).filter(m => !(m.coding || []).some(x => /^STRAT/i.test(x.code || ''))); n += before - i.modifier.length; if (!i.modifier.length) delete i.modifier; }
      need(n, 'This request has no room level.');
      return 'Removed the room level.';
    }
    case 'discharge-before-admission': {
      need(c && c.resourceType === 'Claim', 'Only a pre-auth or claim has dates.');
      const d = B.dates(b);
      need(d.admissionMs, 'This request has no admission date.');
      const earlier = new Date(d.admissionMs - 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
      for (const si of c.supportingInfo || []) if (B.code(si.code) === 'DSDE') { if ('valueString' in si) si.valueString = earlier; else si.timingDate = earlier; }
      if (c.billablePeriod) c.billablePeriod.end = earlier;
      return 'Discharge set to ' + earlier + ', a day before admission.';
    }
    case 'bad-attachment': {
      const si = c && (c.supportingInfo || []).find(x => x.valueAttachment && x.valueAttachment.data);
      need(si, 'This request has no attachment.');
      si.valueAttachment.data = 'not base64 !!';
      return 'First attachment is no longer valid base64.';
    }
    case 'total-600000':
      need(c && c.resourceType === 'Claim', 'Only a pre-auth or claim has a total.');
      c.total = { value: 600000, currency: 'INR' };
      return 'Total set to 6,00,000.';
    case 'field': {
      need(c, 'This request has no Claim to edit.');
      need(edit.path, 'Give a field path, for example item.0.quantity.value');
      setPath(c, edit.path, parseValue(edit.value));
      return `Set ${c.resourceType}.${edit.path} to ${edit.value === '' || edit.value == null ? '(removed)' : edit.value}.`;
    }
    default: throw new Error('Unknown change ' + edit.id + '.');
  }
}

function swapPackage(b, code) {
  const c = claimOf(b);
  const line = c && (c.item || []).find(i => !/^IMP/i.test(B.code(i.productOrService) || ''));
  if (!line) throw new Error('This request has no package line.');
  const p = plan.packages[code];
  line.productOrService = line.productOrService || { coding: [{}] };
  line.productOrService.coding[0].code = code;
  if (p) {
    line.productOrService.coding[0].display = p.name;
    if (line.category && line.category.coding && line.category.coding[0]) line.category.coding[0].code = p.speciality;
  }
  return 'Package line 1 set to ' + code + '.';
}

function swapMember(b, from, to) {
  if (!to || !from || from === to) return b;
  return JSON.parse(JSON.stringify(b).split(from).join(to));
}

function link(b, caseNumber) {
  if (!caseNumber) return false;
  let done = false;
  const c = B.first(b, 'Claim');
  if (c) for (const ins of c.insurance || []) if (Array.isArray(ins.preAuthRef) && ins.preAuthRef.length) { ins.preAuthRef = [caseNumber]; done = true; }
  const t = B.first(b, 'Task');
  if (t && B.code(t.code) === 'cancel') for (const i of t.input || []) if (/claimNumber|initimationNumber/.test(B.code(i.type) || '')) { i.valueString = caseNumber; done = true; }
  return done;
}

// ---------------------------------------------------------------- reading the answers
function outcomeOf(cb) {
  if (cb.error) return cb.error.code;
  if (cb.action === 'paymentnotice/request') return 'Payment notice';
  if (cb.action === 'search/on_submit') return 'Answered';
  const res = B.resources(cb.bundle || {});
  const cr = res.find(r => r.resourceType === 'ClaimResponse');
  const ce = res.find(r => r.resourceType === 'CoverageEligibilityResponse');
  const t = res.find(r => r.resourceType === 'Task');
  if (cb.action === 'task/on_submit') {
    if (cb.hcxStatus === 'response.partial') return 'Queued';
    return t && /cancel/i.test(JSON.stringify(t.businessStatus || t.output || t.status)) || /cancel/i.test(JSON.stringify(cr || {})) ? 'Cancelled' : 'Done';
  }
  if (ce) return 'Covered';
  if (cr) {
    if (cr.outcome === 'queued') return 'Queued';
    if (cr.outcome === 'partial') return 'Queried';
    if (cr.outcome === 'error') return 'Rejected';
    return 'Approved';
  }
  return cb.hcxStatus === 'response.complete' ? 'Done' : cb.hcxStatus;
}
// The final word on one request: the last answer that is not a payment notice, with a few refinements.
function finalOutcome(callbacks, partialScenario) {
  const main = callbacks.filter(c => c.action !== 'paymentnotice/request');
  if (!main.length) return 'No answer';
  // a reprocess task is queued, then the claim decision follows
  let o = outcomeOf(main[main.length - 1]);
  if (o === 'Approved' && partialScenario) o = 'Approved part';
  return o;
}

function caseView(c) {
  return { number: c.number, member: c.member, admission: c.admission, status: c.status, approved: c.approved,
    packages: (c.packages || []).map(p => p.code), waiting: c.pendingEvent ? (CALL[c.pendingEvent.action] || c.pendingEvent.action) : null,
    claim: c.claim ? { status: c.claim.status, approved: c.claim.approved, count: c.claim.count } : null, paymentNotices: c.paymentNotices };
}
function stateView(st) {
  return { cases: Object.values(st.cases).map(caseView),
    wallets: Object.values(st.members).map(m => ({ member: m.id, left: m.wallet, start: state.walletStart() })) };
}

// ---------------------------------------------------------------- running
let store = state.fresh();
function reset() { store = state.fresh(); return stateView(store); }
function current() { return stateView(store); }

function rulesFor(action) {
  return rules.list().filter(r => r.actions.includes(action)).map(r => ({ id: r.id, code: r.code,
    seen: r.observed.includes(action), source: r.source, note: !rules.RULES.some(x => x.id === r.id) }));
}

// Builds the request for every step, runs each through engine.handle() on the given store, and reports.
function runOn(st, input) {
  const sc = scenarioById(input && input.scenario);
  if (!sc) throw new Error('Pick a scenario first.');
  const patient = (input && input.patient) || DEFAULT_MEMBER;
  const prev = state.use(st);
  const out = [];
  try {
    if (sc.setup) for (const c of sc.setup) if (!state.findCase(c.number)) state.seedCase(JSON.parse(JSON.stringify(Object.assign({}, c, { member: c.member === DEFAULT_MEMBER ? patient : c.member }))));
    let caseNumber = null;
    sc.steps.forEach((step, n) => {
      const raw = load(step.fixture, 'request.json');
      const m = meta(step.fixture);
      const action = m.request.endpoint.replace(/^\/?v1\//, '');
      const from = B.member(raw) || DEFAULT_MEMBER;
      let bundle = swapMember(raw, from, patient);
      const changes = [];
      if (patient !== from) changes.push(`Member ${from} swapped for ${patient}.`);
      if (step.link && link(bundle, caseNumber)) changes.push('Case number set to ' + caseNumber + ', the case opened earlier in this run.');
      if (step.preset) changes.push(applyEdit(bundle, step.preset));
      if (step.focus && input.package) changes.push(swapPackage(bundle, input.package));
      if (step.focus && input.edit && input.edit.id) changes.push(applyEdit(bundle, input.edit));
      const headers = { 'x-mock-scenario': sc.engineScenario };
      const r = engine.handle({ action, apiCallId: 'pg-' + Date.now() + '-' + n, correlationId: 'playground-' + Date.now() + '-' + n,
        sender: '1000000001@hcx', recipient: '1518@hcx', headers, bundle });
      if (r.caseNumber) caseNumber = r.caseNumber;
      const failed = new Map();
      for (const f of r.findings || []) if (!failed.has(f.rule)) failed.set(f.rule, f);
      const checks = rulesFor(action).map(x => {
        const f = failed.get(x.id);
        return Object.assign(x, { result: f ? (f.refuse ? 'fail' : 'note') : 'pass', message: f ? f.message : null, path: f ? f.path : null });
      });
      for (const f of r.findings || []) if (f.code === 'SCENARIO') checks.push({ id: f.rule, code: 'NOTE', seen: false, source: f.source, result: 'note', message: f.message });
      const outcome = finalOutcome(r.callbacks || [], sc.engineScenario === 'partial' || (sc.engineScenario === 'erroneous' && step.expect === 'Approved part'));
      out.push({ n: n + 1, call: CALL[action] || action, action, fixture: step.fixture, requestId: m.request.id,
        // a changed request is no longer the one 1518 answered, so its answer is a prediction
        expect: step.expect, real: !!step.real && patient === from && !(step.focus && (input.package || (input.edit && input.edit.id))), realAnswer: realAnswer(step.realFolder || step.fixture),
        outcome, matches: outcome === step.expect, changes: changes.filter(Boolean), request: bundle, checks,
        answers: (r.callbacks || []).map(cb => ({ action: cb.action, hcxStatus: cb.hcxStatus, outcome: outcomeOf(cb), error: cb.error || null, bundle: cb.bundle })),
        caseNumber: r.caseNumber || null });
    });
  } finally {
    state.use(prev);
  }
  return { scenario: { id: sc.id, label: sc.label }, patient, steps: out, state: stateView(st) };
}

function run(input) { return runOn(store, input); }
// Same run on a copy of the playground's cases: shows what will happen without changing anything.
function preview(input) { return runOn(structuredClone(store), input); }

function summary(sc) {
  return { id: sc.id, kind: sc.kind, label: sc.label, plain: sc.plain, note: sc.note || null, code: sc.code || null,
    calls: [...new Set(sc.steps.map(st => CALL[meta(st.fixture).request.endpoint.replace(/^\/?v1\//, '')]).concat(
      sc.engineScenario === 'payment' || sc.engineScenario === 'erroneous' ? ['Payment'] : [],
      sc.engineScenario === 'cancel' ? ['Cancel'] : [], sc.engineScenario === 'enhancement' ? ['Top-up'] : []))].map(x => x === 'Task' ? (sc.engineScenario === 'cancel' ? 'Cancel' : 'Reprocess') : x).filter((v, i, a) => a.indexOf(v) === i),
    steps: sc.steps.map(st => ({ fixture: st.fixture, expect: st.expect, real: !!st.real })), packages: packagesFor(sc) };
}
function catalogueView() {
  return { scenarios: catalogue().map(summary), patients: patients(), packages: allFixturePackages(), edits: EDITS };
}

// ---------------------------------------------------------------- HTTP (hooked from app.js)
function json(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); try { resolve(t ? JSON.parse(t) : {}); } catch (_) { resolve(null); } });
    req.on('error', reject);
  });
}
async function route(req, res, p) {
  const m = req.method;
  try {
    if (m === 'GET' && p === '/playground/catalogue') return json(res, 200, catalogueView());
    if (m === 'GET' && p === '/playground/state') return json(res, 200, current());
    if (m === 'POST' && p === '/playground/reset') return json(res, 200, reset());
    if (m === 'POST' && (p === '/playground/preview' || p === '/playground/run')) {
      const b = await body(req);
      if (!b) return json(res, 400, { error: { message: 'The request is not valid JSON.' } });
      return json(res, 200, p.endsWith('run') ? run(b) : preview(b));
    }
    return json(res, 404, { error: { message: 'Not found: ' + m + ' ' + p } });
  } catch (e) {
    return json(res, 400, { error: { message: e.message } });
  }
}

module.exports = { route, run, preview, reset, current, catalogue: catalogueView, scenarioById, applyEdit, swapMember, link, outcomeOf, _store: () => store };
