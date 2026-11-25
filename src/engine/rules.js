'use strict';
// Every check 1518@hcx was seen to make, one rule each, with the message text copied from real sandbox traffic
// (sender 1518@hcx, error message text) and the source of the rule. Read-only query run 24 Nov 2026.
//
// "observed" lists the actions 1518 refused it on. "actions" is where the mock applies it. Where they differ the
// rule says why; that wider use is a prediction, not something 1518 was seen to do.
//
// Order: 1518 answers one error at a time, and in which order it checks is not known. The mock reports the first
// refusing rule in this list order (policy, member, line shape, plan rules, case state, documents, dates, money).
const B = require('./bundle');
const plan = require('./plan.json');
const state = require('./state');

const PMJAY_POLICY = 'PMJAY/HP/S/G';
const pkg = code => (code && plan.packages[code]) || null;
const yes = (p, k) => !!p && String((p.rules || {})[k] || '').trim().toUpperCase() === 'Y';
const conservative = p => !!p && /^(conservative|medical)$/i.test(String((p.rules || {}).ProcedureType || '').trim());
const packageLines = items => items.filter(i => i.code && !i.isImplant);
const money = n => Number(n || 0).toLocaleString('en-IN');

const COVER = 'coverageeligibility/check';
const PLAN = 'insuranceplan/request';
const PREAUTH = 'preauth/submit';
const CLAIM = 'claim/submit';

const RULES = [
  {
    id: 'plan-request-policy', code: 'PAYR-1402', actions: [PLAN], observed: [PLAN],
    source: 'fixture error-payr-1402-requested-policy-100217-found-not-be-ass (12 Nov 2026)',
    check(ctx) {
      const t = B.task(ctx.bundle);
      const pol = t && t.inputs.policyNumber;
      if (pol && pol !== PMJAY_POLICY) return [{ path: 'Task.input[policyNumber]', message: `Requested policy ${pol} found not be associated with any payer for insurance plan request. Hence request will not be processed.` }];
      return [];
    },
  },
  {
    id: 'cover-no-pmjay-policy', code: 'HBP0006', actions: [COVER], observed: [COVER],
    source: 'fixture error-hbp0006-no-data-configured-for-the-given-payer (16 Nov 2026)',
    check(ctx) {
      const pols = B.policies(ctx.bundle);
      if (!pols.includes(PMJAY_POLICY)) return [{ path: 'Coverage.identifier', message: 'No data configured for the given payer.' }];
      return [];
    },
  },
  {
    id: 'policy-not-listed', code: 'PAYR-1250', actions: [PREAUTH, CLAIM], observed: [PREAUTH],
    // Applied to the claim too: a claim carries the same Coverage, and 1518 has not been sent one with 100217 to see.
    source: 'real sandbox traffic (9 Nov) and 13 Nov',
    check(ctx) {
      const bad = B.policies(ctx.bundle).find(p => p !== PMJAY_POLICY);
      if (bad) return [{ path: 'Coverage.identifier', message: `Requested policy ${bad} is not listed. Please try again with valid policy code.` }];
      return [];
    },
  },
  {
    id: 'member-not-covered', code: 'PAYR-1123', actions: [COVER], observed: [COVER],
    // 1518 sent this on 20 Nov to to every team (an NHA-side window,). The mock uses the
    // same words for a member it does not hold, which is what the text says; that 1518 checks exactly this is not proven.
    source: 'fixture error-payr-1123-beneficiary-is-not-a-covered-member-for (20 Nov 2026), message text',
    check(ctx) {
      const m = B.member(ctx.bundle);
      if (!m || !state.get().members[m]) return [{ path: 'Coverage.subscriberId', message: 'Beneficiary is not a covered member for requested payer. Please enroll beneficiary for applicable policy of requested payer and try again.' }];
      return [];
    },
  },
  {
    id: 'speciality-null', code: 'PAYR-1114', actions: [COVER, PREAUTH, CLAIM], observed: [COVER],
    // On pre-auth and claim by prediction: the message names the plan's speciality per item, and every pre-auth
    // and claim 1518 accepted carried it.
    source: 'real sandbox traffic (9 Nov 2026)',
    check(ctx) {
      const out = [];
      for (const i of ctx.items) if (i.code && !i.speciality)
        out.push({ path: `item[${i.index}].category`, message: `Invalid speciality code received as null for item ${i.code}. Please try again with valid data. Speciality code is available as the code of the category for specific cost of plan in isurance plan.` });
      return out;
    },
  },
  {
    id: 'quantity', code: 'PAYR-1045', actions: [COVER, PREAUTH, CLAIM], observed: [COVER],
    // Checks a whole number of 1 or more. A JSON 1.0 cannot be told from 1 once parsed, so the decimal case the
    // message mentions is only caught when the server passes the raw text (ctx.raw).
    source: 'real sandbox traffic (9 Nov 2026)',
    check(ctx) {
      const out = [];
      const msg = 'Invalid quantity received for item. Hence request will not be processed further. Please ensure value of quantity is a number, and not a decimal value. For example: valid quantity value should be 1, and 1.0 will be considered as invalid.';
      for (const i of ctx.items) {
        if (!i.code) continue;
        if (!i.hasQuantity || typeof i.quantity !== 'number' || !Number.isInteger(i.quantity) || i.quantity < 1) out.push({ path: `item[${i.index}].quantity`, message: msg });
      }
      if (!out.length && typeof ctx.raw === 'string' && /"quantity"\s*:\s*\{[^}]*"value"\s*:\s*\d+\.\d+/.test(ctx.raw)) out.push({ path: 'item.quantity', message: msg });
      return out;
    },
  },
  {
    id: 'implant-missing', code: 'PAYR-1111', actions: [COVER, PREAUTH], observed: [COVER],
    // On the pre-auth by prediction: the HIMS's own guard (the reference HIMS ImplantApplicable) blocks it there too,
    // and 1518 accepted SB017A with IMP0129 as its own line (17 Nov, fixture implant-preauth).
    source: 'real sandbox traffic (9 Nov 2026), plan ImplantApplicable',
    check(ctx) {
      const out = [];
      const implants = ctx.items.filter(i => i.isImplant).map(i => i.code);
      for (const l of packageLines(ctx.items)) {
        const p = pkg(l.code);
        if (!yes(p, 'ImplantApplicable')) continue;
        const allowed = (p.implants || []).map(x => x.code);
        if (!implants.some(c => allowed.includes(c)))
          out.push({ path: `item[${l.index}]`, message: `Implant is applicable for procedure code ${l.code}, but no implant has been requested. If implant is allowed for a given procedure, it is mandatory to add applicable implants in the requested item list, if the parent procedure is requested. Kindly refer to the insurance plan to get the applicable implants for a given procedure.` });
      }
      return out;
    },
  },
  {
    id: 'stratification-missing', code: 'PAYR-1111', actions: [COVER, PREAUTH], observed: [COVER],
    // On the pre-auth by prediction, as for the implant. On the claim 1518 answered the same gap on LM100 with
    // PAYR-1323 instead (fixture error-payr-1323-insufficient-wallet-balance-hence-the-r), so the claim has its own rule below.
    source: 'real sandbox traffic (12 Nov 2026), plan StratificationAllowed',
    check(ctx) {
      const out = [];
      for (const l of packageLines(ctx.items)) {
        const p = pkg(l.code);
        if (yes(p, 'StratificationAllowed') && !l.strat.length)
          out.push({ path: `item[${l.index}].modifier`, message: `Stratification is allowed for procedure ${l.code}. But no stratification received.` });
      }
      return out;
    },
  },
  {
    id: 'one-open-preauth', code: 'PAYR-1238', actions: [PREAUTH], observed: [PREAUTH],
    source: 'real sandbox traffic (9 Nov) and the 18 Nov refusal naming case 2026111890000009',
    check(ctx) {
      if (ctx.kind !== 'new') return [];
      const m = B.member(ctx.bundle);
      const open = m && state.openPreauthFor(m, B.admissionId(ctx.bundle));
      if (open) return [{ path: 'Claim.insurance', message: `Beneficiary is having an active preauthorization request at this hospital with reference number ${open.number}. Hence the request will not be processed. Kindly cancel the active preauthorization request or raise a claim to proceed with current preauthorization.` }];
      return [];
    },
  },
  {
    id: 'active-event', code: 'PAYR-1372', actions: [PREAUTH, CLAIM], observed: [CLAIM],
    // On an enhancement by prediction: the text says no new event is accepted for the case.
    source: 'fixture error-payr-1372-active-event-found-with-correlation-id-c (16 Nov 2026)',
    check(ctx) {
      const c = ctx.caseRec;
      if (!c || !c.pendingEvent) return [];
      if (ctx.action === PREAUTH && ctx.kind !== 'enhancement') return [];
      return [{ path: 'Claim', message: `Active event found with correlation id ${c.pendingEvent.correlationId} for case number ${c.admission || c.number} which is awaiting process completion by payer / awaiting response from provider. No new event will be accepted for requested case until previous event is closed.` }];
    },
  },
  {
    id: 'erroneous-too-early', code: 'PAYR-1372', actions: [CLAIM], observed: [],
    // Not seen from 1518 by us. NHA guidance to integrators, 16 Oct to 5 Nov 2026, as recorded in
    // the reference HIMS code: raise the erroneous claim only after the second payment notice, or it is refused 1372.
    source: 'the reference HIMS code summary (NHA guidance to integrators, 16 Oct to 5 Nov 2026)',
    check(ctx) {
      const c = ctx.caseRec;
      if (ctx.kind !== 'erroneous' || !c) return [];
      if (c.paymentNotices >= 2) return [];
      return [{ path: 'Claim', message: `Active event found with correlation id ${c.lastCorrelationId || ''} for case number ${c.admission || c.number} which is awaiting process completion by payer / awaiting response from provider. No new event will be accepted for requested case until previous event is closed.` }];
    },
  },
  {
    id: 'enhancement-not-allowed', code: 'PAYR-1245', actions: [PREAUTH], observed: [PREAUTH],
    source: 'fixture error-payr-1245-enhancement-is-not-applicable-on-the-pre (10 Nov 2026, top-up on SB017A, plan EnhancementAllowed N)',
    check(ctx) {
      if (ctx.kind !== 'enhancement' || !ctx.caseRec) return [];
      const blocked = ctx.caseRec.packages.find(p => p.code && !/^IMP/i.test(p.code) && pkg(p.code) && !yes(pkg(p.code), 'EnhancementAllowed'));
      if (blocked) return [{ path: 'Claim.item', message: 'Enhancement is not applicable on the previous approved packages. Hence enhancement request will not be accepted.' }];
      return [];
    },
  },
  {
    id: 'second-conservative', code: 'PAYR-1245', actions: [PREAUTH], observed: [PREAUTH],
    source: 'fixture error-payr-1245-only-one-conservative-procedure-can-be-b (16 Nov 2026, MG062A added to SN063D); plan ProcedureType',
    check(ctx) {
      const codes = new Set();
      for (const l of packageLines(ctx.items)) if (conservative(pkg(l.code))) codes.add(l.code);
      if (ctx.caseRec && ctx.kind === 'enhancement') for (const p of ctx.caseRec.packages) if (conservative(pkg(p.code))) codes.add(p.code);
      if (codes.size > 1) return [{ path: 'Claim.item', message: `Only one conservative procedure can be booked for a case, but received request for ${codes.size} conservative procedures.` }];
      return [];
    },
  },
  {
    id: 'newborn-document-list', code: 'PAYR-1263', actions: [PREAUTH], observed: [PREAUTH],
    // The one change that cleared it on 20 Nov: no informationSequence on the package line. Other causes of the
    // same text (a missing proof of birth, for example) were not isolated and are not checked.
    source: 'real sandbox traffic (17 to 20 Nov 2026); the reference HIMS',
    check(ctx) {
      if (!B.isNewborn(ctx.bundle)) return [];
      const l = packageLines(ctx.items).find(i => i.informationSequence && i.informationSequence.length);
      if (l) return [{ path: `item[${l.index}].informationSequence`, message: 'Documents are mandatory for the new born beneficiary' }];
      return [];
    },
  },
  {
    id: 'attachment-base64', code: 'PAYR-1008', actions: [PREAUTH, CLAIM], observed: [CLAIM],
    // What the payloads show (19 Nov backup, claims real sandbox traffic, 10 Nov): the PDFs were not the cause. Adding an
    // xref table (out-1fefeef6) changed nothing; the claim passed when the last document's supportingInfo category
    // went from HDS to ATT (fixture error-payr-1008-invalid-base64-value-received-in-attachm refused, real sandbox traffic accepted, no other change). Across all 1518 answers, accepted
    // bundles carried document categories ATT and INV only; refused ones also DIA, MB, HDS. DOB is allowed for the
    // newborn's proof of birth (the reference HIMS, accepted 20 Nov). So the mock refuses a document that is not under ATT,
    // INV or DOB, has no inline data, or is not valid base64. Which item 1518 names first was not consistent; the
    // mock names the first one. An earlier guess ("real PDFs with an xref table") is not what fixed it.
    // On the pre-auth by prediction: pre-auths carry the same documents.
    source: 'fixture error-payr-1008-invalid-base64-value-received-in-attachm refused, real sandbox traffic accepted (10 Nov 2026)',
    check(ctx) {
      for (const s of B.supportingInfo(ctx.bundle)) {
        const a = s.attachment;
        if (!a) continue;
        const data = a.data == null ? '' : String(a.data).replace(/\s+/g, '');
        const b64 = data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
        if (!b64 || !['ATT', 'INV', 'DOB'].includes(s.category))
          return [{ path: `supportingInfo[${s.sequence}]`, message: `Invalid Base64 value received in attachment for item ${s.code || s.category}. Please try again with valid Base64 value. Please refer to https://hl7.org/fhir/R4/datatypes.html#Attachment` }];
      }
      return [];
    },
  },
  {
    id: 'admission-after-discharge', code: 'PAYR-1357', actions: [CLAIM], observed: [CLAIM],
    source: 'fixture error-payr-1357-admission-date-cannot-be-after-the-disch (16 Nov 2026); accepted once the discharge carried a time',
    check(ctx) {
      const d = B.dates(ctx.bundle);
      if (d.admissionMs != null && d.dischargeMs != null && d.admissionMs > d.dischargeMs)
        return [{ path: 'Claim.supportingInfo[DSDE]', message: 'Admission date cannot be after the discharge date. Hence request will not be processed. Please correct the data and try again.' }];
      return [];
    },
  },
  {
    id: 'unpriced-line', code: 'PAYR-1323', actions: [CLAIM], observed: [CLAIM],
    // 1518 said "wallet" but the cause was the line: LM100 with no room level, wrong speciality, 12,000; accepted at
    // STRAT006a 1,800 under SG (fixture lama-claim). A line at or below what 1518 approved on the pre-auth passes (MN001A, 20 Nov).
    source: 'fixture error-payr-1323-insufficient-wallet-balance-hence-the-r refused, fixture lama-claim accepted (18 Nov 2026); the reference HIMS',
    check(ctx) {
      const msg = 'Insufficient wallet balance. Hence the request will not be processed.';
      for (const l of packageLines(ctx.items)) {
        const p = pkg(l.code);
        if (!p) continue;
        const approved = ctx.caseRec && (ctx.caseRec.packages.find(x => x.code === l.code) || {}).eligible;
        const byLevel = p.rates.length > 0 && (yes(p, 'StratificationAllowed') || p.amount === 0);
        let cap = null;
        if (byLevel) {
          if (!l.strat.length) return [{ path: `item[${l.index}].modifier`, message: msg }];
          const r = p.rates.find(x => x.code === l.strat[0]);
          cap = r ? (p.amount || 0) + r.amount : null;   // package amount + level rate, as 1518 priced MN001A (20 Nov)
        } else if (typeof p.amount === 'number' && p.amount > 0) cap = p.amount;
        if (l.amount == null) return [{ path: `item[${l.index}].net`, message: msg }];
        const limit = Math.max(cap || 0, approved || 0);
        if (cap != null && l.amount > limit) return [{ path: `item[${l.index}].net`, message: msg }];
      }
      return [];
    },
  },
  {
    id: 'wallet', code: 'PAYR-1323', actions: [CLAIM], observed: [CLAIM],
    // The family cover is 5,00,000 a year in the plan. 1518's cover answers carry no wallet amount, so how 1518 counts the balance is not known; the mock takes off every approved claim.
    source: 'fixture error-payr-1323-insufficient-wallet-balance-hence-the-r text; plan generalCost 500000 (real sandbox traffic)',
    check(ctx) {
      const m = B.member(ctx.bundle);
      const left = m ? state.walletLeft(m) : null;
      const t = B.total(ctx.bundle);
      if (left != null && t != null && t > left) return [{ path: 'Claim.total', message: 'Insufficient wallet balance. Hence the request will not be processed.' }];
      return [];
    },
  },
];

// Findings that do not refuse: what 1518 or NHA did instead of refusing.
const NOTES = [
  {
    id: 'repeated-package', code: 'ADJ-REPEAT', actions: [PREAUTH],
    source: 'Observed in real sandbox traffic on a 13 Nov top-up: a repeated package code was added in the adjudication, eligible 24,000 on 12,000 + 3,600 (fixture enhancement-approved)',
    check(ctx) {
      if (ctx.kind !== 'enhancement') return [];
      const counts = {};
      for (const l of packageLines(ctx.items)) counts[l.code] = (counts[l.code] || 0) + 1;
      const rep = Object.keys(counts).filter(c => counts[c] > 1);
      return rep.map(c => ({ path: 'Claim.item', message: `Package ${c} is repeated; 1518 adds each repeat at the package rate in adjudication.` }));
    },
  },
];

function validate(action, bundle, ctxIn) {
  const ctx = Object.assign({ action, bundle, items: B.items(bundle), kind: 'new', caseRec: null }, ctxIn || {});
  const findings = [];
  for (const r of RULES) {
    if (!r.actions.includes(action)) continue;
    for (const f of r.check(ctx)) findings.push({ code: r.code, rule: r.id, message: f.message, path: f.path, source: r.source, refuse: true });
  }
  for (const n of NOTES) {
    if (!n.actions.includes(action)) continue;
    for (const f of n.check(ctx)) findings.push({ code: n.code, rule: n.id, message: f.message, path: f.path, source: n.source, refuse: false });
  }
  return findings;
}

function list() {
  return RULES.concat(NOTES).map(r => ({ id: r.id, code: r.code, actions: r.actions, observed: r.observed || [], source: r.source }));
}

module.exports = { RULES, NOTES, validate, list, PMJAY_POLICY, pkg, yes, conservative, COVER, PLAN, PREAUTH, CLAIM };
