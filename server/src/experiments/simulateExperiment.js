// Generates a SYNTHETIC cohort for an experiment, with a seeded, known true effect. All rows are fake.
// It is separate from the main funnel dataset so the RCA demo stays clean.
import { mulberry32, gauss, clamp } from '../mock/random.js';
import { assign } from './assign.js';

export const BASELINE = {
  acceptance: 0.45,   // illustrative share of viewed offers accepted
  disbursal: 0.93,    // share of accepted offers that disburse (same constant as the main generator)
  default: 0.04,      // share of disbursed loans that default
  complaint: 0.01,
  tatMedianSeconds: 6 * 3600,
};

/** The effect of the treatment on each metric, as an absolute shift (tatPct is relative). */
export const NO_EFFECT = { acceptance: 0, default: 0, tatPct: 0, complaint: 0 };

/**
 * @param key experiment key (feeds the assignment hash)
 * @param variants [{name, weight}] control first
 * @param opts { n, seed, trueEffect, baseline, dropTreatmentRate }
 *   dropTreatmentRate simulates a logging bug that loses treatment users after assignment (creates a sample ratio mismatch).
 */
export function generateCohort(key, variants, { n = 40000, seed = 1, trueEffect = {}, baseline = {}, dropTreatmentRate = 0 } = {}) {
  const eff = { ...NO_EFFECT, ...trueEffect };
  const base = { ...BASELINE, ...baseline };
  const rng = mulberry32(seed);
  const control = variants[0].name;
  const units = [];
  for (let i = 1; i <= n; i++) {
    const id = `sim-${seed}-${i}`;
    // draw everything first so the random stream does not depend on the variant
    const draws = [rng(), rng(), rng(), gauss(rng), rng(), rng()];
    const variant = assign(id, key, variants);
    if (variant !== control && dropTreatmentRate > 0 && draws[5] < dropTreatmentRate) continue;
    const treated = variant !== control;
    const accepted = draws[0] < clamp(base.acceptance + (treated ? eff.acceptance : 0), 0, 1);
    const disbursed = accepted && draws[1] < base.disbursal;
    const defaulted = disbursed ? draws[2] < clamp(base.default + (treated ? eff.default : 0), 0, 1) : null;
    const tat = disbursed ? Math.round(base.tatMedianSeconds * (treated ? 1 + eff.tatPct : 1) * Math.exp(0.5 * draws[3])) : null;
    const complained = draws[4] < clamp(base.complaint + (treated ? eff.complaint : 0), 0, 1);
    units.push({ unit_id: id, variant, accepted, disbursed, defaulted, tat_seconds: tat, complained });
  }
  return units;
}

/** Plain summary per variant, the only thing the analysis needs. Used for in-memory cohorts and for DB rows alike. */
export function summariseUnits(units) {
  const out = {};
  const tats = {};
  for (const u of units) {
    const s = (out[u.variant] ??= { n: 0, accepted: 0, disbursed: 0, defaulted: 0, complaints: 0 });
    s.n += 1;
    if (u.accepted) s.accepted += 1;
    if (u.disbursed) s.disbursed += 1;
    if (u.defaulted) s.defaulted += 1;
    if (u.complained) s.complaints += 1;
    if (u.tat_seconds !== null && u.tat_seconds !== undefined) (tats[u.variant] ??= []).push(Number(u.tat_seconds));
  }
  const q = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
  };
  for (const [v, s] of Object.entries(out)) {
    const a = tats[v] ?? [];
    s.tat_n = a.length;
    s.tat_q1 = a.length ? q(a, 0.25) : null;
    s.tat_median = a.length ? q(a, 0.5) : null;
    s.tat_q3 = a.length ? q(a, 0.75) : null;
  }
  return out;
}
