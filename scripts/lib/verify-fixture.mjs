/**
 * Verify fixtures — structural expectations for a live command run.
 *
 * Every command must have `verify/<command>.json`. It is the only check in the
 * repository that looks at real values coming back from Avito; the offline
 * suites see synthetic carriers and cannot tell a correct decoder from one that
 * reads the wrong field.
 *
 * The fixture never pins content. Listings churn, prices move, sellers come and
 * go, so equality against a recorded row would fail every day for the wrong
 * reason. It pins shape and invariants instead: how many rows are plausible,
 * which keys exist and in which order, what type each carries, which of them
 * must match a format, which must not be empty, which must not contain a
 * substring that would mean one field bled into another.
 *
 * Schema:
 *
 *   {
 *     // Either a raw argv array, passed verbatim (use this for positional
 *     // subjects), or an object of named flags expanded to `--key value`.
 *     "args": ["ddr5 32gb", "--location-id", "637640"],
 *     "expect": {
 *       "rowCount": { "min": 1, "max": 50 },
 *       "columns":  ["itemId", "title"],          // exact set and order
 *       "types":    { "price": "number|null" },   // "|" separates alternatives
 *       "patterns": { "url": "^https://www\\.avito\\.ru/" },
 *       "notEmpty": ["itemId", "title"],
 *       "mustNotContain": { "url": ["?", "context="] },
 *       "mustBeTruthy": ["price"]
 *     }
 *   }
 *
 * `notEmpty` and `mustBeTruthy` apply to every row at once, so a field that is
 * nullable by contract can never appear in either. `sellerName` is the standing
 * example: it is nullable because Avito withholds private-seller identity from
 * an anonymous session, so it cannot be defended here at all.
 *
 * The one rule that matters more than the rest: a failing fixture means the
 * command is wrong, not that the fixture is too strict. Tighten the command.
 * The single legitimate reason to edit a fixture is that Avito itself changed
 * shape, and then the fact belongs in the domain file under docs/areas/, in the
 * same commit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { VERIFY_DIR } from './paths.mjs';

export const EXPECT_KEYS = new Set([
  'rowCount',
  'columns',
  'types',
  'patterns',
  'notEmpty',
  'mustNotContain',
  'mustBeTruthy',
]);

export const KNOWN_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object', 'null', 'undefined', 'any']);

export function fixturePath(command) {
  return path.join(VERIFY_DIR, `${command}.json`);
}

export function listFixtures() {
  if (!fs.existsSync(VERIFY_DIR)) return [];
  return fs
    .readdirSync(VERIFY_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => ({ command: entry.replace(/\.json$/, ''), file: path.join(VERIFY_DIR, entry) }));
}

export function loadFixture(command) {
  const file = fixturePath(command);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeFixture(command, fixture) {
  const file = fixturePath(command);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
  return file;
}

/**
 * Derive a first draft from a sample run. It seeds `rowCount`, `columns` and
 * `types` only — `patterns`, `notEmpty`, `mustNotContain` and `mustBeTruthy`
 * are deliberately left out, because a rule generated from one observation
 * documents that observation rather than the contract. Add them by hand after
 * comparing the values against the visible page.
 */
export function deriveFixture(rows, args) {
  const expect = {};
  if (rows.length === 0) {
    expect.rowCount = { min: 0 };
    return { ...(args ? { args } : {}), expect };
  }
  expect.rowCount = { min: 1 };
  expect.columns = Object.keys(rows[0]);
  const types = {};
  for (const column of expect.columns) {
    const observed = new Set(rows.map((row) => jsType(row[column])));
    types[column] = [...observed].sort().join('|');
  }
  expect.types = types;
  return { ...(args ? { args } : {}), expect };
}

/** Check a fixture file against its own schema, before any command runs. */
export function validateFixtureSchema(fixture, { declaredColumns } = {}) {
  const problems = [];
  if (fixture == null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return ['fixture must be a JSON object'];
  }
  for (const key of Object.keys(fixture)) {
    if (key !== 'args' && key !== 'expect') problems.push(`unknown top-level key "${key}"`);
  }
  if ('args' in fixture && !Array.isArray(fixture.args) && !isRecord(fixture.args)) {
    problems.push('args must be an argv array or an object of named flags');
  }

  const expect = fixture.expect;
  if (!isRecord(expect)) return [...problems, 'expect must be an object'];

  for (const key of Object.keys(expect)) {
    if (!EXPECT_KEYS.has(key)) problems.push(`unknown expect key "${key}"`);
  }

  if ('rowCount' in expect) {
    const { min, max, ...rest } = expect.rowCount ?? {};
    for (const key of Object.keys(rest)) problems.push(`unknown rowCount key "${key}"`);
    if (min !== undefined && !Number.isInteger(min)) problems.push('rowCount.min must be an integer');
    if (max !== undefined && !Number.isInteger(max)) problems.push('rowCount.max must be an integer');
    if (Number.isInteger(min) && Number.isInteger(max) && min > max) problems.push('rowCount.min is above rowCount.max');
  }

  const columns = Array.isArray(expect.columns) ? expect.columns : null;
  if (!columns || columns.length === 0) {
    problems.push('expect.columns is required — it is what pins the row shape and its order');
  } else if (new Set(columns).size !== columns.length) {
    problems.push('expect.columns has duplicates');
  }

  if (columns && declaredColumns) {
    if (columns.length !== declaredColumns.length || columns.some((column, index) => column !== declaredColumns[index])) {
      problems.push(`expect.columns does not match the command descriptor: fixture [${columns.join(', ')}] vs descriptor [${declaredColumns.join(', ')}]`);
    }
  }

  const known = new Set(columns ?? []);
  const referenced = (label, names) => {
    for (const name of names) {
      if (known.size > 0 && !known.has(name)) problems.push(`${label} names "${name}", which is not in expect.columns`);
    }
  };

  if ('types' in expect) {
    if (!isRecord(expect.types)) problems.push('expect.types must be an object');
    else {
      referenced('types', Object.keys(expect.types));
      for (const [column, declared] of Object.entries(expect.types)) {
        if (typeof declared !== 'string' || declared.trim() === '') {
          problems.push(`types["${column}"] must be a non-empty string`);
          continue;
        }
        for (const alternative of declared.split('|').map((part) => part.trim())) {
          if (!KNOWN_TYPES.has(alternative)) problems.push(`types["${column}"] names unknown type "${alternative}"`);
        }
      }
    }
  }

  if ('patterns' in expect) {
    if (!isRecord(expect.patterns)) problems.push('expect.patterns must be an object');
    else {
      referenced('patterns', Object.keys(expect.patterns));
      for (const [column, source] of Object.entries(expect.patterns)) {
        try {
          new RegExp(String(source));
        } catch (error) {
          problems.push(`patterns["${column}"] does not compile: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  for (const key of ['notEmpty', 'mustBeTruthy']) {
    if (!(key in expect)) continue;
    if (!Array.isArray(expect[key])) problems.push(`expect.${key} must be an array`);
    else referenced(key, expect[key]);
  }

  if ('mustNotContain' in expect) {
    if (!isRecord(expect.mustNotContain)) problems.push('expect.mustNotContain must be an object');
    else {
      referenced('mustNotContain', Object.keys(expect.mustNotContain));
      for (const [column, needles] of Object.entries(expect.mustNotContain)) {
        if (!Array.isArray(needles) || needles.some((needle) => typeof needle !== 'string')) {
          problems.push(`mustNotContain["${column}"] must be an array of strings`);
        }
      }
    }
  }

  return problems;
}

/** Apply every rule in the fixture to the rows a live run returned. */
export function validateRows(rows, fixture) {
  const failures = [];
  const expect = fixture?.expect;
  if (!expect) return failures;

  if (expect.rowCount) {
    const { min, max } = expect.rowCount;
    if (typeof min === 'number' && rows.length < min) {
      failures.push({ rule: 'rowCount', detail: `got ${rows.length} rows, expected at least ${min}` });
    }
    if (typeof max === 'number' && rows.length > max) {
      failures.push({ rule: 'rowCount', detail: `got ${rows.length} rows, expected at most ${max}` });
    }
  }

  const columns = expect.columns ?? [];
  const types = expect.types ?? {};
  const notEmpty = expect.notEmpty ?? [];
  const compiledPatterns = {};
  for (const [column, source] of Object.entries(expect.patterns ?? {})) {
    try {
      compiledPatterns[column] = new RegExp(String(source));
    } catch (error) {
      failures.push({ rule: 'pattern', detail: `pattern for "${column}" is invalid: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  rows.forEach((row, index) => {
    const actualColumns = Object.keys(row);
    for (const column of columns) {
      if (!(column in row)) failures.push({ rule: 'column', detail: `missing column "${column}"`, rowIndex: index });
    }
    for (const column of actualColumns) {
      if (columns.length > 0 && !columns.includes(column)) {
        failures.push({ rule: 'column', detail: `undeclared column "${column}"`, rowIndex: index });
      }
    }

    for (const [column, declared] of Object.entries(types)) {
      if (!(column in row)) continue;
      const actual = jsType(row[column]);
      if (!typeMatches(actual, declared)) {
        failures.push({ rule: 'type', detail: `"${column}" is ${actual}, expected ${declared}`, rowIndex: index });
      }
    }

    for (const [column, pattern] of Object.entries(compiledPatterns)) {
      if (!(column in row)) continue;
      const value = row[column];
      if (value === null || value === undefined) continue;
      if (!pattern.test(String(value))) {
        failures.push({
          rule: 'pattern',
          detail: `"${column}"=${JSON.stringify(String(value).slice(0, 60))} does not match /${pattern.source}/`,
          rowIndex: index,
        });
      }
    }

    for (const column of notEmpty) {
      const value = row[column];
      if (value === null || value === undefined || String(value).trim() === '') {
        failures.push({ rule: 'notEmpty', detail: `"${column}" is empty`, rowIndex: index });
      }
    }

    for (const [column, needles] of Object.entries(expect.mustNotContain ?? {})) {
      if (!(column in row)) continue;
      const value = row[column];
      if (value === null || value === undefined) continue;
      const haystack = String(value);
      for (const needle of needles) {
        if (haystack.includes(needle)) {
          failures.push({
            rule: 'mustNotContain',
            detail: `"${column}" contains forbidden substring ${JSON.stringify(needle)}`,
            rowIndex: index,
          });
        }
      }
    }

    for (const column of expect.mustBeTruthy ?? []) {
      if (!(column in row)) continue;
      if (!row[column]) {
        failures.push({
          rule: 'mustBeTruthy',
          detail: `"${column}" is falsy (${JSON.stringify(row[column])}) — likely a silent fallback`,
          rowIndex: index,
        });
      }
    }
  });

  return failures;
}

/** Row shape ceiling, independent of any fixture. */
export function validateRowShape(rows, { maxTopLevelKeys = 12, maxNestedDepth = 1 } = {}) {
  const failures = [];
  rows.forEach((row, index) => {
    const keys = Object.keys(row);
    if (keys.length > maxTopLevelKeys) {
      failures.push({
        rule: 'shapeKeyCount',
        detail: `row has ${keys.length} top-level keys, ceiling is ${maxTopLevelKeys}`,
        rowIndex: index,
      });
    }
    for (const [key, value] of Object.entries(row)) {
      const depth = nestedDepth(value);
      if (depth > maxNestedDepth) {
        failures.push({
          rule: 'shapeDepth',
          detail: `"${key}" nests ${depth} deep, ceiling is ${maxNestedDepth}`,
          rowIndex: index,
        });
      }
    }
  });
  return failures;
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

function jsType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(actual, declared) {
  const allowed = declared.split('|').map((part) => part.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  if (allowed.includes('any')) return true;
  return allowed.includes(actual);
}

function nestedDepth(value) {
  if (value === null || value === undefined || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    if (value.length === 0) return 1;
    return 1 + Math.max(...value.map(nestedDepth));
  }
  const values = Object.values(value);
  if (values.length === 0) return 1;
  return 1 + Math.max(...values.map(nestedDepth));
}
