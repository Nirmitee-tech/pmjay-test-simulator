'use strict';
// Case state the way 1518 keeps it, in memory. What each piece rests on:
// - case number PMJAY/HP/S/2024/R2/<yyyymmdd><8-digit counter>, e.g. 2026111690000003
// - one open pre-auth per member at a hospital (PAYR-1238, real sandbox traffic); a claim or a cancel closes it
// - after a rejection a new pre-auth on the same admission keeps the same case number
// - one pending event per case (PAYR-1372, fixture error-payr-1372-active-event-found-with-correlation-id-c)
// - wallet per member: the plan's family cover, generalCost 500,000 INR (plan.json policy.generalCost, 1518 plan real sandbox traffic)
const plan = require('./plan.json');

const CASE_PREFIX = 'PMJAY/HP/S/2024/R2/';
const OPEN = ['pending', 'queried', 'approved'];

function fresh() {
  return {
    scenario: null,
    // SBXSTG269 starts where 1518 last left it: allowed 392000, used 108000 of the 500000 cover (real sandbox traffic, 23 Nov 2026)
    members: { SBXSTG269: { id: 'SBXSTG269', wallet: 392000 } },
    cases: {},        // by case number
    counters: {},     // by yyyymmdd
    log: [],
  };
}
function walletStart() { return (plan.policy && plan.policy.generalCost && plan.policy.generalCost.value) || 500000; }

let store = fresh();

function reset(seed) {
  store = fresh();
  if (seed && Array.isArray(seed.members)) for (const m of seed.members) addMember(m.id || m, m.wallet);
  return store;
}
function get() { return store; }
// Swaps in another store and returns the one it replaced (the playground runs on its own store, so the HIMS's cases
// are never touched). Synchronous callers only: swap, handle(), swap back.
function use(other) { const prev = store; store = other || fresh(); return prev; }

function addMember(id, wallet) {
  store.members[id] = { id, wallet: typeof wallet === 'number' ? wallet : walletStart() };
  return store.members[id];
}

function ymd(now) {
  // IST date, as 1518's case numbers carry the Indian date
  const d = new Date((now || Date.now()) + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function nextCaseNumber(now) {
  const day = ymd(now);
  store.counters[day] = (store.counters[day] || 0) + 1;
  return CASE_PREFIX + day + String(10000000 + store.counters[day]);
}

function openCase({ member, admission, now }) {
  const number = nextCaseNumber(now);
  const c = {
    number, member, admission, status: 'pending', packages: [], approved: 0, pendingEvent: null,
    claim: { status: null, approved: 0, count: 0 }, paymentNotices: 0, history: [],
  };
  store.cases[number] = c;
  return c;
}

// Puts a case in the store as it stands on 1518 (tests, and replaying a real case from fixtures).
function seedCase(o) {
  const c = Object.assign({ status: 'approved', packages: [], approved: 0, pendingEvent: null,
    claim: { status: null, approved: 0, count: 0 }, paymentNotices: 0, history: [] }, o);
  store.cases[c.number] = c;
  return c;
}

function findCase(ref) {
  if (!ref) return null;
  if (store.cases[ref]) return store.cases[ref];
  // the last part alone, as NHA accepts
  const hit = Object.values(store.cases).find(c => c.number.endsWith('/' + ref) || c.number.endsWith(ref));
  return hit || null;
}

function caseFor(member, admission) {
  return Object.values(store.cases).filter(c => c.member === member && c.admission === admission).pop() || null;
}

function openPreauthFor(member, exceptAdmission) {
  return Object.values(store.cases).find(c => c.member === member && OPEN.includes(c.status) && c.admission !== exceptAdmission) || null;
}

function walletLeft(member) {
  const m = store.members[member];
  return m ? m.wallet : null;
}
function spend(member, amount) {
  const m = store.members[member];
  if (m) m.wallet = Math.max(0, m.wallet - amount);
}

function record(entry) { store.log.push(Object.assign({ at: new Date().toISOString() }, entry)); }

module.exports = { CASE_PREFIX, OPEN, reset, get, use, fresh, addMember, nextCaseNumber, openCase, seedCase, findCase, caseFor, openPreauthFor,
  walletLeft, spend, record, walletStart };
