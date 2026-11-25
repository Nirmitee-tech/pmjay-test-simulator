'use strict';
// The mock 1518@hcx: handle() takes one request and returns the callbacks 1518 would send (docs/ARCHITECTURE.md).
// How 1518 answers, from real sandbox traffic (sender 1518@hcx, read 24 Nov 2026):
// - a refusal is one response.error callback with ErrorCode and ErrorMessage (e.g. PAYR-1238, real sandbox traffic)
// - pre-auth and claim: first response.partial "queued", later response.complete with the decision (fixture room-level-sn063d then fixture room-level-sn063d)
// - a package the plan approves without review (ApprovalNotRequired Y) comes back complete at once (SB017A, fixture implant-preauth)
// - cover checks and plan requests come back complete, no queued step
// - a pre-auth query comes as preauth/on_submit with outcome queried (fixture preauth-queried,)
// - a claim query comes as claim/on_submit, response.complete with ClaimResponse outcome partial (fixture claim-queried)
// - a claim reprocess is a Task (code reprocess, basedOn the claim number) answered task/on_submit response.partial (fixture claim-reprocess)
// - cancel (Task cancel) comes back task/on_submit complete, PC02 (fixture preauth-cancel)
// - payment notices come from 1518 as paymentnotice/request, status request.initiated (13 rows)
const B = require('./bundle');
const state = require('./state');
const rules = require('./rules');
const scenarios = require('./scenarios');
const plan = require('./plan.json');
const path = require('path');
const crypto = require('crypto');

const ON = {
  'coverageeligibility/check': 'coverageeligibility/on_check',
  'preauth/submit': 'preauth/on_submit',
  'claim/submit': 'claim/on_submit',
  'insuranceplan/request': 'insuranceplan/on_request',
  'task/submit': 'task/on_submit',
  'search/submit': 'search/on_submit',
  'predetermination/submit': 'predetermination/on_submit',
};
const REJECT_REASON = 'Medical necessity of ICU bed category not met';   // 1518's words, fixture preauth-rejected (16 Nov)
const QUERY_TEXT = 'Please share the treating doctor prescription and clinical notes.';   // mock text; 1518's own query text is the desk's
const PARTIAL_SHARE = 0.5;   // mock choice for the partial scenario, not a 1518 rule

let options = { queuedMs: 300, decisionMs: 1500, paymentMs: 3000 };
function setOptions(o) { options = Object.assign({}, options, o || {}); return options; }

function normalise(action) { return String(action || '').replace(/^\/?(v\d+\/)?/, '').replace(/^\//, ''); }
function workflow(headers) {
  const h = headers || {};
  return String(h['x-hcx-workflow_id'] || h['x-hcx-workflow-id'] || h.workflow_id || h.workflowId || '').trim();
}

// Agent C's builders (src/responses, kinds like 'preauth.approved'), loaded on every call so they can land while the
// server runs; a minimal bundle until then, and for the plan answer, which has no builder.
const DECISION_STATUS = { queued: 'queued', approve: 'approved', partial: 'partial', query: 'queried', reject: 'rejected' };
function kindFor(on, ctx) {
  if (ctx.decision === 'error') return 'error';
  if (on === 'coverageeligibility/on_check') return 'coverage';
  if (on === 'preauth/on_submit' || on === 'claim/on_submit') return on.split('/')[0] + '.' + (DECISION_STATUS[ctx.decision] || 'approved');
  if (on === 'task/on_submit') return ctx.decision === 'reprocess' ? 'task.reprocess' : ctx.decision === 'cancel' ? 'task.cancel' : null;
  if (on === 'paymentnotice/request') return 'paymentnotice.request';
  return null;
}
function forBuilder(on, ctx) {
  // the builders name the admission caseNumber and 1518's case number preAuthRef (src/responses/index.js header)
  const items = (ctx.items || []).map(i => ({ sequence: i.sequence, submitted: i.submitted, quantity: 1,
    approved: ctx.decision === 'approve' || ctx.decision === 'partial' ? (i.approved != null ? i.approved : i.eligible) : undefined }));
  return Object.assign({}, ctx, { caseNumber: ctx.admission || undefined, preAuthRef: ctx.caseNumber || undefined,
    items: items.length ? items : undefined, disposition: ctx.note, endpoint: on, action: on,
    code: ctx.error && ctx.error.code, message: ctx.error && ctx.error.message },
    // A refusal names 1518 as sender (the builder picks 1518 or 1518@hcx), the HIMS's bare code as recipient, and no
    // workflow id, except the plan refusal, which carried 4 (real sandbox traffic; fixture error-payr-1402-requested-policy-100217-found-not-be-ass).
    ctx.decision === 'error' ? { sender: undefined, recipient: String(ctx.sender || '1000000001').replace(/@hcx$/i, ''),
      workflowId: on === 'insuranceplan/on_request' ? '4' : null } : {});
}
function build(on, ctx) {
  const kind = kindFor(on, ctx);
  const p = path.resolve(__dirname, '../responses');
  let mod = null;
  try { mod = require(p); } catch (e) { if (!(e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(p))) throw e; }
  if (kind && mod && typeof mod.build === 'function') { const b = mod.build(kind, forBuilder(on, ctx)); if (b) return b; }
  return stub(on, ctx);
}
function stub(kind, ctx) {
  return { resourceType: 'Bundle', type: 'collection', meta: { tag: [{ code: 'pmjaymock-stub' }] },
    entry: [{ resource: { resourceType: kind.startsWith('task') ? 'Task' : kind.startsWith('paymentnotice') ? 'PaymentNotice' : 'ClaimResponse',
      status: 'active', outcome: ctx.outcome, disposition: ctx.note || ctx.decision, preAuthRef: ctx.caseNumber || undefined,
      total: ctx.amount != null ? [{ category: { coding: [{ code: 'eligible' }] }, amount: { value: ctx.amount, currency: 'INR' } }] : undefined } }] };
}

// Eligible amount per line: the plan's price where the plan prices it, else what was asked. 1518 paid SB017A +
// IMP0129 in full (fixture implant-claim).
function priceLines(items) {
  return items.filter(i => i.code).map(i => {
    const p = rules.pkg(i.code);
    let eligible = i.amount || 0;
    if (p) {
      // package amount plus the room level's rate: MN001A 1,000 + STRAT017a 500 = the 1,500 1518 made eligible on
      // a line asked at 500 (20 Nov, case 2026112090000014); SN063D 0 + STRAT006a 1,800 = 1,800 (fixture room-level-sn063d)
      const r = i.strat.length ? p.rates.find(x => x.code === i.strat[0]) : null;
      if (r) eligible = (p.amount || 0) + r.amount;
      else if (typeof p.amount === 'number' && p.amount > 0) eligible = p.amount;
    }
    return { sequence: i.sequence, code: i.code, speciality: i.speciality, strat: i.strat[0] || null, submitted: i.amount || 0, eligible };
  });
}

function classifyPreauth(bundle, headers) {
  const wf = workflow(headers);
  const member = B.member(bundle);
  const admission = B.admissionId(bundle);
  const ref = B.caseRef(bundle);
  let c = ref ? state.findCase(ref) : null;
  if (!c && admission) c = state.caseFor(member, admission);
  if (c && (wf === '19' || wf === '131' || c.status === 'queried')) return { kind: 'query-reply', c };
  if (c && (wf === '16' || wf === '121' || c.status === 'rejected')) return { kind: 'resubmit', c };
  if (c && ref && c.status === 'approved') return { kind: 'enhancement', c };
  if (c && ['cancelled', 'closed'].includes(c.status)) return { kind: 'new', c: null };
  return { kind: 'new', c: c && c.status === 'pending' ? c : null };
}

function classifyClaim(bundle, headers) {
  const wf = workflow(headers);
  const ref = B.caseRef(bundle);
  const c = ref ? state.findCase(ref) : state.caseFor(B.member(bundle), B.admissionId(bundle));
  if (!c) return { kind: 'claim', c: null };
  if (c.claim.status === 'queried' || wf === '151' || wf === '161') return { kind: 'claim-query-reply', c };
  if (c.claim.status === 'rejected' || wf === '122' || wf === '36') return { kind: 'reprocess', c };
  if (c.claim.status === 'approved') return { kind: 'erroneous', c };
  return { kind: 'claim', c };
}

function scenarioOf(headers) {
  const h = headers || {};
  const s = h['x-mock-scenario'] || h['X-Mock-Scenario'] || state.get().scenario || 'auto';
  return scenarios.get(s) ? s : 'auto';
}
function setScenario(name) { state.get().scenario = scenarios.get(name) ? name : null; return state.get().scenario; }

function cb(input, on, delayMs, hcxStatus, kindCtx) {
  const ctx = Object.assign({ bundle: input.bundle, correlationId: input.correlationId, apiCallId: input.apiCallId,
    sender: input.sender, recipient: input.recipient, scenario: input.scenario, admission: B.admissionId(input.bundle) }, kindCtx);
  const out = { action: on, delayMs, bundle: build(on, ctx), hcxStatus };
  if (kindCtx.error) out.error = kindCtx.error;
  return out;
}

function refuse(input, on, f, caseNumber) {
  const error = { code: f.code, message: f.message };
  return [cb(input, on, options.queuedMs, 'response.error', { decision: 'error', outcome: 'error', error, caseNumber, note: f.message })];
}

function handle(input) {
  const action = normalise(input && input.action);
  const bundle = (input && input.bundle) || {};
  const headers = (input && input.headers) || {};
  const scenario = scenarioOf(headers);
  const on = ON[action] || null;
  const base = Object.assign({}, input, { action, scenario });
  const result = (callbacks, findings, extra) => Object.assign({ sync: null, callbacks, findings: findings || [], scenario }, extra || {});
  state.record({ action, correlationId: input && input.correlationId, scenario });

  if (!on) return result([], [], { note: 'No callback for ' + action + ' (a reply the HIMS sends, or not modelled).' });

  // scenario expectations: notes only
  const sc = scenarios.get(scenario);
  const notes = [];
  const exp = sc && sc.expect ? sc.expect(bundle) : null;
  if (exp && (action === 'preauth/submit' || action === 'claim/submit')) notes.push({ code: 'SCENARIO', rule: 'scenario-' + scenario, message: exp, path: '', source: 'scenario ' + scenario, refuse: false });

  if (action === 'insuranceplan/request') {
    const f = rules.validate(action, bundle, { raw: input.raw });
    const r = f.find(x => x.refuse);
    if (r) return result(refuse(base, on, r), f);
    return result([cb(base, on, options.queuedMs, 'response.complete', { decision: 'plan', outcome: 'complete', plan })], f);
  }

  if (action === 'coverageeligibility/check') {
    const f = rules.validate(action, bundle, { raw: input.raw });
    const r = f.find(x => x.refuse);
    if (r) return result(refuse(base, on, r), f);
    // 1518's cover answers carry the package's allowed money and no wallet
    const items = priceLines(B.items(bundle));
    const m = B.member(bundle);
    const left = state.walletLeft(m);
    return result([cb(base, on, options.queuedMs, 'response.complete', { decision: 'coverage', outcome: 'complete', items, member: m,
      allowed: left, used: left == null ? undefined : state.walletStart() - left })], f);
  }

  if (action === 'task/submit') return handleTask(base, on, bundle);
  if (action === 'preauth/submit') return handlePreauth(base, on, bundle, headers, notes, result);
  if (action === 'claim/submit') return handleClaim(base, on, bundle, headers, notes, result);

  // search, predetermination: not seen from 1518 beyond ERR-PYR-SR-002 on search (real sandbox traffic); answered complete
  return result([cb(base, on, options.queuedMs, 'response.complete', { decision: 'approve', outcome: 'complete' })], [], { note: action + ' is not modelled on 1518 rules.' });
}

function handleTask(input, on, bundle) {
  const t = B.task(bundle);
  const scenario = input.scenario;
  const res = (cbs, findings) => ({ sync: null, callbacks: cbs, findings: findings || [], scenario });
  if (t && t.code === 'reprocess') return handleReprocessTask(input, on, bundle, t, res);
  if (!t || t.code !== 'cancel') return res([cb(input, on, options.queuedMs, 'response.complete', { decision: 'approve', outcome: 'complete' })]);
  const c = state.findCase(B.caseRef(bundle));
  if (!c || !state.OPEN.includes(c.status)) {
    // Not seen from 1518: what it answers to a cancel on an unknown or closed case. Mock-only code.
    const f = { code: 'MOCK-NO-OPEN-CASE', rule: 'cancel-unknown-case', message: 'No open pre-auth with this number on the mock payer.', path: 'Task.input', source: 'mock only, not a 1518 answer', refuse: true };
    return res(refuse(input, on, f), [f]);
  }
  c.status = 'cancelled';
  c.pendingEvent = null;
  c.history.push({ event: 'cancelled', at: Date.now() });
  // PC01 in, PC02 out, complete (fixture preauth-cancel)
  return res([cb(input, on, options.queuedMs, 'response.complete', { decision: 'cancel', outcome: 'complete', status: 'PC02', caseNumber: c.number })]);
}

// Claim reprocess: a Task code reprocess, basedOn the claim number (the admission), for a rejected claim. 1518 answered
// task/on_submit response.partial, queued (fixture claim-reprocess -> fixture claim-reprocess, 19 Nov). What 1518 decides after that was not seen; the
// mock approves the claim when the scenario is reprocess, else leaves it for the desk.
function handleReprocessTask(input, on, bundle, t, res) {
  const based = ((t.resource.basedOn || [])[0] || {}).identifier;
  const member = ((t.resource.for || {}).identifier || {}).value || null;
  const admission = based && based.value;
  const c = state.findCase(admission) || state.caseFor(member, admission) || Object.values(state.get().cases).find(x => x.admission === admission);
  const out = [cb(input, on, options.queuedMs, 'response.partial', { decision: 'reprocess', outcome: 'queued', caseNumber: c && c.number, admission })];
  if (c && c.claim.status === 'rejected') {
    if (input.scenario === 'reprocess') {
      const amount = c.claim.lastEligible || c.approved || 0;
      const ctx = settleClaim(c, 'approve', amount, { caseNumber: c.number, admission, kind: 'reprocess', items: c.claim.lastItems || [] }, c.member);
      out.push(cb(Object.assign({}, input, { bundle: c.claim.lastBundle || input.bundle }), 'claim/on_submit', options.decisionMs, 'response.complete', ctx));
    } else {
      c.pendingEvent = { action: 'claim/submit', correlationId: input.correlationId, kind: 'reprocess', input: Object.assign({}, input, { bundle: c.claim.lastBundle || input.bundle }), items: c.claim.lastItems || [], eligible: c.claim.lastEligible || 0 };
    }
  }
  return res(out);
}

// Every package line is one the plan approves without review (plan.json ApprovalNotRequired Y, e.g. SB017A).
function autoApprovedFor(kind, bundle) {
  const pkgLines = B.items(bundle).filter(i => i.code && !i.isImplant);
  return kind === 'new' && pkgLines.length > 0 && pkgLines.every(i => rules.yes(rules.pkg(i.code), 'ApprovalNotRequired'));
}

function handlePreauth(input, on, bundle, headers, notes, result) {
  const scenario = input.scenario;
  const { kind, c: found } = classifyPreauth(bundle, headers);
  const findings = rules.validate('preauth/submit', bundle, { kind, caseRec: found, raw: input.raw }).concat(notes);
  const bad = findings.find(f => f.refuse);
  if (bad) return result(refuse(input, on, bad, found && found.number), findings);

  const member = B.member(bundle);
  let c = found;
  if (!c) {
    // a new pre-auth on an admission whose last pre-auth was rejected keeps that case number (fixture preauth-queried)
    const prior = state.caseFor(member, B.admissionId(bundle));
    c = prior && prior.status === 'rejected' ? prior : state.openCase({ member, admission: B.admissionId(bundle) });
  }
  c.lastCorrelationId = input.correlationId;
  const items = priceLines(B.items(bundle));
  let eligible = items.reduce((s, i) => s + i.eligible, 0);
  const ctxBase = { caseNumber: c.number, items, kind };

  const autoApproved = autoApprovedFor(kind, bundle);
  const queued = cb(input, on, options.queuedMs, 'response.partial', Object.assign({ decision: 'queued', outcome: 'queued', amount: 0 }, ctxBase));
  const settle = (decision) => {
    c.pendingEvent = null;
    if (decision === 'approve' || decision === 'partial') {
      const amt = decision === 'partial' ? Math.round(eligible * PARTIAL_SHARE) : eligible;
      c.status = 'approved';
      c.approved = amt;
      c.packages = items.map(i => ({ code: i.code, eligible: decision === 'partial' ? Math.round(i.eligible * PARTIAL_SHARE) : i.eligible, speciality: i.speciality, strat: i.strat }));
      c.history.push({ event: kind === 'enhancement' ? 'enhancement-approved' : 'preauth-approved', amount: amt, at: Date.now() });
      return Object.assign({ decision, outcome: 'complete', amount: amt, note: decision === 'partial' ? 'Partially approved' : 'Approved' }, ctxBase);
    }
    if (decision === 'reject') {
      c.status = 'rejected';
      c.rejections = (c.rejections || 0) + 1;
      c.history.push({ event: 'preauth-rejected', at: Date.now() });
      return Object.assign({ decision, outcome: 'complete', amount: 0, note: REJECT_REASON }, ctxBase);
    }
    // query
    c.status = 'queried';
    c.history.push({ event: 'preauth-queried', at: Date.now() });
    return Object.assign({ decision: 'query', outcome: 'queried', amount: 0, note: QUERY_TEXT }, ctxBase);
  };

  // In auto, a pre-auth the plan does not approve without review waits for 1518's desk when the server asks for
  // it (input.reviewHold): 1518 sent the queued answer in about 6 s and decided by hand minutes to days later
  // (real sandbox traffic at on 20 Nov, approved real sandbox traffic on 23 Nov), while SB017A (ApprovalNotRequired) came back
  // approved in 8 s with no queued step (fixture implant-preauth -> fixture implant-preauth, 17 Nov).
  const review = scenario === 'auto' && input.reviewHold === true && !autoApprovedFor(kind, bundle);
  if (scenario === 'pending' || review) {
    c.status = c.status === 'approved' && kind === 'enhancement' ? 'approved' : 'pending';
    c.pendingEvent = { action: 'preauth/submit', on, correlationId: input.correlationId, kind, input, items, eligible };
    return result([queued], findings, { caseNumber: c.number, pending: true, review });
  }

  let decision = 'approve';
  if (scenario === 'partial') decision = 'partial';
  else if (scenario === 'reject' && !(c.rejections > 0) && kind !== 'enhancement') decision = 'reject';
  else if (scenario === 'query' && kind !== 'query-reply' && kind !== 'enhancement') decision = 'query';

  if (autoApproved && decision === 'approve' && ['auto', 'approve', 'implant', 'two-packages', 'newborn'].includes(scenario)) {
    return result([cb(input, on, options.queuedMs, 'response.complete', settle('approve'))], findings, { caseNumber: c.number });
  }
  if (kind !== 'enhancement') c.status = 'pending';
  c.pendingEvent = { action: 'preauth/submit', correlationId: input.correlationId, kind };
  const ctx = settle(decision);
  return result([queued, cb(input, on, options.decisionMs, 'response.complete', ctx)], findings, { caseNumber: c.number });
}

function handleClaim(input, on, bundle, headers, notes, result) {
  const scenario = input.scenario;
  const { kind, c } = classifyClaim(bundle, headers);
  const findings = rules.validate('claim/submit', bundle, { kind, caseRec: c, raw: input.raw }).concat(notes);
  const bad = findings.find(f => f.refuse);
  if (bad) return result(refuse(input, on, bad, c && c.number), findings);
  const member = B.member(bundle);
  const items = priceLines(B.items(bundle));
  const asked = B.total(bundle) != null ? B.total(bundle) : items.reduce((s, i) => s + i.submitted, 0);
  // a claim is paid what it asks, up to the approved lines
  const eligible = items.reduce((s, i) => s + Math.min(i.submitted, Math.max(i.eligible, (c && (c.packages.find(p => p.code === i.code) || {}).eligible) || 0)), 0) || asked;
  // A claim names the pre-auth's case number in insurance.preAuthRef (The HIMS, fixture happy-claim). 1518 answered
  // with that same preAuthRef (real sandbox traffic pre-auth, real sandbox traffic claim ack: both ...2026112090000015), so a case the mock
  // does not hold (a restart, a pre-auth decided elsewhere) is taken under that number, never a new one.
  const ref = B.caseRef(bundle);
  const caseRec = c || (ref && ref.startsWith(state.CASE_PREFIX)
    ? state.seedCase({ number: ref, member, admission: B.admissionId(bundle), status: 'approved' })
    : state.openCase({ member, admission: B.admissionId(bundle) }));
  caseRec.lastCorrelationId = input.correlationId;
  if (kind === 'claim' && state.OPEN.includes(caseRec.status)) caseRec.status = 'closed';   // a claim closes the pre-auth
  caseRec.claim.count += 1;
  caseRec.claim.lastBundle = bundle; caseRec.claim.lastItems = items; caseRec.claim.lastEligible = eligible;
  const ctxBase = { caseNumber: caseRec.number, items, kind, discharge: B.discharge(bundle) };
  const queued = cb(input, on, options.queuedMs, 'response.partial', Object.assign({ decision: 'queued', outcome: 'queued', amount: 0 }, ctxBase));

  if (scenario === 'pending') {
    caseRec.claim.status = 'pending';
    caseRec.pendingEvent = { action: 'claim/submit', correlationId: input.correlationId, kind, input, items, eligible };
    return result([queued], findings, { caseNumber: caseRec.number, pending: true });
  }

  let decision = 'approve';
  if (scenario === 'partial' || (scenario === 'erroneous' && kind === 'claim')) decision = 'partial';
  else if (scenario === 'reject' && kind === 'claim') decision = 'reject';
  else if (scenario === 'reprocess' && kind === 'claim') decision = 'reject';
  else if (scenario === 'query' && kind === 'claim') decision = 'query';

  const out = [queued];
  const ctx = settleClaim(caseRec, decision, eligible, ctxBase, member);
  // a claim query: claim/on_submit, response.complete, ClaimResponse outcome partial (fixture claim-queried, fixture claim-queried)
  out.push(cb(input, on, options.decisionMs, 'response.complete', ctx));
  if ((scenario === 'payment' || scenario === 'erroneous') && (decision === 'approve' || decision === 'partial') && kind !== 'erroneous')
    out.push(...paymentNotices(input, caseRec, ctx.amount));
  return result(out, findings, { caseNumber: caseRec.number });
}

function settleClaim(c, decision, eligible, ctxBase, member) {
  c.pendingEvent = null;
  if (decision === 'approve' || decision === 'partial') {
    const amt = decision === 'partial' ? Math.round(eligible * PARTIAL_SHARE) : eligible;
    c.claim.status = 'approved';
    c.claim.approved += amt;
    if (member) state.spend(member, amt);
    c.history.push({ event: 'claim-approved', amount: amt, at: Date.now() });
    return Object.assign({ decision, outcome: 'complete', amount: amt, note: decision === 'partial' ? 'Partially approved' : 'Approved' }, ctxBase);
  }
  if (decision === 'reject') {
    c.claim.status = 'rejected';
    c.history.push({ event: 'claim-rejected', at: Date.now() });
    return Object.assign({ decision, outcome: 'complete', amount: 0, note: REJECT_REASON }, ctxBase);
  }
  c.claim.status = 'queried';
  c.history.push({ event: 'claim-queried', at: Date.now() });
  return Object.assign({ decision: 'query', outcome: 'partial', amount: 0, note: QUERY_TEXT }, ctxBase);
}

function paymentNotices(input, c, amount) {
  const out = [];
  for (let n = 1; n <= 2; n++) {
    c.paymentNotices += 1;
    // each notice opens its own conversation (fixture payment-notice: correlation unlike the claim's); workflow 30 on the
    // first, 33 on the second (real sandbox traffic then real sandbox traffic, 12 Nov)
    const p = cb(input, 'paymentnotice/request', options.decisionMs + n * options.paymentMs, 'request.initiated',
      { decision: 'payment', outcome: 'complete', amount, caseNumber: c.number, notice: n });
    out.push(Object.assign(p, { correlationId: crypto.randomUUID(), workflowId: n === 1 ? '30' : '33', notice: n }));
  }
  return out;
}

// The mock desk: decide a case that waits (scenario pending). decision: approve | partial | query | reject.
function desk({ caseNumber, decision, amount, note }) {
  const c = state.findCase(caseNumber);
  if (!c || !c.pendingEvent || !c.pendingEvent.input) return { callbacks: [], error: 'No request waits on case ' + caseNumber + '.' };
  const ev = c.pendingEvent;
  const input = ev.input;
  const ctxBase = { caseNumber: c.number, items: ev.items, kind: ev.kind };
  let ctx;
  if (ev.action === 'claim/submit') ctx = settleClaim(c, decision, amount != null ? amount : ev.eligible, ctxBase, B.member(input.bundle));
  else {
    c.pendingEvent = null;
    if (decision === 'approve' || decision === 'partial') {
      const amt = amount != null ? amount : decision === 'partial' ? Math.round(ev.eligible * PARTIAL_SHARE) : ev.eligible;
      c.status = 'approved'; c.approved = amt;
      c.packages = ev.items.map(i => ({ code: i.code, eligible: i.eligible, speciality: i.speciality, strat: i.strat }));
      ctx = Object.assign({ decision, outcome: 'complete', amount: amt, note: note || 'Approved' }, ctxBase);
    } else if (decision === 'reject') {
      c.status = 'rejected'; c.rejections = (c.rejections || 0) + 1;
      ctx = Object.assign({ decision, outcome: 'complete', amount: 0, note: note || REJECT_REASON }, ctxBase);
    } else {
      c.status = 'queried';
      ctx = Object.assign({ decision: 'query', outcome: 'queried', amount: 0, note: note || QUERY_TEXT }, ctxBase);
    }
  }
  if (note) ctx.note = note;
  const on = ON[ev.action];
  return { callbacks: [cb(input, on, 0, 'response.complete', ctx)], caseNumber: c.number };
}

function validate(action, bundle, st) {
  return rules.validate(normalise(action), bundle, st || {});
}

module.exports = {
  handle, validate, desk, setScenario, setOptions,
  scenarios: () => scenarios.list(),
  rules: () => rules.list(),
  state, reset: seed => state.reset(seed), cases: () => Object.values(state.get().cases),
  _internal: { priceLines, classifyPreauth, classifyClaim, normalise },
};
