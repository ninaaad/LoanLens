// Deterministic experiment assignment: hash(unit id + experiment key) mod 100 against the variant weights.
// The same input always gives the same variant, and different experiments split users independently.
import { createHash } from 'node:crypto';

export function bucket(unitId, key) {
  const h = createHash('sha256').update(`${unitId}|${key}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** variants: [{ name, weight }] with integer weights summing to 100, in a fixed order. */
export function assign(unitId, key, variants) {
  const b = bucket(unitId, key);
  let edge = 0;
  for (const v of variants) {
    edge += v.weight;
    if (b < edge) return v.name;
  }
  return variants.at(-1).name;
}

export function validateVariants(variants) {
  const errors = [];
  if (!Array.isArray(variants) || variants.length !== 2) return ['variants must be exactly two entries: control first, then the treatment'];
  const names = new Set();
  for (const v of variants) {
    if (!v || typeof v.name !== 'string' || !v.name.trim()) errors.push('every variant needs a name');
    else if (names.has(v.name)) errors.push(`duplicate variant name ${v.name}`);
    else names.add(v.name);
    if (!Number.isInteger(v?.weight) || v.weight < 1 || v.weight > 99) errors.push(`variant ${v?.name}: weight must be an integer from 1 to 99`);
  }
  if (!errors.length && variants.reduce((a, v) => a + v.weight, 0) !== 100) errors.push('variant weights must sum to 100');
  return errors;
}
