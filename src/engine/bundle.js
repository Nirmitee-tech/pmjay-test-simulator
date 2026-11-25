'use strict';
// Reads a PMJAY request bundle the way the HIMS writes it. Field places checked against real bundles the HIMS sent to
// 1518@hcx (sandbox payloads, 19 Nov) and the HIMS's builders :
// - package line: Claim.item[].productOrService.coding[0].code, speciality in item.category.coding[0].code,
//  room level as item.modifier[].coding[].code starting STRAT (out-f469014d, SN063D with STRAT006a, 16 Nov)
// - implant: its own line whose code starts IMP (out-a59ca9d2, SB017A + IMP0129, 17 Nov)
// - policy: Coverage.identifier[].value (PMJAY/HP/S/G); member: Coverage.subscriberId (SBXSTG269)
// - case: Claim.insurance[].preAuthRef or Claim.related[].claim.identifier.value; admission: Claim.identifier[0].value
// - dates: supportingInfo ADDD (admission) and DSDE (discharge), else Claim.billablePeriod start and end
// - discharge type: supportingInfo category DIS, code DTM (death; DTH is discharge to home, fixtures death-*) / DAMA / LAMA..., value "Before Surgery" / "After Surgery"
// - newborn: a second Patient linked with link.type "refer" (the reference HIMS code, NHA sample 12 Nov)

function entries(bundle) { return (bundle && Array.isArray(bundle.entry)) ? bundle.entry : []; }
function resources(bundle, type) {
  if (bundle && bundle.resourceType === type) return [bundle];
  return entries(bundle).map(e => e && e.resource).filter(r => r && (!type || r.resourceType === type));
}
function first(bundle, type) { return resources(bundle, type)[0] || null; }
function code(cc) { return (((cc || {}).coding || [])[0] || {}).code || null; }

function claimLike(bundle) {
  return first(bundle, 'Claim') || first(bundle, 'CoverageEligibilityRequest');
}

function items(bundle) {
  const c = claimLike(bundle);
  if (!c) return [];
  return (c.item || []).map((it, i) => {
    const pcode = code(it.productOrService);
    const mods = [];
    for (const m of it.modifier || []) for (const cd of m.coding || []) if (cd.code) mods.push(cd.code);
    const q = it.quantity ? it.quantity.value : undefined;
    const price = it.net && typeof it.net.value === 'number' ? it.net.value
      : it.unitPrice && typeof it.unitPrice.value === 'number' ? it.unitPrice.value : null;
    return {
      index: i, sequence: it.sequence || i + 1, code: pcode, speciality: code(it.category), quantity: q,
      hasQuantity: !!it.quantity, amount: price, modifiers: mods,
      strat: mods.filter(m => /^STRAT/i.test(m)),
      isImplant: /^IMP/i.test(pcode || ''),
      informationSequence: Array.isArray(it.informationSequence) ? it.informationSequence : null,
    };
  });
}

function supportingInfo(bundle) {
  const c = first(bundle, 'Claim');
  if (!c) return [];
  return (c.supportingInfo || []).map(s => ({
    sequence: s.sequence, category: code(s.category), code: code(s.code),
    value: s.valueString != null ? s.valueString : s.timingDate != null ? s.timingDate : null,
    attachment: s.valueAttachment || null,
  }));
}

function policies(bundle) {
  const out = [];
  for (const cov of resources(bundle, 'Coverage')) for (const id of cov.identifier || []) if (id && id.value) out.push(String(id.value));
  return out;
}

function member(bundle) {
  const cov = first(bundle, 'Coverage');
  if (cov && cov.subscriberId) return String(cov.subscriberId);
  for (const p of resources(bundle, 'Patient'))
    for (const id of p.identifier || []) if (code(id.type) === 'PMJAY' && id.value) return String(id.value);
  return null;
}

function caseRef(bundle) {
  const c = first(bundle, 'Claim');
  if (c) {
    for (const ins of c.insurance || []) for (const r of ins.preAuthRef || []) if (r) return String(r);
    for (const rel of c.related || []) {
      const v = rel && rel.claim && rel.claim.identifier && rel.claim.identifier.value;
      if (v) return String(v);
    }
  }
  const t = first(bundle, 'Task');
  if (t) {
    for (const inp of t.input || []) if (/claimNumber|initimationNumber|preauth/i.test(code(inp.type) || '') && inp.valueString) return String(inp.valueString);
    for (const b of t.basedOn || []) if (b && b.identifier && b.identifier.value) return String(b.identifier.value);
  }
  return null;
}

function relatedPrior(bundle) {
  const c = first(bundle, 'Claim');
  return c ? (c.related || []).map(r => r && r.claim && r.claim.identifier && r.claim.identifier.value).filter(Boolean) : [];
}

function admissionId(bundle) {
  const c = first(bundle, 'Claim');
  const id = c && (c.identifier || [])[0];
  return id && id.value ? String(id.value) : null;
}

// FHIR dateTime to epoch ms. A bare date is midnight, and a time with no offset is IST, as 1518 read our
// "2026-11-16" discharge as midnight (PAYR-1357, real sandbox traffic,).
function toMs(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00+05:30';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += '+05:30';
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function dates(bundle) {
  const c = first(bundle, 'Claim') || {};
  const si = supportingInfo(bundle);
  const pick = k => { const x = si.find(s => s.code === k); return x ? x.value : null; };
  const bp = c.billablePeriod || {};
  const admission = pick('ADDD') || bp.start || null;
  const discharge = pick('DSDE') || bp.end || null;
  return { admission, discharge, admissionMs: toMs(admission), dischargeMs: toMs(discharge) };
}

function discharge(bundle) {
  const d = supportingInfo(bundle).find(s => s.category === 'DIS');
  return d ? { type: d.code, stage: d.value } : null;
}

function isNewborn(bundle) {
  const pats = resources(bundle, 'Patient');
  if (pats.length > 1) return true;
  return pats.some(p => (p.link || []).some(l => l && l.type === 'refer'));
}

function task(bundle) {
  const t = first(bundle, 'Task');
  if (!t) return null;
  const inputs = {};
  for (const i of t.input || []) { const k = code(i.type); if (k) inputs[k] = i.valueString; }
  return { code: code(t.code), inputs, resource: t };
}

function claimUse(bundle) { const c = first(bundle, 'Claim'); return c ? c.use : null; }
function total(bundle) { const c = first(bundle, 'Claim'); return c && c.total && typeof c.total.value === 'number' ? c.total.value : null; }

module.exports = { entries, resources, first, code, claimLike, items, supportingInfo, policies, member, caseRef, relatedPrior,
  admissionId, toMs, dates, discharge, isNewborn, task, claimUse, total };
