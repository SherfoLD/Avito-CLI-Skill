/**
 * Expectations — what one live run of one command has to come back with.
 *
 * The shape contract is the command's own `output` schema. An expectation holds
 * the half a schema cannot: what *this particular request* must answer. `avito
 * get-coords "Тверь, Советская улица, 11"` returns a house in Тверь with a
 * postal code, and only somebody who compared it against the visible page could
 * know that.
 *
 * An expectation is a module exporting two things:
 *
 *   export const args = ['Тверь, Советская улица, 11'];
 *   export const output = z.looseObject({
 *     kind: z.literal('house'),
 *     locality: z.literal('Тверь'),
 *     postalCode: z.string().regex(/^\d{6}$/),
 *   });
 *
 * `args` is either a raw argv array — use this for a positional subject — or an
 * object of named flags expanded to `--key value`.
 *
 * `output` is a schema over the whole answer, which is what lets it state
 * something about a list rather than about each element alone: a count, a
 * uniqueness rule, "exactly one of these is the current category". Every object
 * in it is a `looseObject` because the answer already satisfied the command's
 * contract — naming a field here adds a constraint, it does not re-declare it.
 *
 * A field that is nullable by contract can only be required here when this
 * request is known to fill it. `sellerName` is the standing example: it is
 * nullable because Avito withholds private-seller identity from an anonymous
 * session, so it cannot be defended by any expectation at all.
 *
 * The one rule that matters more than the rest: a failing expectation means the
 * command is wrong, not that the expectation is too strict. Tighten the command.
 * The single legitimate reason to edit one is that Avito itself changed shape,
 * and then the fact belongs in the domain file under docs/areas/, in the same
 * commit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXPECTATIONS_DIR } from './paths.mjs';

export function expectationPath(command) {
  return path.join(EXPECTATIONS_DIR, `${command}.mjs`);
}

export function listExpectations() {
  if (!fs.existsSync(EXPECTATIONS_DIR)) return [];
  return fs
    .readdirSync(EXPECTATIONS_DIR)
    .filter((entry) => entry.endsWith('.mjs'))
    .sort()
    .map((entry) => ({ command: entry.replace(/\.mjs$/, ''), file: path.join(EXPECTATIONS_DIR, entry) }));
}

export async function loadExpectation(command) {
  const file = expectationPath(command);
  if (!fs.existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Failed to load ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Check an expectation against the command it belongs to, before anything runs.
 * A rule naming a field that does not exist is a rule that would never fire, and
 * one that constrains nothing is a file that would never fail.
 */
export function validateExpectation(expectation, { outputSchema } = {}) {
  const output = expectation?.output;
  if (output?.def?.type !== 'object') {
    return ['must export `output`, a z.looseObject(...) schema over the whole answer'];
  }
  if ('args' in expectation && !Array.isArray(expectation.args) && !isRecord(expectation.args)) {
    return ['args must be an argv array or an object of named flags'];
  }

  const problems = [];
  const claims = [];
  collectClaims(output, outputSchema ?? null, '', claims, problems);

  if (claims.length === 0 && !ruleOverTheWhole(output)) {
    problems.push('constrains nothing about this request — the output schema already covers the shape');
  }
  return problems;
}

/**
 * Walk the expectation beside the command's own schema, so a name that exists
 * nowhere in the answer is reported with the path it was written at.
 *
 * Naming a container is not a claim. `items: z.array(z.looseObject({}))` says
 * only that the answer has an `items` — which its own schema already guarantees —
 * so a container counts through the rule it carries or the fields inside it, and
 * through nothing else.
 */
function collectClaims(expected, declared, prefix, claims, problems) {
  for (const [key, value] of Object.entries(expected.shape ?? {})) {
    const at = prefix ? `${prefix}.${key}` : key;
    const counterpart = declared ? unwrap(declared).shape?.[key] : undefined;
    if (declared && counterpart === undefined) {
      problems.push(`names "${at}", which the command does not return`);
      continue;
    }
    if (ruleOverTheWhole(value)) claims.push(at);

    const inner = unwrap(value);
    if (inner?.def?.type === 'object') {
      collectClaims(inner, counterpart ? unwrap(counterpart) : null, at, claims, problems);
    } else {
      claims.push(at);
    }
  }
}

/** Past nullable, optional, default and array, to the object or scalar inside. */
function unwrap(schema) {
  const def = schema?.def;
  if (!def) return schema;
  if (def.type === 'nullable' || def.type === 'optional' || def.type === 'default') return unwrap(def.innerType);
  if (def.type === 'array') return unwrap(def.element);
  return schema;
}

/**
 * A rule about a whole value rather than about what is inside it: a `.refine` or
 * an exact `.length`. A plausible range is neither — "between 1 and 50 items of
 * the declared shape" is true of every page a command could return.
 */
const WHOLE_VALUE_CHECKS = new Set(['custom', 'length_equals']);

function ruleOverTheWhole(schema) {
  return (schema?.def?.checks ?? [])
    .some((check) => WHOLE_VALUE_CHECKS.has(check._zod?.def?.check ?? ''));
}

/** Apply the expectation to what a live run returned. */
export function validateOutput(value, expectation) {
  const result = expectation.output.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    rule: issue.code,
    detail: issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  }));
}

/** Turn expectation args into argv tokens appended after the command name. */
export function expandArgs(args) {
  if (!args) return [];
  if (Array.isArray(args)) return args.map((value) => String(value));
  const out = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === true) out.push(`--${key}`);
    else out.push(`--${key}`, String(value));
  }
  return out;
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
