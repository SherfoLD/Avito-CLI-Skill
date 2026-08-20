/**
 * A descriptor is the whole contract of a command: what `--help` prints, what
 * the check scripts read, what an expectation pins. Every command module
 * default-exports one.
 *
 *   export default defineCommand({
 *     name: 'search',
 *     description: '…',            // one sentence, what the caller gets
 *     access: 'read',              // 'read' | 'write' — read-only for now
 *     domain: 'www.avito.ru',
 *     browserTab: 'ephemeral',      // or 'new-search' / 'search-url'
 *     example: 'avito search <query> --location-id 650400',
 *     args: [
 *       { name: 'query', type: 'string', required: true, positional: true, help: '…' },
 *     ],
 *     output: z.strictObject({     // the whole answer, one object
 *       query: text(),
 *       items: z.array(ITEM),
 *     }),
 *     type: OUTPUT_TYPE,           // the same contract as TypeScript, for --help
 *     run: async (ctx, args) => ({ …the answer… }),
 *   })
 *
 * `run` returns one object, and the CLI parses it through `output` before
 * printing. It never returns a partial answer and never returns an empty one to
 * mean "something went wrong" — that is what the typed errors in `errors.mjs`
 * are for.
 *
 * `type` is written by hand and kept in step by `npm run check:commands`, which
 * refuses a name in one that is missing from the other. It carries what the
 * schema cannot: what a field means, what its `null` says, which unit it is in.
 */

import {
  MAX_OUTPUT_DEPTH,
  MAX_OUTPUT_LEAVES,
  assertOutputSchema,
  outputKeys,
} from './schema.mjs';

const ARG_TYPES = new Set(['string', 'int', 'bool']);
const BROWSER_TABS = new Set(['ephemeral', 'new-search', 'search-url']);

export { MAX_OUTPUT_DEPTH, MAX_OUTPUT_LEAVES };

export function defineCommand(descriptor) {
  assert(isRecord(descriptor), 'command descriptor must be an object');

  const {
    name, description, access, domain, example, args, output, type, run,
    browserTab = 'ephemeral',
  } = descriptor;

  assert(typeof name === 'string' && name.trim() !== '', 'command needs a name');
  assert(typeof description === 'string' && description.trim() !== '', `${name}: needs a description`);
  assert(access === 'read' || access === 'write', `${name}: access must be 'read' or 'write'`);
  assert(typeof domain === 'string' && domain.trim() !== '', `${name}: needs a domain`);
  assert(typeof run === 'function', `${name}: needs a run function`);
  assert(BROWSER_TABS.has(browserTab), `${name}: browserTab must be ephemeral, new-search or search-url`);
  assert(descriptor.row === undefined, `${name}: the contract is 'output', a schema over the whole answer`);
  assert(descriptor.columns === undefined, `${name}: there are no columns — declare the answer in 'output'`);

  assertOutputSchema(name, output, { maxLeaves: MAX_OUTPUT_LEAVES, maxDepth: MAX_OUTPUT_DEPTH });

  assert(typeof type === 'string' && type.trim() !== '', `${name}: needs a 'type' — the output as TypeScript, which is what --help prints`);
  assert(/(^|\n)\s*type Output = \{/.test(type), `${name}: 'type' must declare "type Output = {" — that is the name a caller reads first`);

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
  assert(browserTab !== 'search-url' || seen.has('searchUrl'), `${name}: browserTab search-url needs a searchUrl argument`);
  const keys = Object.freeze(outputKeys(output));
  assert(browserTab === 'ephemeral' || keys.includes('searchUrl'), `${name}: a persistent browserTab needs searchUrl in its output`);

  return Object.freeze({
    site: 'avito',
    name,
    description,
    access,
    domain,
    browserTab,
    example: example ?? null,
    args: Object.freeze(declaredArgs.map((arg) => Object.freeze({ ...arg }))),
    output,
    type: type.trim(),
    keys,
    run,
  });
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid command descriptor — ${message}`);
}
