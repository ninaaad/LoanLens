import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, emi, validateRuleset } from '../src/rules/engine.js';
import { RULESET_V1, RULESET_V2 } from '../src/rules/defaultRules.js';
import { buildKfs } from '../src/rules/kfs.js';

const good = { age: 34, monthly_income: 60000, existing_emi: 10000, requested_amount: 300000, tenure_months: 36, credit_score: 760 };

test('emi matches the textbook figure', () => {
  assert.equal(Math.round(emi(300000, 0.12, 36)), 9964);
});

test('default rulesets validate', () => {
  assert.deepEqual(validateRuleset(RULESET_V1.config), []);
  assert.deepEqual(validateRuleset(RULESET_V2.config), []);
});

test('a strong applicant is approved with no reasons', () => {
  const r = evaluate(good, RULESET_V2.config);
  assert.equal(r.decision, 'approve');
  assert.deepEqual(r.reasonCodes, []);
  assert.ok(r.derived.foir < 0.4);
});

test('hard rules reject with reason codes', () => {
  assert.deepEqual(evaluate({ ...good, age: 19 }, RULESET_V2.config).reasonCodes, ['AGE_BELOW_MIN']);
  assert.equal(evaluate({ ...good, monthly_income: 20000 }, RULESET_V2.config, { stage: 'prescreen' }).decision, 'reject');
  const low = evaluate({ ...good, credit_score: 620 }, RULESET_V2.config);
  assert.equal(low.decision, 'reject');
  assert.ok(low.reasonCodes.includes('SCORE_TOO_LOW'));
});

test('a borderline score is referred, not rejected', () => {
  const r = evaluate({ ...good, credit_score: 680 }, RULESET_V2.config);
  assert.equal(r.decision, 'refer');
  assert.deepEqual(r.reasonCodes, ['SCORE_BORDERLINE']);
});

test('missing bureau score refers with BUREAU_UNAVAILABLE', () => {
  const r = evaluate({ ...good, credit_score: null }, RULESET_V2.config);
  assert.equal(r.decision, 'refer');
  assert.ok(r.reasonCodes.includes('BUREAU_UNAVAILABLE'));
});

test('the FOIR change between v1 and v2 flips a borderline applicant', () => {
  // existing EMIs of 18,000 on 60,000 income plus a 9,964 EMI is a FOIR of about 0.47
  const a = { ...good, existing_emi: 18000, credit_score: 720 };
  const v1 = evaluate(a, RULESET_V1.config);
  const v2 = evaluate(a, RULESET_V2.config);
  assert.ok(v1.derived.foir > 0.45 && v1.derived.foir < 0.5, `foir ${v1.derived.foir}`);
  assert.equal(v1.decision, 'refer');
  assert.equal(v2.decision, 'refer');
  const b = { ...good, existing_emi: 21000, credit_score: 720 }; // foir about 0.52
  assert.equal(evaluate(b, RULESET_V1.config).decision, 'refer');
  assert.equal(evaluate(b, RULESET_V2.config).decision, 'reject');
  assert.ok(evaluate(b, RULESET_V2.config).reasonCodes.includes('FOIR_TOO_HIGH'));
});

test('KFS fields are consistent', () => {
  const k = buildKfs({ amount: 300000, annualRate: 0.12, months: 36 });
  assert.equal(k.emi, 9964);
  assert.equal(k.processing_fee, 6000);
  assert.ok(k.apr > 0.12 && k.apr < 0.2, `apr ${k.apr}`);
  assert.equal(k.total_repayment, Math.round(emi(300000, 0.12, 36) * 36));
});
