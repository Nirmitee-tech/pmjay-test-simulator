'use strict';
// Builds src/engine/plan.json from 1518's real InsurancePlan answer (real sandbox traffic, 16 Nov 2026,
// insuranceplan/on_request response.complete, saved in the 19 Nov backup as payload ffa2fb21...json, 33 MB).
// Reads it the way the HIMS does (the reference HIMS code FindPackage): each coverage is a speciality,
// each benefit a package; Claim-Condition extensions are the rules, Claim-SupportingInfoRequirement the documents,
// limit[] with a STRAT code the room-level rates, and an IMP benefit names its packages in ParentProcedure.
// Usage: node src/engine/tools/build-plan.js <plan-bundle.json> [out.json]
const fs = require('fs');
const path = require('path');

function last(url) { const s = String(url || ''); return s.slice(s.lastIndexOf('/') + 1); }
function condValue(c) {
  if (typeof c.valueString === 'string') return c.valueString;
  const codes = ((c.valueCodeableConcept || {}).coding || []).map(x => x.code).filter(Boolean);
  return codes.length ? codes.join(', ') : null;
}

function extract(bundle) {
  const packages = {};
  const implantParents = {};
  let policy = null;
  for (const e of bundle.entry || []) {
    const plan = e.resource;
    if (!plan || plan.resourceType !== 'InsurancePlan') continue;
    policy = policy || { id: plan.id, name: plan.name, identifier: (plan.identifier || []).map(i => i.value),
      generalCost: ((((plan.plan || [])[0] || {}).generalCost || [])[0] || {}).cost || null, period: plan.period || null };
    for (const cov of plan.coverage || []) {
      const spec = ((cov.type || {}).coding || [])[0] || {};
      for (const b of cov.benefit || []) {
        const code = b.id || ((((b.type || {}).coding) || [])[0] || {}).code;
        if (!code) continue;
        const name = (((b.type || {}).coding || [])[0] || {}).display || '';
        const lim0 = ((b.limit || [])[0] || {}).value;
        const amount = lim0 && typeof lim0.value === 'number' ? lim0.value : null;
        const rules = {};
        const documents = [];
        const rates = [];
        for (const l of b.limit || []) {
          const lc = (((l.code || {}).coding || [])[0] || {});
          if (l.value && typeof l.value.value === 'number' && /^STRAT/i.test(lc.code || '')) rates.push({ code: lc.code, display: (lc.display || '').trim(), amount: l.value.value });
        }
        for (const ext of b.extension || []) {
          if (/\/Claim-Condition$/.test(ext.url)) for (const c of ext.extension || []) { const n = last(c.url); if (n) rules[n] = condValue(c); }
          else if (/\/Claim-SupportingInfoRequirement$/.test(ext.url)) for (const req of ext.extension || []) {
            const d = {};
            for (const part of req.extension || []) {
              const cc = (((part.valueCodeableConcept || {}).coding) || [])[0] || {};
              if (part.url === 'category') d.category = cc.code;
              else if (part.url === 'code') { d.code = cc.code; d.display = (cc.display || '').trim(); }
            }
            if (d.code || d.category) documents.push(d);
          }
        }
        if (/^IMP/i.test(code)) {
          for (const p of String(rules.ParentProcedure || '').split(',').map(s => s.trim()).filter(Boolean)) {
            (implantParents[p] = implantParents[p] || []);
            if (!implantParents[p].some(i => i.code === code)) implantParents[p].push({ code, name: name.trim(), amount });
          }
        }
        const prior = packages[code];
        if (prior) { if (!prior.specialities.includes(spec.code)) prior.specialities.push(spec.code); continue; }
        packages[code] = { code, name: name.trim(), speciality: spec.code || null, specialities: [spec.code].filter(Boolean), amount, rates, rules, documents: documents.map(d => d.code).filter(Boolean) };
      }
    }
  }
  for (const [p, imps] of Object.entries(implantParents)) if (packages[p]) packages[p].implants = imps;
  return { source: 'real sandbox traffic, 1518@hcx insuranceplan/on_request response.complete, 16 Nov 2026 (bundle ' + (bundle.id || '') + ')', policy, count: Object.keys(packages).length, packages };
}

if (require.main === module) {
  const src = process.argv[2];
  const out = process.argv[3] || path.join(__dirname, '..', 'plan.json');
  const bundle = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^﻿/, ''));
  const plan = extract(bundle);
  fs.writeFileSync(out, JSON.stringify(plan));
  console.log('packages', plan.count, 'written', out);
}
module.exports = { extract };
