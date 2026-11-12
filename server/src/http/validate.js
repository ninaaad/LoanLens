// Small input-validation helpers shared by the routes. Every failure is an HttpError(400, message) so clients get one JSON shape.
import { HttpError } from '../journey/service.js';
import { validateRuleset } from '../rules/engine.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INT4_MAX = 2147483647;

/** A positive integer path parameter (database ids are int4). Anything else is a 404: that id cannot exist. */
export function parseId(value, what = 'application') {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) throw new HttpError(404, `${what} not found`);
  const n = Number(value);
  if (n < 1 || n > INT4_MAX) throw new HttpError(404, `${what} not found`);
  return n;
}

/** YYYY-MM-DD that is a real calendar date. Returns undefined when absent and `required` is false. */
export function parseDay(value, name, { required = false } = {}) {
  if (value === undefined || value === '') {
    if (required) throw new HttpError(400, `${name} (YYYY-MM-DD) is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !DAY.test(value)) throw new HttpError(400, `${name} must be a date in YYYY-MM-DD format`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${name} is not a valid calendar date`);
  return value;
}

/** A short plain string, or `fallback` when the field is absent. */
export function shortString(value, name, { fallback, max = 40 } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new HttpError(400, `${name} must be a non-empty text of at most ${max} characters`);
  }
  return value.trim();
}

/** An integer within [min, max], or undefined when absent. */
export function optionalInt(value, name, min, max) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** The request body must be a JSON object (not an array, string or null). */
export function bodyObject(body, { allowEmpty = true } = {}) {
  if (body === undefined || body === null) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'a JSON object body is required');
  }
  if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'the body must be a JSON object');
  return body;
}

/** One value from a query string; repeated parameters (arrays) are rejected rather than coerced. */
export function queryValue(value, name, { max = 100 } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be given once, as text`);
  if (value.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return value;
}

/**
 * All the reasons a ruleset config is unusable. `validateRuleset` checks structure; this adds the checks it does not make
 * (rule values, field names, pricing entries), because the engine would silently misbehave on them.
 */
export function rulesetErrors(cfg) {
  const errors = validateRuleset(cfg);
  if (errors.length && (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.rules) || !Array.isArray(cfg.pricing))) return errors;
  for (const r of cfg.rules ?? []) {
    if (typeof r.field !== 'string' || !r.field) errors.push(`rule ${r.id}: field must be text`);
    const v = r.value;
    const okValue = r.op === 'in' ? Array.isArray(v) : typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' || typeof v === 'boolean';
    if (!okValue) errors.push(`rule ${r.id}: needs a finite value`);
  }
  for (const p of cfg.pricing ?? []) {
    if (!Number.isFinite(p?.minScore) || !Number.isFinite(p?.rate) || p.rate < 0) errors.push('pricing entries need numeric minScore and rate');
  }
  if (!(cfg.maxLoanIncomeMultiple > 0)) errors.push('maxLoanIncomeMultiple must be positive');
  return [...new Set(errors)];
}

/** A timestamp (ISO text) or the fallback when absent. */
export function timestampOr(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new HttpError(400, `${name} must be a date-time such as 2026-11-01T00:00:00Z`);
  return new Date(value);
}

/** Journey input: types and lengths checked here; the numeric ranges are checked in createApplication. */
export function applicationInput(body) {
  const b = bodyObject(body);
  if (b.new_to_credit !== undefined && typeof b.new_to_credit !== 'boolean') throw new HttpError(400, 'new_to_credit must be true or false');
  return {
    ...b,
    channel: shortString(b.channel, 'channel', { fallback: 'direct' }),
    device: shortString(b.device, 'device', { fallback: 'web' }),
    app_version: shortString(b.app_version, 'app_version', { fallback: 'web' }),
    employment: shortString(b.employment, 'employment', { fallback: 'salaried' }),
    variant: b.variant === undefined || b.variant === null ? null : shortString(b.variant, 'variant'),
  };
}
