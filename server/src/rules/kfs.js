import { emi } from './engine.js';

/**
 * Monthly IRR on the net amount received, annualised as monthly rate x 12.
 * This is an illustrative APR method for the demo, not a statement of RBI's prescribed formula.
 */
export function aprFrom({ amount, fee, emiValue, months }) {
  const net = amount - fee;
  let lo = 0;
  let hi = 1;
  const pv = (r) => {
    let s = 0;
    for (let k = 1; k <= months; k++) s += emiValue / Math.pow(1 + r, k);
    return s;
  };
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > net) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 12;
}

/**
 * Key Fact Statement fields shown with the offer, before the borrower accepts.
 * processingFeePct and coolingOffDays are lender policy values (the Directions only fix a one-day minimum
 * for the cooling-off period); they are configurable demo values here.
 */
export function buildKfs({ amount, annualRate, months, processingFeePct = 0.02, coolingOffDays = 3 }) {
  const fee = Math.max(999, Math.round(amount * processingFeePct));
  const emiValue = emi(amount, annualRate, months);
  const total = emiValue * months;
  return {
    loan_amount: Math.round(amount),
    tenure_months: months,
    interest_rate_pa: annualRate,
    emi: Math.round(emiValue),
    processing_fee: fee,
    net_disbursed: Math.round(amount - fee),
    total_interest: Math.round(total - amount),
    total_repayment: Math.round(total),
    apr: Number(aprFrom({ amount, fee, emiValue, months }).toFixed(4)),
    cooling_off_days: coolingOffDays,
    grievance_officer: 'Demo Grievance Officer (placeholder, not a real contact)',
    note: 'Demo values on synthetic data. Not a real lender or a real KFS.',
  };
}
