'use strict';
// The scenarios a tester can pick. Each says in plain words what the mock payer does, and what the request is
// expected to look like. "expect" checks only add notes (they never refuse): they tell the tester the bundle does
// not look like the scenario they picked.
const B = require('./bundle');

const lines = b => B.items(b).filter(i => i.code && !i.isImplant);
const dis = b => B.discharge(b) || {};

const SCENARIOS = [
  { id: 'auto', label: 'Rules decide', description: 'Checks the request like 1518 does. A refusal comes back if a rule breaks; otherwise it is approved. Packages the plan approves without review are approved at once.' },
  { id: 'approve', label: 'Approve', description: 'Checks the request, then approves the full eligible amount.' },
  { id: 'partial', label: 'Approve part', description: 'Checks the request, then approves half of the eligible amount (a mock choice; 1518 sets its own amount).' },
  { id: 'query', label: 'Ask a question', description: 'Pre-auth: the question comes on the pre-auth answer with outcome queried, as 1518 did on 16 Nov. Claim: the question comes as a claim answer with status partial. The reply is then approved.' },
  { id: 'reject', label: 'Reject', description: 'Rejects the first request on an admission. A new pre-auth on the same admission is accepted and keeps the same case number.' },
  { id: 'pending', label: 'Wait for the desk', description: 'Only the queued answer comes back. Nothing is decided until someone decides it on the mock desk.' },
  { id: 'cancel', label: 'Cancel', description: 'A cancel request on an open pre-auth is answered as complete and the case is closed.' },
  { id: 'enhancement', label: 'Top-up', description: 'Approves the first pre-auth, then checks the top-up: package allows top-ups, one medical package, repeats are priced at the package rate.' },
  { id: 'implant', label: 'Implant', description: 'Expects the package with its implant as a line of its own, then approves.', expect: b => B.items(b).some(i => i.isImplant) ? null : 'No implant line (code starting IMP) in the request.' },
  { id: 'newborn', label: 'Newborn', description: 'Expects the child as a second patient. Approves when the package line carries no document list.', expect: b => B.isNewborn(b) ? null : 'No newborn patient in the request.' },
  { id: 'lama', label: 'LAMA discharge', description: 'Expects a claim with discharge type LAMA, then approves.', expect: b => B.claimUse(b) !== 'claim' || /LAMA/i.test(dis(b).type || '') ? null : 'The claim does not carry discharge type LAMA.' },
  { id: 'dama', label: 'DAMA discharge', description: 'Expects a claim with discharge type DAMA, then approves.', expect: b => B.claimUse(b) !== 'claim' || /DAMA/i.test(dis(b).type || '') ? null : 'The claim does not carry discharge type DAMA.' },
  { id: 'death-before', label: 'Death before surgery', description: 'Expects a claim with discharge type death, before surgery, then approves.', expect: b => B.claimUse(b) !== 'claim' || (/DTM/i.test(dis(b).type || '') && /before/i.test(dis(b).stage || '')) ? null : 'The claim does not say death before surgery.' },
  { id: 'death-after', label: 'Death after surgery', description: 'Expects a claim with discharge type death, after surgery, then approves.', expect: b => B.claimUse(b) !== 'claim' || (/DTM/i.test(dis(b).type || '') && /after/i.test(dis(b).stage || '')) ? null : 'The claim does not say death after surgery.' },
  { id: 'two-packages', label: 'Two packages', description: 'Expects two different packages on the pre-auth, then approves if the rules pass.', expect: b => B.claimUse(b) !== 'preauthorization' || new Set(lines(b).map(i => i.code)).size >= 2 ? null : 'The pre-auth carries fewer than two packages.' },
  { id: 'erroneous', label: 'Erroneous claim', description: 'The first claim is paid short and two payment notices follow. A second claim for the rest is refused until both notices have come.' },
  { id: 'reprocess', label: 'Reprocess', description: 'Rejects the first claim. The claim sent again on the same case is approved.' },
  { id: 'payment', label: 'Payment notice', description: 'Approves the claim, then sends two payment notices for it.' },
];

const BY_ID = Object.fromEntries(SCENARIOS.map(s => [s.id, s]));
function list() { return SCENARIOS.map(({ id, label, description }) => ({ id, label, description })); }
function get(id) { return BY_ID[id] || null; }

module.exports = { SCENARIOS, list, get };
