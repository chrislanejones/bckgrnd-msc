/**
 * A JSON Schema subset validator: what contracts/performance.json uses (type, const,
 * enum, required, properties, additionalProperties, minimum, maximum, maxItems, items,
 * oneOf, $ref). Shared by tools/check-recording.mjs and tools/verify-ui-recording.mjs,
 * so a take from the browser is held to the same contract as the synthetic ones.
 *
 *   const valid = performanceValidator(schema); valid(doc) // [] when it validates
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** contracts/performance.json, parsed. */
export function performanceSchema() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return JSON.parse(readFileSync(join(root, 'contracts/performance.json'), 'utf8'));
}

/** A function from a document to its list of errors (empty: it validates). */
export function performanceValidator(schema = performanceSchema()) {
  function resolveRef(ref) {
    return ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], schema);
  }
  function typeOk(t, v) {
    if (t === 'null') return v === null;
    if (t === 'integer') return Number.isInteger(v);
    if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (t === 'array') return Array.isArray(v);
    if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
    return typeof v === t;
  }
  function validate(node, v, path = '$') {
    if (node.$ref) return validate(resolveRef(node.$ref), v, path);
    const errors = [];
    if (node.oneOf) {
      const passing = node.oneOf.filter((n) => validate(n, v, path).length === 0).length;
      if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`);
      return errors;
    }
    if ('const' in node && v !== node.const) errors.push(`${path}: not ${JSON.stringify(node.const)}`);
    if (node.enum && !node.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in enum`);
    if (node.type && ![].concat(node.type).some((t) => typeOk(t, v))) errors.push(`${path}: not ${node.type}`);
    if (typeof v === 'number') {
      if (node.minimum !== undefined && v < node.minimum) errors.push(`${path}: below ${node.minimum}`);
      if (node.maximum !== undefined && v > node.maximum) errors.push(`${path}: above ${node.maximum}`);
    }
    if (Array.isArray(v)) {
      if (node.maxItems !== undefined && v.length > node.maxItems) errors.push(`${path}: over ${node.maxItems} items`);
      if (node.items) v.forEach((x, i) => errors.push(...validate(node.items, x, `${path}[${i}]`)));
    }
    if (typeOk('object', v)) {
      for (const k of node.required ?? []) if (!(k in v)) errors.push(`${path}: missing ${k}`);
      for (const [k, x] of Object.entries(v)) {
        if (node.properties?.[k]) errors.push(...validate(node.properties[k], x, `${path}.${k}`));
        else if (node.additionalProperties === false) errors.push(`${path}: unexpected ${k}`);
      }
    }
    return errors;
  }
  return (doc) => validate(schema, doc);
}
