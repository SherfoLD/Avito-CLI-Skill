/**
 * Verify fixtures — what one live run of one command has to come back with.
 *
 * The row contract is the command's own `row` schema. A fixture holds the half
 * a schema cannot: what *this particular request* must answer. `avito get-coords
 * "Тверь, Советская улица, 11"` returns a house in Тверь with a postal code, and
 * only somebody who compared it against the visible page could know that.
 *
 * A fixture is a module exporting two things:
 *
 *   export const args = ['Тверь, Советская улица, 11'];
 *   export const rows = z.array(z.looseObject({
 *     kind: z.literal('house'),
 *     locality: z.literal('Тверь'),
 *     postalCode: z.string().regex(/^\d{6}$/),
 *   })).length(1);
 *
 * `args` is either a raw argv array — use this for a positional subject — or an
 * object of named flags expanded to `--key value`.
 *
 * `rows` is a schema over the whole returned array, which is what lets a fixture
 * state something about the set rather than about each row alone: a count, a
 * uniqueness rule, "exactly one of these is the current category". The element is
 * a `looseObject` because the row already satisfied the command's contract —
 * naming a column here adds a constraint, it does not re-declare the row.
 *
 * A column that is nullable by contract can only be required here when this
 * request is known to fill it. `sellerName` is the standing example: it is
 * nullable because Avito withholds private-seller identity from an anonymous
 * session, so it cannot be defended by any fixture at all.
 *
 * The one rule that matters more than the rest: a failing fixture means the
 * command is wrong, not that the fixture is too strict. Tighten the command.
 * The single legitimate reason to edit a fixture is that Avito itself changed
 * shape, and then the fact belongs in the domain file under docs/areas/, in the
 * same commit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { VERIFY_DIR } from './paths.mjs';

export function fixturePath(command) {
  return path.join(VERIFY_DIR, `${command}.mjs`);
}

export function listFixtures() {
  if (!fs.existsSync(VERIFY_DIR)) return [];
  return fs
    .readdirSync(VERIFY_DIR)
    .filter((entry) => entry.endsWith('.mjs'))
    .sort()
    .map((entry) => ({ command: entry.replace(/\.mjs$/, ''), file: path.join(VERIFY_DIR, entry) }));
}

export async function loadFixture(command) {
  const file = fixturePath(command);
  if (!fs.existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Failed to load ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Check a fixture against the command it belongs to, before anything runs. A
 * rule naming a column that does not exist is a rule that would never fire, and
 * a fixture that constrains nothing is a file that would never fail.
 */
export function validateFixture(fixture, { declaredColumns } = {}) {
  const rows = fixture?.rows;
  if (rows?.def?.type !== 'array') {
    return ['must export `rows`, a z.array(...) schema over the whole returned array'];
  }
  if ('args' in fixture && !Array.isArray(fixture.args) && !isRecord(fixture.args)) {
    return ['args must be an argv array or an object of named flags'];
  }

  const problems = [];
  const named = Object.keys(rows.def.element?.shape ?? {});
  for (const column of named) {
    if (declaredColumns && !declaredColumns.includes(column)) {
      problems.push(`names "${column}", which the command does not return`);
    }
  }
  if (named.length === 0 && !constrainsTheSet(rows)) {
    problems.push('constrains nothing about this request — the row schema already covers the shape');
  }
  return problems;
}

/**
 * A count that names one number, or a rule over the whole array. A plausible
 * range is not one: "between 1 and 50 rows of the declared shape" is true of
 * every page this command could return.
 */
function constrainsTheSet(rows) {
  return checkNames(rows).some((name) => name === 'custom' || name === 'length_equals');
}

function checkNames(schema) {
  return (schema.def.checks ?? []).map((check) => check._zod?.def?.check ?? '');
}

/** Apply the fixture to the rows a live run returned. */
export function validateRows(rows, fixture) {
  const result = fixture.rows.safeParse(rows);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    rule: issue.code,
    detail: issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  }));
}

/** Turn fixture args into argv tokens appended after the command name. */
export function expandFixtureArgs(args) {
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
