'use strict';
// Which callback answers which request, as the reference HIMS lists them.
const ON = {
  'coverageeligibility/check': 'coverageeligibility/on_check',
  'preauth/submit': 'preauth/on_submit',
  'claim/submit': 'claim/on_submit',
  'predetermination/submit': 'predetermination/on_submit',
  'insuranceplan/request': 'insuranceplan/on_request',
  'task/submit': 'task/on_submit',
  'search/submit': 'search/on_submit',
  'status': 'on_status',
};
// Replies the HIMS sends to payer-initiated messages: acknowledged, no callback of their own.
const REPLIES = ['communication/on_request', 'paymentnotice/on_request'];
const KNOWN = Object.keys(ON).concat(REPLIES);

function onActionFor(action) { return ON[action] || null; }
function isKnown(action) { return KNOWN.includes(action); }
function entityOf(action) { return String(action || '').split('/')[0].replace(/^on_status$/, 'status'); }

module.exports = { ON, REPLIES, KNOWN, onActionFor, isKnown, entityOf };
