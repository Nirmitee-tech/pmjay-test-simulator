'use strict';
// When callbacks leave. The sync ack is always immediate; this decides the delay of each callback.
//
// Modes: fixed {ms}, random {min,max}, sequence {sequence:[...]} (one value per callback, cycling).
// Precedence per request: header X-Mock-Delay (ms, or "min-max") > per-scenario override > global.
// The first callback waits one drawn delay. Each later callback of the same request (the final answer
// after a response.partial, a payment notice after a claim) waits another drawn delay after the one before,
// so a queued ack always arrives before the decision.
//
// PRESETS are measured, not predicted: gaps between the HIMS's send (OUT, HTTP 202) and 1518's first callback on
// the same correlation, real sandbox traffic, sends 9 Sep to 24 Nov 2026 before the mock existed.
// The final answer after a partial came from 1518's human desk (preauth complete p50 8 min, claim p50 16 min,
// up to days), so no preset copies it; 'final' gaps default to the drawn delay.

const PRESETS = {
  // response.partial ack on preauth/submit: n=19, min 4680, p50 6176, p90 11300, max 11560 ms
  'preauth-partial': { mode: 'random', min: 4680, max: 11560, p50: 6176, n: 19 },
  // response.partial ack on claim/submit: n=16, min 4960, p50 6903, p90 9196, max 11586 ms
  'claim-partial': { mode: 'random', min: 4960, max: 11586, p50: 6903, n: 16 },
  // response.error on preauth/submit: n=19, min 3723, p50 5336, p90 9003, max 13063 ms
  'preauth-error': { mode: 'random', min: 3723, max: 13063, p50: 5336, n: 19 },
  // response.error on claim/submit: n=21, min 2556, p50 3823, p90 5563, max 8746 ms
  'claim-error': { mode: 'random', min: 2556, max: 8746, p50: 3823, n: 21 },
  // coverageeligibility/on_check complete: n=63, min 3296, p50 4100, p90 5870 (max 37500 outlier) ms
  coverage: { mode: 'random', min: 3296, max: 5870, p50: 4100, n: 63 },
  // the default the lead asked for: random 3 to 10 s (spans the measured p10 to p90 above)
  default: { mode: 'random', min: 3000, max: 10000 },
};

function normalise(spec) {
  if (spec == null) return null;
  if (typeof spec === 'string') {
    if (PRESETS[spec]) return Object.assign({ preset: spec }, PRESETS[spec]);
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(spec.trim());
    if (m) return { mode: 'random', min: +m[1], max: +m[2] };
    if (/^\d+$/.test(spec.trim())) return { mode: 'fixed', ms: +spec };
    return null;
  }
  if (typeof spec === 'number') return { mode: 'fixed', ms: Math.max(0, spec) };
  if (spec.preset && PRESETS[spec.preset]) return Object.assign({ preset: spec.preset }, PRESETS[spec.preset]);
  const mode = spec.mode;
  if (mode === 'fixed') return { mode, ms: Math.max(0, Number(spec.ms) || 0) };
  if (mode === 'random') {
    const min = Math.max(0, Number(spec.min) || 0), max = Math.max(min, Number(spec.max == null ? min : spec.max) || 0);
    return { mode, min, max };
  }
  if (mode === 'sequence') {
    const seq = (Array.isArray(spec.sequence) ? spec.sequence : []).map(Number).filter(n => n >= 0 && isFinite(n));
    return seq.length ? { mode, sequence: seq } : null;
  }
  return null;
}

/**
 * initial: a spec, or null for the default. rand: () => [0,1) (tests pass their own).
 */
function create(initial, rand) {
  rand = rand || Math.random;
  let global = normalise(initial) || normalise('default');
  const perScenario = new Map();
  let seqIndex = 0;

  function draw(spec) {
    if (spec.mode === 'fixed') return spec.ms;
    if (spec.mode === 'random') return Math.round(spec.min + rand() * (spec.max - spec.min));
    const v = spec.sequence[seqIndex % spec.sequence.length];
    seqIndex++;
    return v;
  }

  /** POST /mock/timing body. {"mode":...} sets global; {"scenario":"x", ...} sets that scenario; {"scenario":"x","clear":true}; {"reset":true}. */
  function set(b) {
    b = b || {};
    if (b.reset) { global = normalise('default'); perScenario.clear(); seqIndex = 0; return { ok: true, state: get() }; }
    if (b.scenario) {
      if (b.clear) { perScenario.delete(String(b.scenario)); return { ok: true, state: get() }; }
      const s = normalise(b.preset ? { preset: b.preset } : b);
      if (!s) return { ok: false, error: 'mode must be fixed {ms}, random {min,max} or sequence {sequence:[ms,...]}, or preset one of ' + Object.keys(PRESETS).join(', ') };
      perScenario.set(String(b.scenario), s);
      return { ok: true, state: get() };
    }
    const s = normalise(b.preset ? { preset: b.preset } : b);
    if (!s) return { ok: false, error: 'mode must be fixed {ms}, random {min,max} or sequence {sequence:[ms,...]}, or preset one of ' + Object.keys(PRESETS).join(', ') };
    global = s; seqIndex = 0;
    return { ok: true, state: get() };
  }

  function get() {
    return { global, scenarios: Object.fromEntries(perScenario), presets: PRESETS };
  }

  /** The spec that applies to one request. */
  function specFor(scenario, headerValue) {
    const fromHeader = headerValue != null && headerValue !== '' ? normalise(String(headerValue)) : null;
    if (fromHeader) return Object.assign({ from: 'header' }, fromHeader);
    if (scenario && perScenario.has(scenario)) return Object.assign({ from: 'scenario' }, perScenario.get(scenario));
    return Object.assign({ from: 'global' }, global);
  }

  /**
   * Give each callback its delay, measured from the request. Order is kept; each later one comes a fresh draw
   * after the previous. Returns new callback objects with delayMs set, and timing notes for the log.
   */
  function plan(callbacks, { scenario, headerValue } = {}) {
    const spec = specFor(scenario, headerValue);
    let at = 0;
    const out = (callbacks || []).map((cb, i) => {
      const gap = draw(spec);
      at += gap;
      return Object.assign({}, cb, { delayMs: at, timing: { from: spec.from, mode: spec.mode, gapMs: gap, atMs: at, index: i } });
    });
    return { callbacks: out, spec };
  }

  return { set, get, plan, specFor, draw };
}

/** The starting spec: PMJAY_TIMING (JSON or "3000-10000"), else fixed defaultDelayMs when a caller (tests) gave one, else random 3 to 10 s. */
function initialFrom(over) {
  const env = process.env.PMJAY_TIMING;
  if (over && over.timing) return over.timing;
  if (env) { try { return JSON.parse(env); } catch (_) { return env; } }
  if (over && over.defaultDelayMs != null) return { mode: 'fixed', ms: Number(over.defaultDelayMs) };
  return null;
}

module.exports = { create, normalise, initialFrom, PRESETS };
