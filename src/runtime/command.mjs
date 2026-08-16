/**
 * A descriptor is the whole contract of a command: what `--help` prints, what
 * the check scripts read, what a verify fixture pins. Every command module
 * default-exports one.
 *
 *   export default defineCommand({
 *     name: 'search',
 *     description: '…',            // one sentence, what the caller gets
 *     access: 'read',              // 'read' | 'write' — read-only for now
 *     domain: 'www.avito.ru',
 *     example: 'avito search <query> --location-id 650400 -f json',
 *     args: [
 *       { name: 'query', type: 'string', required: true, positional: true, help: '…' },
 *     ],
 *     columns: ['itemId', '…'],    // ordered; the order is pinned by verify/<name>.json
 *     run: async (ctx, args) => [ …rows… ],
 *   })
 *
 * `run` returns an array of flat row objects. It never returns a partial row and
 * never returns `[]` to mean "something went wrong" — that is what the typed
 * errors in `errors.mjs` are for.
 */

const ARG_TYPES = new Set(['string', 'int', 'bool']);

export const MAX_ROW_KEYS = 12;
export const MAX_ROW_DEPTH = 1;

export function defineCommand(descriptor) {
  assert(isRecord(descriptor), 'command descriptor must be an object');

  const { name, description, access, domain, example, args, columns, run } = descriptor;

  assert(typeof name === 'string' && name.trim() !== '', 'command needs a name');
  assert(typeof description === 'string' && description.trim() !== '', `${name}: needs a description`);
  assert(access === 'read' || access === 'write', `${name}: access must be 'read' or 'write'`);
  assert(typeof domain === 'string' && domain.trim() !== '', `${name}: needs a domain`);
  assert(typeof run === 'function', `${name}: needs a run function`);
  assert(Array.isArray(columns) && columns.length > 0, `${name}: needs a non-empty columns list`);
  assert(columns.length <= MAX_ROW_KEYS, `${name}: declares ${columns.length} columns, ceiling is ${MAX_ROW_KEYS}`);
  assert(new Set(columns).size === columns.length, `${name}: duplicate column names`);

  const declaredArgs = Array.isArray(args) ? args : [];
  const seen = new Set();
  let seenNamed = false;
  for (const arg of declaredArgs) {
    assert(isRecord(arg), `${name}: every arg must be an object`);
    assert(typeof arg.name === 'string' && arg.name.trim() !== '', `${name}: every arg needs a name`);
    assert(!seen.has(arg.name), `${name}: duplicate arg "${arg.name}"`);
    seen.add(arg.name);
    assert(ARG_TYPES.has(arg.type), `${name}: arg "${arg.name}" has unknown type ${JSON.stringify(arg.type)}`);
    assert(typeof arg.help === 'string' && arg.help.trim() !== '', `${name}: arg "${arg.name}" needs help text — it is the only thing a caller reads`);
    if (arg.positional) {
      assert(!seenNamed, `${name}: positional arg "${arg.name}" appears after a named one`);
    } else {
      seenNamed = true;
    }
  }

  return Object.freeze({
    site: 'avito',
    name,
    description,
    access,
    domain,
    example: example ?? null,
    args: Object.freeze(declaredArgs.map((arg) => Object.freeze({ ...arg }))),
    columns: Object.freeze([...columns]),
    run,
  });
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid command descriptor — ${message}`);
}
