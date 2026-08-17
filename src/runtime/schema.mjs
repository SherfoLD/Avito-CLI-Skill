/**
 * The row contract as a value, and the one way an Avito payload becomes data.
 *
 * A row schema is a `strictObject`: an undeclared key is a failure, not a value
 * that survives in `-f json` and vanishes in `-f table`. It is also flat — a
 * column is a scalar, or an array or record of scalars, and nothing deeper.
 * `assertRowSchema` checks both against the declaration, so a violation fails at
 * import rather than on a row.
 *
 * `decode` is the other half: Avito's responses are validated with the same
 * schemas, and a failure becomes a typed error. Response-shape drift ends the
 * call; it never becomes a partial row.
 *
 * `rowTypeScript` is the same declaration turned outward: `--help` prints the
 * schema, so the caller reads the contract that is enforced rather than a
 * paraphrase of it kept somewhere else.
 */

import { z } from 'zod';

import { CommandExecutionError } from './errors.mjs';

export { z };

/** How many issues are named before the message is truncated. */
const MAX_REPORTED_ISSUES = 3;

const SCALAR_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'enum',
  'literal',
  'null',
  'date',
]);

// ── the shared column vocabulary ─────────────────────────────────────────────

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

/**
 * An Avito identifier as this CLI hands it over: digits, kept as a string.
 *
 * The `note` is what `--help` prints beside the column. A regex check exposes
 * only its pattern object, so a format states itself here or nowhere.
 */
export const idString = () => z.string()
  .regex(/^\d+$/, 'must be an Avito ID of digits only')
  .meta({ note: 'digits only' });

/** Any absolute https URL — the host is checked by whoever owns that vocabulary. */
export const httpsUrl = () => z.string()
  .regex(/^https:\/\/[^\s]+$/, 'must be an absolute https URL')
  .meta({ note: 'absolute https URL' });

/** A canonical listing URL: no query, no fragment, ending in the item ID. */
export const itemUrl = () => z.string().regex(
  /^https:\/\/www\.avito\.ru\/[^?#]+_\d+$/,
  'must be a canonical https://www.avito.ru listing URL with no query',
).meta({ note: 'listing URL, no query' });

/** Any Avito search or catalog URL, query and all. */
export const searchUrl = () => z.string().regex(
  /^https:\/\/www\.avito\.ru\/[^\s]*$/,
  'must be an https://www.avito.ru search URL',
).meta({ note: 'search URL, query and all' });

/** A 1-based position in the returned page. */
export const rank = () => z.number().int().positive();

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
 * The same parse, for a row this CLI is about to hand over. A row that fails its
 * own declared contract is drift on our side of the boundary and stops the call.
 */
export function parseRows(schema, rows, commandName) {
  if (!Array.isArray(rows)) {
    throw new CommandExecutionError(`avito ${commandName} returned something other than an array of rows`);
  }
  return rows.map((row, index) => {
    const result = schema.safeParse(row);
    if (result.success) return result.data;
    throw new CommandExecutionError(
      `avito ${commandName} produced a row that breaks its own contract at row ${index} — ${formatIssues(result.error)}`,
    );
  });
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

// ── what a row schema is allowed to be ───────────────────────────────────────

/** The declared columns, in the order the schema declares them. */
export function rowColumns(schema) {
  return Object.keys(schema.shape);
}

/**
 * Check a row schema at definition time: strict, non-empty, within the key
 * ceiling, and flat.
 */
export function assertRowSchema(name, schema, { maxKeys }) {
  const fail = (message) => {
    throw new Error(`Invalid command descriptor — ${name}: ${message}`);
  };

  if (schema?.def?.type !== 'object') {
    fail('row must be a z.strictObject({...}) schema');
  }
  if (schema.def.catchall?.def?.type !== 'never') {
    fail('row must be a z.strictObject, not z.object — an undeclared key has to fail, not pass through');
  }

  const columns = rowColumns(schema);
  if (columns.length === 0) fail('row declares no columns');
  if (columns.length > maxKeys) fail(`row declares ${columns.length} columns, ceiling is ${maxKeys}`);

  for (const column of columns) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(column)) {
      fail(`column "${column}" is not camelCase — row keys are the agent-facing API`);
    }
    const depth = columnDepth(schema.shape[column]);
    if (depth > 1) {
      fail(`column "${column}" nests deeper than one level; a row is flat by contract`);
    }
    if (depth < 0) {
      fail(`column "${column}" has a type this contract cannot describe as a column`);
    }
  }
}

/**
 * 0 for a scalar, 1 for an array or record of scalars, 2+ for anything deeper,
 * -1 for a shape that is not a column at all. Wrappers do not count — a nullable
 * string is as flat as a string.
 */
function columnDepth(schema) {
  const def = schema?.def;
  if (!def) return -1;
  if (def.type === 'nullable' || def.type === 'optional' || def.type === 'default') {
    return columnDepth(def.innerType);
  }
  if (def.type === 'union') {
    const depths = (def.options ?? []).map(columnDepth);
    return depths.length === 0 ? -1 : Math.max(...depths);
  }
  if (SCALAR_TYPES.has(def.type)) return 0;
  if (def.type === 'array') return nest(columnDepth(def.element));
  if (def.type === 'record') return nest(columnDepth(def.valueType));
  return -1;
}

/** A container of something undescribable is undescribable, not one level deep. */
function nest(inner) {
  return inner < 0 ? -1 : inner + 1;
}

// ── the row as the consumer reads it ─────────────────────────────────────────

/**
 * The row schema as a TypeScript declaration, which `--help` prints in place of
 * a list of column names: it is the one notation a consuming agent reads without
 * being taught it, and it carries what a list cannot — that a column may be
 * `null`, that another is a list, and that the answer as a whole is an array.
 */
export function rowTypeScript(schema, typeName = 'Row') {
  const members = rowColumns(schema).map((column) => {
    const { type, note } = describeColumn(schema.shape[column]);
    return { declaration: `  ${column}: ${type};`, note };
  });
  const width = Math.max(...members.map((member) => member.declaration.length));
  return [
    `type ${typeName} = {`,
    ...members.map(({ declaration, note }) => (
      note ? `${declaration.padEnd(width)}  // ${note}` : declaration
    )),
    '};',
  ].join('\n');
}

/** A column this printer has no notation for. The offline suite refuses one. */
function undescribed() {
  return { type: 'unknown', note: null };
}

/**
 * The grammar here is the one `columnDepth` walks: a type accepted there is a
 * type printed here, and a column that comes back undescribed is one the two
 * have drifted apart on.
 */
function describeColumn(schema) {
  const def = schema?.def;
  if (!def) return undescribed();
  if (def.type === 'nullable') {
    const inner = describeColumn(def.innerType);
    return { type: `${inner.type} | null`, note: inner.note };
  }
  if (def.type === 'optional' || def.type === 'default') return describeColumn(def.innerType);
  if (def.type === 'union') {
    const parts = (def.options ?? []).map(describeColumn);
    if (parts.length === 0) return undescribed();
    return {
      type: parts.map((part) => part.type).join(' | '),
      note: parts.find((part) => part.note)?.note ?? null,
    };
  }
  if (def.type === 'array') {
    const inner = describeColumn(def.element);
    return { type: `${inner.type}[]`, note: inner.note };
  }
  if (def.type === 'record') {
    const inner = describeColumn(def.valueType);
    return { type: `Record<string, ${inner.type}>`, note: inner.note };
  }
  if (def.type === 'literal' || def.type === 'enum') {
    const values = def.type === 'literal' ? def.values ?? [] : Object.values(def.entries ?? {});
    if (values.length === 0) return undescribed();
    return { type: values.map((value) => JSON.stringify(value)).join(' | '), note: null };
  }
  const note = schema.meta?.()?.note ?? (def.type === 'number' ? numberNote(def) : null);
  // A date reaches the caller through `JSON.stringify`, which is where it stops
  // being one.
  if (def.type === 'date') return { type: 'string', note: note ?? 'ISO 8601' };
  if (SCALAR_TYPES.has(def.type)) return { type: def.type, note };
  return undescribed();
}

/** `integer, 0..5` — the bounds a numeric column declares, in the order they read. */
function numberNote(def) {
  let minimum = null;
  let maximum = null;
  let integer = false;
  for (const check of def.checks ?? []) {
    const rule = check._zod?.def ?? check.def ?? {};
    if (rule.check === 'number_format') integer = true;
    if (rule.check === 'greater_than') minimum = rule;
    if (rule.check === 'less_than') maximum = rule;
  }

  const parts = integer ? ['integer'] : [];
  if (minimum && maximum && minimum.inclusive && maximum.inclusive) {
    parts.push(`${minimum.value}..${maximum.value}`);
  } else {
    if (minimum) parts.push(`${minimum.inclusive ? '>=' : '>'} ${minimum.value}`);
    if (maximum) parts.push(`${maximum.inclusive ? '<=' : '<'} ${maximum.value}`);
  }
  return parts.join(', ') || null;
}
