'use strict';
// The seam to Agent B (src/engine) and Agent C (src/responses). Both are required lazily on every
// call so they can land while the server runs; until they exist, every request is approved.
const path = require('path');
const actions = require('./actions');
const fallback = require('./fallback');

function tryRequire(rel) {
  const p = path.resolve(__dirname, rel);
  try { return { mod: require(p) }; }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(p)) return { mod: null };
    return { mod: null, error: e };
  }
}

function responses() { return tryRequire('../responses').mod; }

function buildResponse(kind, ctx) {
  const r = responses();
  if (r && typeof r.build === 'function') {
    try { const b = r.build(kind, ctx); if (b) return { bundle: b, source: 'responses' }; }
    catch (e) { return { bundle: fallback.build(kind, ctx), source: 'fallback', note: 'responses.build threw: ' + e.message }; }
  }
  return { bundle: fallback.build(kind, ctx), source: 'fallback' };
}

function approveAll(input, delayMs) {
  const on = actions.onActionFor(input.action);
  if (!on) return { sync: null, callbacks: [], findings: [], scenario: 'stub' };
  const built = buildResponse(on, Object.assign({ decision: 'approve' }, input));
  return {
    sync: null, scenario: 'stub-approve', findings: [],
    callbacks: [{ action: on, delayMs, bundle: built.bundle, hcxStatus: 'response.complete' }],
  };
}

/** r = { sync, callbacks, findings?, scenario?, pending? , engine: 'engine'|'stub', engineError? } */
function handle(input, opts) {
  const { mod, error } = tryRequire('../engine');
  if (mod && typeof mod.handle === 'function') {
    try {
      const r = mod.handle(input) || {};
      return Object.assign({ sync: null, callbacks: [] }, r, { engine: 'engine' });
    } catch (e) {
      return Object.assign(approveAll(input, opts.delayMs), { engine: 'stub', engineError: 'engine.handle threw: ' + e.message });
    }
  }
  return Object.assign(approveAll(input, opts.delayMs), { engine: 'stub', engineError: error ? 'engine failed to load: ' + error.message : null });
}

function setScenario(name) {
  const { mod } = tryRequire('../engine');
  if (mod && typeof mod.setScenario === 'function') { try { mod.setScenario(name); } catch (_) {} }
}

function scenarios() {
  const { mod } = tryRequire('../engine');
  if (mod) {
    try {
      if (typeof mod.scenarios === 'function') return mod.scenarios();
      if (Array.isArray(mod.scenarios)) return mod.scenarios;
      if (mod.catalogue) return Object.keys(mod.catalogue).map(id => ({ id, label: mod.catalogue[id].label || id }));
    } catch (_) {}
  }
  return [];
}

module.exports = { handle, buildResponse, setScenario, scenarios };

module.exports.engine = () => tryRequire('../engine').mod;
