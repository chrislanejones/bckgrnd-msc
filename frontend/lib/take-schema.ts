/**
 * The JSON Schema subset validator for contracts/performance.json: type, const, enum,
 * required, properties, additionalProperties, minimum, maximum, maxItems, items, oneOf,
 * $ref. Pure, and the one copy: the app's `openTake` uses it, and the tools load it
 * through tools/performance-schema.mjs, so a take file is held to the same contract in
 * the browser and in the checks.
 */

import performanceSchema from '../../contracts/performance.json';

type Node = {
  $ref?: string;
  oneOf?: Node[];
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: Node;
  required?: string[];
  properties?: Record<string, Node>;
  additionalProperties?: boolean;
};

function typeOk(t: string, v: unknown): boolean {
  if (t === 'null') return v === null;
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}

/** A function from a document to its list of errors (empty: it validates). */
export function schemaValidator(schema: object): (doc: unknown) => string[] {
  const root = schema as Record<string, unknown>;
  const resolveRef = (ref: string): Node =>
    ref.replace(/^#\//, '').split('/').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as Node;
  function validate(node: Node, v: unknown, path = '$'): string[] {
    if (node.$ref) return validate(resolveRef(node.$ref), v, path);
    const errors: string[] = [];
    if (node.oneOf) {
      const passing = node.oneOf.filter((n) => validate(n, v, path).length === 0).length;
      if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`);
      return errors;
    }
    if ('const' in node && v !== node.const) errors.push(`${path}: not ${JSON.stringify(node.const)}`);
    if (node.enum && !node.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in enum`);
    if (node.type && !([] as string[]).concat(node.type).some((t) => typeOk(t, v))) errors.push(`${path}: not ${String(node.type)}`);
    if (typeof v === 'number') {
      if (node.minimum !== undefined && v < node.minimum) errors.push(`${path}: below ${node.minimum}`);
      if (node.maximum !== undefined && v > node.maximum) errors.push(`${path}: above ${node.maximum}`);
    }
    if (Array.isArray(v)) {
      if (node.maxItems !== undefined && v.length > node.maxItems) errors.push(`${path}: over ${node.maxItems} items`);
      if (node.items) v.forEach((x, i) => errors.push(...validate(node.items!, x, `${path}[${i}]`)));
    }
    if (typeOk('object', v)) {
      const o = v as Record<string, unknown>;
      for (const k of node.required ?? []) if (!(k in o)) errors.push(`${path}: missing ${k}`);
      for (const [k, x] of Object.entries(o)) {
        if (node.properties?.[k]) errors.push(...validate(node.properties[k], x, `${path}.${k}`));
        else if (node.additionalProperties === false) errors.push(`${path}: unexpected ${k}`);
      }
    }
    return errors;
  }
  return (doc) => validate(root as Node, doc);
}

/** contracts/performance.json, as bundled. */
export const PERFORMANCE_SCHEMA: object = performanceSchema;

/** Validate a take against contracts/performance.json: the list of errors, empty when it validates. */
export const validateTake: (doc: unknown) => string[] = schemaValidator(performanceSchema);
