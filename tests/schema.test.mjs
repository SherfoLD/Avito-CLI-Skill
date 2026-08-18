// Offline checks for the row contract itself.
//
// Every other suite leans on this machinery, so a schema layer that silently
// accepted everything would make all of them pass while checking nothing. It is
// exercised here directly, including the failures it is supposed to produce.
import { loadCommand, runner } from './harness.mjs';
import { defineCommand } from '../src/runtime/command.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import {
  count,
  decode,
  httpsUrl,
  idString,
  itemUrl,
  optionalText,
  parseRows,
  rank,
  requiredText,
  rowTypeScript,
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
  run: async () => [],
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

check('a row schema must be strict, so an undeclared key cannot pass through', () => {
  refusesDescriptor({ row: z.object({ itemId: idString() }) }, /must be a z\.strictObject/);
  refusesDescriptor({ row: z.array(z.string()) }, /must be a z\.strictObject/);
  refusesDescriptor({ row: z.strictObject({}) }, /declares no columns/);
});

check('a column holds whatever its schema declares, tables and trees alike', () => {
  const accepted = defineCommand({
    ...base,
    row: z.strictObject({
      title: text(),
      price: z.number().nullable(),
      images: z.array(z.string()),
      attributes: z.record(text(), text()),
      role: z.enum(['a', 'b']),
      priceList: z.array(z.strictObject({ title: text(), price: text() })).nullable(),
      // Nesting past a table is the schema author's call, not the runtime's.
      groups: z.array(z.strictObject({ values: z.array(z.strictObject({ title: text() })) })),
      rows: z.array(z.array(z.string())),
      seller: z.object({ name: text() }),
      nested: z.record(text(), z.strictObject({ title: text() })),
    }),
  });
  assert(accepted.columns.length === 10, 'a row of ten columns must be accepted');
});

check('a flat record is a column of its own, and it prints as one', () => {
  const command = defineCommand({
    ...base,
    row: z.strictObject({
      itemId: idString(),
      priceList: z.array(z.strictObject({ title: text(), price: text() })).nullable(),
    }),
  });
  const printed = rowTypeScript(command.row);
  assert(
    printed.includes('priceList: { title: string; price: string }[] | null;'),
    `the table column must print its record, got:\n${printed}`,
  );
});

check('the column ceiling and the naming rule are checked against the schema', () => {
  const seventeen = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`column${index}`, text()]),
  );
  refusesDescriptor({ row: z.strictObject(seventeen) }, /declares 17 columns, ceiling is 16/);
  refusesDescriptor({ row: z.strictObject({ item_id: idString() }) }, /column "item_id" is not camelCase/);
  refusesDescriptor({ row: z.strictObject({ ItemId: idString() }) }, /column "ItemId" is not camelCase/);
});

check('columns are derived from the schema and cannot be declared beside it', () => {
  const command = defineCommand({
    ...base,
    row: z.strictObject({ itemId: idString(), title: text(), price: count().nullable() }),
  });
  assert(
    command.columns.join(',') === 'itemId,title,price',
    `columns must follow the schema declaration order, got ${command.columns.join(',')}`,
  );
  refusesDescriptor(
    { row: z.strictObject({ itemId: idString() }), columns: ['itemId'] },
    /columns are derived from row/,
  );
});

check('a row that breaks its own contract ends the call with a typed error', () => {
  const row = z.strictObject({ itemId: idString(), url: itemUrl(), price: count().nullable() });
  const good = { itemId: '8030214066', url: 'https://www.avito.ru/moskva/divan_8030214066', price: null };

  assert(parseRows(row, [good], 'example').length === 1, 'a valid row must pass');

  const cases = [
    [{ ...good, extra: 1 }, /Unrecognized key/],
    [{ ...good, itemId: 'not-an-id' }, /itemId/],
    // The listing URL keeps no query: a search URL bleeding into it is exactly
    // the confusion the pattern exists to catch.
    [{ ...good, url: `${good.url}?context=abc` }, /url/],
    [{ ...good, price: -1 }, /price/],
    [{ itemId: good.itemId, url: good.url }, /price/],
  ];
  for (const [broken, pattern] of cases) {
    let failure = null;
    try {
      parseRows(row, [broken], 'example');
    } catch (error) {
      failure = error;
    }
    assert(failure != null, `accepted a broken row: ${JSON.stringify(broken)}`);
    assert(failure.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${failure.code}`);
    assert(pattern.test(failure.message), `unexpected message: ${failure.message}`);
    assert(/row 0/.test(failure.message), `the failing row must be named: ${failure.message}`);
  }
});

check('a key present with an undefined value is missing, not empty', () => {
  // JSON.stringify drops the key and the table prints a blank cell, so an
  // undefined column reaches the caller as neither present nor null.
  const row = z.strictObject({ published: z.string().nullable() });
  let failure = null;
  try {
    parseRows(row, [{ published: undefined }], 'example');
  } catch (error) {
    failure = error;
  }
  assert(failure != null && /published/.test(failure.message), 'an undefined column must fail');
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

check('the printed type says what a list of column names cannot', () => {
  const printed = rowTypeScript(z.strictObject({
    itemId: idString(),
    price: z.number().nonnegative().nullable(),
    sellerRating: z.number().min(0).max(5).nullable(),
    reviewsCount: count(),
    position: rank(),
    role: z.enum(['option', 'current']),
    images: z.array(httpsUrl()),
    attributes: z.record(text(), text()),
    url: itemUrl(),
  }));

  const expected = [
    'itemId: string;',                            // the format only the vocabulary knows
    'price: number | null;',                      // nullable, and not optional
    'sellerRating: number | null;',
    'reviewsCount: number;',
    'position: number;',
    'role: "option" | "current";',
    'images: string[];',
    'attributes: Record<string, string>;',
    'url: string;',
  ];
  for (const member of expected) {
    assert(printed.includes(member), `${member} is not in the printed type:\n${printed}`);
  }

  const notes = ['// digits only', '// 0..5', '// integer, >= 0', '// integer, > 0', '// listing URL, no query'];
  for (const note of notes) {
    assert(printed.includes(note), `${note} is not in the printed type:\n${printed}`);
  }
  assert(printed.startsWith('type Row = {') && printed.endsWith('};'), `the block is not a declaration:\n${printed}`);
});

check('every command prints a type, and no column of one arrives as unknown', async () => {
  for (const entry of await loadManifest()) {
    const { COMMAND } = await loadCommand(entry.name);
    const printed = rowTypeScript(COMMAND.row);
    // A column reaching `unknown` means the printer and the flatness rule stopped
    // agreeing on what a column may be, which is invisible in a passing `--help`.
    assert(!/unknown/.test(printed), `${entry.name} prints an undescribed column:\n${printed}`);
    assert(
      printed.split('\n').length === COMMAND.columns.length + 2,
      `${entry.name} prints ${printed.split('\n').length - 2} members for ${COMMAND.columns.length} columns`,
    );
    for (const column of COMMAND.columns) {
      assert(printed.includes(`  ${column}: `), `${entry.name} does not print ${column}`);
    }
  }
});

export default await run('schema — the row contract and how Avito payloads become data');
