/**
 * The output contract as a value, and the one way an Avito payload becomes data.
 *
 * A command answers with one object. Its schema is a `strictObject` at every
 * level: an undeclared key is a failure rather than a value that reaches a
 * caller nobody told about it. `assertOutputSchema` checks the schema itself, so
 * a violation fails at import rather than on an answer.
 *
 * `decode` is the other half: Avito's responses are validated with the same
 * schemas, and a failure becomes a typed error. Response-shape drift ends the
 * call; it never becomes a partial answer.
 */

import { z } from 'zod';

import { CommandExecutionError } from './errors.mjs';

export { z };

/** How many issues are named before the message is truncated. */
const MAX_REPORTED_ISSUES = 3;

// ── the shared field vocabulary ──────────────────────────────────────────────

/** A string that carries something. An empty one is missing data wearing a type. */
export const text = () => z.string().min(1, 'must not be empty');

/**
 * A scalar and not `unknown`: `String(value)` of an object is `[object Object]`,
 * which is non-empty and so passes every emptiness check below.
 */
const SCALAR_INPUT = z.union(
  [z.string(), z.number(), z.boolean(), z.null(), z.undefined()],
  { error: 'expected text, received a structure' },
);

/** Avito's own text, as it arrives: whitespace collapsed, ends trimmed. */
export const cleanedText = () => SCALAR_INPUT.transform(
  (value) => String(value ?? '').replace(/\s+/g, ' ').trim(),
);

/** Avito text a value cannot be missing from. */
export const requiredText = () => cleanedText().pipe(text());

/** Avito text that is either something or nothing. An absent field reads as `null`. */
export const optionalText = () => cleanedText()
  .transform((value) => value || null)
  .default(null);

/** An Avito identifier as this CLI hands it over: digits, kept as a string. */
export const idString = () => z.string()
  .regex(/^\d+$/, 'must be an Avito ID of digits only');

/** Any absolute https URL — the host is checked by whoever owns that vocabulary. */
export const httpsUrl = () => z.string()
  .regex(/^https:\/\/[^\s]+$/, 'must be an absolute https URL');

/** A canonical listing URL: no query, no fragment, ending in the item ID. */
export const itemUrl = () => z.string().regex(
  /^https:\/\/www\.avito\.ru\/[^?#]+_\d+$/,
  'must be a canonical https://www.avito.ru listing URL with no query',
);

/** Any Avito search or catalog URL, query and all. */
export const searchUrl = () => z.string().regex(
  /^https:\/\/www\.avito\.ru\/[^\s]*$/,
  'must be an https://www.avito.ru search URL',
);

/** A count Avito reports. Zero is a real answer; a negative one is drift. */
export const count = () => z.number().int().nonnegative();

// ── decoding what Avito answered ─────────────────────────────────────────────

/**
 * Parse an Avito payload, or end the call with a typed error naming the path
 * that drifted. `subject` is what the caller was reading, phrased so the message
 * reads as one sentence: `decode(POINT, payload, 'Avito coords response')`.
 */
export function decode(schema, value, subject) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new CommandExecutionError(`${subject} has an unexpected shape — ${formatIssues(result.error)}`);
}

/**
 * The same parse, for the answer this CLI is about to hand over. An answer that
 * fails its own declared contract is drift on our side of the boundary and stops
 * the call.
 */
export function parseOutput(schema, value, commandName) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new CommandExecutionError(
    `avito ${commandName} produced an answer that breaks its own contract — ${formatIssues(result.error)}`,
  );
}

/** `point.latitude expected number, received string; kind is too small` */
export function formatIssues(error) {
  const issues = error.issues ?? [];
  const named = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = (issue.path ?? []).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const hidden = issues.length - named.length;
  return hidden > 0 ? `${named.join('; ')} (and ${hidden} more)` : named.join('; ');
}

// ── what an output schema is allowed to be ───────────────────────────────────

/**
 * Total declared fields, counted once each wherever they sit. It replaces the
 * flat key ceiling: nesting is allowed, and burying thirty fields one level down
 * is still thirty fields the caller has to read (D-074).
 */
export const MAX_OUTPUT_LEAVES = 40;

/** Envelope, the things in it, the things in those. Deeper is a tree (D-074). */
export const MAX_OUTPUT_DEPTH = 3;

/** The keys the answer itself carries. */
export function outputKeys(schema) {
  return Object.keys(schema.shape);
}

/** Every key name declared anywhere in the schema, at any depth. */
export function declaredKeyNames(schema) {
  const names = new Set();
  walk(schema, 1, {
    onKey: (name) => names.add(name),
    onLeaf: () => {},
    fail: () => {},
  });
  return names;
}

/**
 * Check an output schema at definition time: an object, strict at every level,
 * camelCase throughout, within the field and depth ceilings.
 */
export function assertOutputSchema(name, schema, { maxLeaves, maxDepth }) {
  const fail = (message) => {
    throw new Error(`Invalid command descriptor — ${name}: ${message}`);
  };

  if (schema?.def?.type !== 'object') {
    fail('output must be a z.strictObject({...}) schema — a command answers with one object');
  }

  let leaves = 0;
  walk(schema, 1, {
    onKey: (key, path) => {
      if (!/^[a-z][A-Za-z0-9]*$/.test(key)) {
        fail(`"${path}" is not camelCase — the key names are the agent-facing API`);
      }
    },
    onLeaf: () => { leaves += 1; },
    fail,
  }, { maxDepth });

  if (leaves === 0) fail('output declares no fields');
  if (leaves > maxLeaves) fail(`output declares ${leaves} fields, ceiling is ${maxLeaves}`);
}

/**
 * One traversal over a declared shape. `depth` counts object nesting, so the
 * envelope is 1 and the element of a list hanging off it is 2.
 */
function walk(schema, depth, visitor, { maxDepth = Infinity } = {}, path = '') {
  const def = schema?.def;
  if (!def) return;

  if (def.type === 'nullable' || def.type === 'optional' || def.type === 'default') {
    walk(def.innerType, depth, visitor, { maxDepth }, path);
    return;
  }
  if (def.type === 'array') {
    walk(def.element, depth, visitor, { maxDepth }, `${path}[]`);
    return;
  }
  if (def.type === 'record') {
    walk(def.valueType, depth, visitor, { maxDepth }, `${path}{}`);
    return;
  }
  if (def.type === 'union') {
    for (const option of def.options ?? []) walk(option, depth, visitor, { maxDepth }, path);
    return;
  }
  if (def.type === 'object') {
    if (depth > maxDepth) {
      visitor.fail(`"${path}" nests ${depth} objects deep, ceiling is ${maxDepth}`);
    }
    if (def.catchall?.def?.type !== 'never') {
      visitor.fail(`"${path || 'output'}" must be a z.strictObject, not z.object — an undeclared key has to fail, not pass through`);
    }
    for (const [key, value] of Object.entries(schema.shape ?? {})) {
      const keyPath = path ? `${path}.${key}` : key;
      visitor.onKey(key, keyPath);
      walk(value, depth + 1, visitor, { maxDepth }, keyPath);
    }
    return;
  }
  visitor.onLeaf(path);
}
