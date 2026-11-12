// Anomaly detection on daily step conversion.
// Baseline: median of the previous 14 days' conversion. Spread: the larger of the baseline's MAD (scaled) and the
// binomial standard error for today's sample size, so quiet small-volume days do not raise false alarms.
// Flag when z <= -3 AND the drop is at least 3 percentage points (statistically AND practically significant).
import { STEPS, STEP_LABEL } from './data.js';
import { funnelByDay } from './funnel.js';

export const DETECTOR = { window: 14, zThreshold: 3, minDrop: 0.03, minBaselineDays: 7 };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function detectAnomalies(rows, opts = {}) {
  const cfg = { ...DETECTOR, ...opts };
  const days = funnelByDay(rows);
  const anomalies = [];
  const series = {};
  for (const step of STEPS.slice(1)) {
    series[step] = [];
    const prevStep = STEPS[STEPS.indexOf(step) - 1];
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const n = d.counts[prevStep];
      const rate = n > 0 ? d.counts[step] / n : null;
      const hist = days.slice(Math.max(0, i - cfg.window), i).map((x) => x.conversion[step]).filter((x) => x != null);
      let point = { day: d.day, rate, n, baseline: null, z: null, flagged: false };
      if (rate != null && hist.length >= cfg.minBaselineDays) {
        const base = median(hist);
        const mad = median(hist.map((x) => Math.abs(x - base))) * 1.4826;
        const se = Math.sqrt((base * (1 - base)) / n);
        const sigma = Math.max(mad, se, 1e-6);
        const z = (rate - base) / sigma;
        point = { ...point, baseline: base, sigma, z };
        const drop = base - rate;
        if (z <= -cfg.zThreshold && drop >= cfg.minDrop) {
          point.flagged = true;
          anomalies.push({ day: d.day, step, label: STEP_LABEL[step], rate, baseline: base, drop, z, n });
        }
      }
      series[step].push(point);
    }
  }
  anomalies.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.z - b.z));
  return { config: cfg, anomalies, series };
}

// ---------- sustained shifts ----------
// The daily detector looks for one bad day. A lasting step change (a policy tightening, a slower provider) that is only a few points
// deep can sit just under the daily threshold for a week, because each day alone is within noise. This second detector pools a short
// trailing window of days and compares it with the pooled 14 days before the window, which gives it the sample size to see a small
// persistent shift. It is reported separately from the daily flags (and never changes them), and merged into episodes.
export const SHIFT = { windowDays: 4, baselineDays: 14, zThreshold: 3, minDrop: 0.02, minBaselineDays: 7 };

export function detectShifts(rows, opts = {}) {
  const cfg = { ...SHIFT, ...opts };
  const days = funnelByDay(rows);
  const shifts = [];
  for (const step of STEPS.slice(1)) {
    const prevStep = STEPS[STEPS.indexOf(step) - 1];
    let open = null; // the episode we are inside, if any
    for (let i = cfg.windowDays - 1; i < days.length; i++) {
      const win = days.slice(i - cfg.windowDays + 1, i + 1);
      const base = days.slice(Math.max(0, i - cfg.windowDays + 1 - cfg.baselineDays), i - cfg.windowDays + 1);
      const sum = (ds, key) => ds.reduce((a, d) => a + d.counts[key], 0);
      const nW = sum(win, prevStep), nB = sum(base, prevStep);
      let flagged = false;
      if (base.length >= cfg.minBaselineDays && nW > 0 && nB > 0) {
        const pW = sum(win, step) / nW, pB = sum(base, step) / nB;
        const se = Math.sqrt(pB * (1 - pB) * (1 / nW + 1 / nB));
        const z = se > 0 ? (pW - pB) / se : 0;
        const drop = pB - pW;
        flagged = z <= -cfg.zThreshold && drop >= cfg.minDrop;
        if (flagged) {
          if (open) { open.to = days[i].day; open.days += 1; if (z < open.z) { open.z = z; open.rate = pW; open.drop = drop; } }
          else {
            open = { step, label: STEP_LABEL[step], from: win[0].day, to: days[i].day, first_flagged: days[i].day, days: 1, rate: pW, baseline: pB, drop, z, n: nW };
            shifts.push(open);
          }
        }
      }
      if (!flagged) open = null;
    }
  }
  // two episodes of one step that overlap, or are at most a day apart, are one episode seen through a noisy threshold
  const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const merged = [];
  for (const sh of shifts.sort((x, y) => (x.step === y.step ? (x.first_flagged < y.first_flagged ? -1 : 1) : x.step < y.step ? -1 : 1))) {
    const last = merged[merged.length - 1];
    if (last && last.step === sh.step && dayNum(sh.from) <= dayNum(last.to) + 1) {
      last.to = sh.to > last.to ? sh.to : last.to;
      last.days += sh.days;
      if (sh.z < last.z) Object.assign(last, { z: sh.z, rate: sh.rate, drop: sh.drop, baseline: sh.baseline, n: sh.n });
    } else merged.push({ ...sh });
  }
  shifts.length = 0;
  shifts.push(...merged);
  shifts.sort((a, b) => (a.first_flagged < b.first_flagged ? -1 : a.first_flagged > b.first_flagged ? 1 : a.z - b.z));
  return { config: cfg, shifts };
}
