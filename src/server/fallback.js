'use strict';
// Used only while src/responses (Agent C) is missing or throws: a minimal answer bundle so the
// pipe can be tested end to end. It is not shaped like a real 1518 answer.
const crypto = require('crypto');

function findResource(bundle, type) {
  const entries = (bundle && bundle.entry) || [];
  for (const e of entries) if (e && e.resource && e.resource.resourceType === type) return e.resource;
  return null;
}

function build(kind, ctx) {
  const req = ctx.bundle || {};
  const claim = findResource(req, 'Claim') || findResource(req, 'CoverageEligibilityRequest') || {};
  const decision = ctx.decision || 'approve';
  const total = (claim.total && claim.total.value) || 0;
  const amount = decision === 'reject' ? 0 : decision === 'partial' ? Number(ctx.amount || Math.round(total / 2)) : Number(ctx.amount || total);
  const isElig = /coverageeligibility/.test(kind);
  if (/communication/.test(kind)) {
    const c = { resourceType: 'Communication', id: crypto.randomUUID(), status: 'completed',
      about: [{ reference: 'Claim/' + (claim.id || '') }],
      payload: [{ contentString: ctx.note || 'Mock query: please send the supporting documents.' }] };
    return { resourceType: 'Bundle', id: crypto.randomUUID(), type: 'collection', meta: { tag: [{ code: 'pmjaymock-fallback' }] },
      timestamp: new Date().toISOString(), entry: [{ fullUrl: 'Communication/' + c.id, resource: c }] };
  }
  const resource = isElig ? {
    resourceType: 'CoverageEligibilityResponse', id: crypto.randomUUID(), status: 'active',
    purpose: claim.purpose || ['validation'], outcome: 'complete', disposition: 'Mock: policy active',
    request: { reference: 'CoverageEligibilityRequest/' + (claim.id || '') },
    insurance: [{ inforce: true }],
  } : {
    resourceType: 'ClaimResponse', id: crypto.randomUUID(), status: 'active',
    use: claim.use || (/claim/.test(kind) ? 'claim' : 'preauthorization'),
    outcome: decision === 'reject' ? 'error' : decision === 'partial' ? 'partial' : decision === 'query' ? 'queued' : 'complete',
    disposition: ctx.note || ({ approve: 'Approved', partial: 'Partially approved', query: 'Query raised', reject: 'Rejected' })[decision],
    request: { reference: 'Claim/' + (claim.id || '') },
    total: [{ category: { coding: [{ code: 'benefit' }] }, amount: { value: amount, currency: 'INR' } }],
  };
  return {
    resourceType: 'Bundle', id: crypto.randomUUID(), type: 'collection',
    meta: { tag: [{ code: 'pmjaymock-fallback' }] },
    timestamp: new Date().toISOString(),
    entry: [{ fullUrl: resource.resourceType + '/' + resource.id, resource }],
  };
}

module.exports = { build };
