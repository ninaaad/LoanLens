import { describe, it, expect } from 'vitest';
import { parseRoute, routeHref, pct, pts, inr, hours, istDay, shortDay, fillDays, buildCandidate } from '../src/lib.js';

describe('routing', () => {
  it('parses page, tab and query', () => {
    expect(parseRoute('#/workbench/rca?day=2026-10-13&step=offer_viewed')).toEqual({ page: 'workbench', tab: 'rca', params: { day: '2026-10-13', step: 'offer_viewed' } });
    expect(parseRoute('')).toEqual({ page: 'journey', tab: null, params: {} });
    expect(parseRoute('#/journey').page).toBe('journey');
  });
  it('builds hrefs that parse back', () => {
    const h = routeHref('workbench', 'rca', { day: '2026-10-13', step: 'offer_viewed' });
    expect(parseRoute(h).params.day).toBe('2026-10-13');
    expect(routeHref('journey')).toBe('#/journey');
  });
});

describe('formatting', () => {
  it('formats percentages, points and rupees, and tolerates missing values', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(pct(null)).toBe('n/a');
    expect(pts(-0.0213, 1)).toBe('-2.1 pts');
    expect(pts(0.02)).toBe('+2.00 pts');
    expect(inr(300000)).toBe('₹3,00,000');
    expect(inr(undefined)).toBe('n/a');
  });
  it('buckets timestamps into IST days like the server', () => {
    expect(istDay('2026-10-13T20:00:00Z')).toBe('2026-10-14'); // 01:30 IST next day
    expect(istDay('2026-10-13T05:00:00Z')).toBe('2026-10-13');
    expect(shortDay('2026-10-06')).toBe('6 Oct');
  });
});

describe('buildCandidate', () => {
  const cfg = { maxLoanIncomeMultiple: 15, rules: [{ id: 'foir_hard', value: 0.5 }, { id: 'score_hard', value: 650 }] };
  it('sends only the fields that changed', () => {
    const c = buildCandidate('v2', cfg, { rules: { foir_hard: '0.45', score_hard: '650' }, maxLoanIncomeMultiple: '15' });
    expect(c).toEqual({ base: 'v2', overrides: { rules: { foir_hard: { value: 0.45 } } } });
  });
  it('sends an empty override set when nothing changed', () => {
    expect(buildCandidate('v2', cfg, { rules: { foir_hard: '0.5' }, maxLoanIncomeMultiple: 15 }).overrides).toEqual({});
  });
  it('includes the loan multiple when changed, and rejects non-numbers', () => {
    expect(buildCandidate('v2', cfg, { rules: {}, maxLoanIncomeMultiple: '12' }).overrides.maxLoanIncomeMultiple).toBe(12);
    expect(() => buildCandidate('v2', cfg, { rules: { foir_hard: 'abc' }, maxLoanIncomeMultiple: 15 })).toThrow(/foir_hard/);
    expect(() => buildCandidate('v2', cfg, { rules: {}, maxLoanIncomeMultiple: 0 })).toThrow(/positive/);
  });
});

describe('durations', () => {
  it('uses the unit that keeps the number readable', () => {
    expect(hours(null)).toBe('n/a');
    expect(hours(45)).toBe('45 s');
    expect(hours(357)).toBe('6.0 min');
    expect(hours(3600)).toBe('60.0 min');
    expect(hours(7200)).toBe('2.0 h');
    expect(hours(6 * 3600)).toBe('6.0 h');
  });
});

describe('fillDays', () => {
  it('adds an empty entry for each missing calendar day, leaves real days alone and handles short lists', () => {
    const real = (day) => ({ day, counts: { application_started: 5 }, conversion: { kyc_completed: 0.8 } });
    const out = fillDays([real('2026-10-18'), real('2026-10-19'), real('2026-10-22')]);
    expect(out.map((d) => d.day)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
    expect(out.filter((d) => d.gap).map((d) => d.day)).toEqual(['2026-10-20', '2026-10-21']);
    expect(out[0].counts.application_started).toBe(5);
    expect(out[2].conversion.kyc_completed).toBeUndefined();
    expect(fillDays([])).toEqual([]);
    expect(fillDays([real('2026-10-18')]).length).toBe(1);
    // month and year boundaries
    expect(fillDays([real('2026-12-30'), real('2027-01-02')]).map((d) => d.day)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });
});
