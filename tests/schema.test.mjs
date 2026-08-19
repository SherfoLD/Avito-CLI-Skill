// Offline checks for the output contract itself.
//
// Every other suite leans on this machinery, so a schema layer that silently
// accepted everything would make all of them pass while checking nothing. It is
// exercised here directly, including the failures it is supposed to produce.
import { runner } from './harness.mjs';
import { defineCommand } from '../src/runtime/command.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import {
  count,
  decode,
  declaredKeyNames,
  idString,
  itemUrl,
  optionalText,
  parseOutput,
  requiredText,
  text,
  z,
} from '../src/runtime/schema.mjs';

const { check, assert, run } = runner();

const base = {
  name: 'example',
  description: 'An example command',
  access: 'read',
  domain: 'www.avito.ru',
  args: [],
  type: 'type Output = {\n  itemId: string;\n};',
  run: async () => ({}),
};

function refusesDescriptor(descriptor, pattern) {
  let failure = null;
  try {
    defineCommand({ ...base, ...descriptor });
  } catch (error) {
    failure = error;
  }
  assert(failure != null, `the descriptor was accepted: ${JSON.stringify(Object.keys(descriptor))}`);
  assert(pattern.test(failure.message), `unexpected message: ${failure.message}`);
}

check('the answer is one object, strict at every level', () => {
  refusesDescriptor({ output: z.object({ itemId: idString() }) }, /must be a z\.strictObject/);
  refusesDescriptor({ output: z.array(z.strictObject({ itemId: idString() })) }, /must be a z\.strictObject/);
  refusesDescriptor({ output: z.strictObject({}) }, /declares no fields/);
  // A loose object one level down is the whole reason the check recurses: it
  // would pass every gate and hand a caller keys nobody declared.
  refusesDescriptor(
    { output: z.strictObject({ items: z.array(z.object({ itemId: idString() })) }) },
    /"items\[\]" must be a z\.strictObject/,
  );
});

check('a field holds whatever its schema declares, tables and trees alike', () => {
  const accepted = defineCommand({
    ...base,
    type: 'type Output = {\n  title: string;\n  price: number;\n  images: string[];\n'
      + '  attributes: Record<string, string>;\n  role: string;\n  priceList: Entry[];\n'
      + '  seller: Seller;\n};\ntype Entry = { title: string; price: string };\n'
      + 'type Seller = { name: string };',
    output: z.strictObject({
      title: text(),
      price: z.number().nullable(),
      images: z.array(z.string()),
      attributes: z.record(text(), text()),
      role: z.enum(['a', 'b']),
      priceList: z.array(z.strictObject({ title: text(), price: text() })).nullable(),
      seller: z.strictObject({ name: text() }),
    }),
  });
  assert(accepted.keys.length === 7, `seven fields must be accepted, got ${accepted.keys.length}`);
});

check('the field ceiling counts leaves wherever they sit, and depth stops a tree', () => {
  // Twenty-one envelope fields each holding two is forty-two leaves: burying
  // them one level down is still forty-two fields the caller has to read.
  const deep = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
    `group${index}`,
    z.array(z.strictObject({ title: text(), value: text() })),
  ]));
  refusesDescriptor({ output: z.strictObject(deep) }, /declares 42 fields, ceiling is 40/);

  refusesDescriptor(
    {
      output: z.strictObject({
        items: z.array(z.strictObject({
          seller: z.strictObject({ badges: z.array(z.strictObject({ title: text() })) }),
        })),
      }),
    },
    /nests 4 objects deep, ceiling is 3/,
  );
});

check('the key names are camelCase, at every depth', () => {
  refusesDescriptor({ output: z.strictObject({ item_id: idString() }) }, /"item_id" is not camelCase/);
  refusesDescriptor({ output: z.strictObject({ ItemId: idString() }) }, /"ItemId" is not camelCase/);
  refusesDescriptor(
    { output: z.strictObject({ items: z.array(z.strictObject({ item_id: idString() })) }) },
    /"items\[\]\.item_id" is not camelCase/,
  );
});

check('the answer keys are derived from the schema, and rows are refused outright', () => {
  const command = defineCommand({
    ...base,
    type: 'type Output = {\n  query: string;\n  items: Item[];\n};\ntype Item = { itemId: string };',
    output: z.strictObject({ query: text(), items: z.array(z.strictObject({ itemId: idString() })) }),
  });
  assert(command.keys.join(',') === 'query,items', `keys must follow the declaration order, got ${command.keys.join(',')}`);
  refusesDescriptor({ row: z.strictObject({ itemId: idString() }) }, /the contract is 'output'/);
  refusesDescriptor({ output: z.strictObject({ itemId: idString() }), columns: ['itemId'] }, /there are no columns/);
});

check('a command declares the type --help prints, and it names Output', () => {
  refusesDescriptor({ output: z.strictObject({ itemId: idString() }), type: undefined }, /needs a 'type'/);
  refusesDescriptor(
    { output: z.strictObject({ itemId: idString() }), type: 'interface Output { itemId: string }' },
    /must declare "type Output = \{"/,
  );
});

check('declaredKeyNames reaches every name the answer can carry', () => {
  const names = declaredKeyNames(z.strictObject({
    query: text(),
    items: z.array(z.strictObject({
      itemId: idString(),
      priceList: z.array(z.strictObject({ title: text() })),
    })),
    lookup: z.record(text(), z.strictObject({ label: text() })),
  }));
  for (const name of ['query', 'items', 'itemId', 'priceList', 'title', 'lookup', 'label']) {
    assert(names.has(name), `${name} is missing from ${[...names].join(', ')}`);
  }
});

check('an answer that breaks its own contract ends the call with a typed error', () => {
  const output = z.strictObject({
    searchUrl: z.string(),
    items: z.array(z.strictObject({ itemId: idString(), url: itemUrl(), price: count().nullable() })),
  });
  const item = { itemId: '8030214066', url: 'https://www.avito.ru/moskva/divan_8030214066', price: null };
  const good = { searchUrl: 'https://www.avito.ru/moskva', items: [item] };

  assert(parseOutput(output, good, 'example').items.length === 1, 'a valid answer must pass');

  const cases = [
    [{ ...good, extra: 1 }, /Unrecognized key/],
    [{ ...good, items: [{ ...item, extra: 1 }] }, /Unrecognized key/],
    [{ ...good, items: [{ ...item, itemId: 'not-an-id' }] }, /items\.0\.itemId/],
    // The listing URL keeps no query: a search URL bleeding into it is exactly
    // the confusion the pattern exists to catch.
    [{ ...good, items: [{ ...item, url: `${item.url}?context=abc` }] }, /items\.0\.url/],
    [{ ...good, items: [{ ...item, price: -1 }] }, /items\.0\.price/],
    [{ ...good, items: [{ itemId: item.itemId, url: item.url }] }, /items\.0\.price/],
    [[good], /expected object/i],
  ];
  for (const [broken, pattern] of cases) {
    let failure = null;
    try {
      parseOutput(output, broken, 'example');
    } catch (error) {
      failure = error;
    }
    assert(failure != null, `accepted a broken answer: ${JSON.stringify(broken)}`);
    assert(failure.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${failure.code}`);
    assert(pattern.test(failure.message), `unexpected message: ${failure.message}`);
    assert(/breaks its own contract/.test(failure.message), `the failure must say so: ${failure.message}`);
  }
});

check('a key present with an undefined value is missing, not empty', () => {
  // JSON.stringify drops the key, so an undefined field reaches the caller as
  // neither present nor null.
  const output = z.strictObject({ published: z.string().nullable() });
  let failure = null;
  try {
    parseOutput(output, { published: undefined }, 'example');
  } catch (error) {
    failure = error;
  }
  assert(failure != null && /published/.test(failure.message), 'an undefined field must fail');
});

check('decode turns Avito drift into a typed error naming the path', () => {
  const payload = z.object({ point: z.object({ latitude: z.number().min(-90).max(90) }) });

  assert(decode(payload, { point: { latitude: 55.7 } }, 'Avito response').point.latitude === 55.7,
    'a valid payload must decode');

  let failure = null;
  try {
    decode(payload, { point: { latitude: '55.7' } }, 'Avito coords response');
  } catch (error) {
    failure = error;
  }
  assert(failure != null && failure.code === 'COMMAND_EXEC', 'drift must be a typed error');
  assert(/Avito coords response has an unexpected shape/.test(failure.message),
    `the subject must be named: ${failure.message}`);
  assert(/point\.latitude/.test(failure.message), `the path must be named: ${failure.message}`);
});

check('Avito text is normalized, and a structure is never stringified into one', () => {
  const schema = z.object({ name: requiredText(), note: optionalText() });

  assert(schema.parse({ name: '  Тверь,   11 ', note: '' }).name === 'Тверь, 11', 'whitespace must collapse');
  assert(schema.parse({ name: 'x', note: '   ' }).note === null, 'blank text must read as nothing');
  assert(schema.parse({ name: 'x' }).note === null, 'an absent field must read as nothing');
  assert(schema.safeParse({ name: '  ' }).success === false, 'blank text must not satisfy a required field');
  // `String(value ?? '')` of an object is "[object Object]" — non-empty, and so
  // past every emptiness check downstream.
  assert(schema.safeParse({ name: {} }).success === false, 'a structure must not become text');
});

check('every command prints the contract it enforces', async () => {
  for (const entry of await loadManifest()) {
    for (const name of declaredKeyNames(entry.output)) {
      assert(
        new RegExp(`^[ \\t]*${name}\\??:`, 'm').test(entry.type),
        `avito ${entry.name} declares ${name} and does not print it`,
      );
    }
  }
});

export default await run('schema — the output contract and how Avito payloads become data');
