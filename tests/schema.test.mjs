// Offline checks for the row contract itself.
//
// Every other suite leans on this machinery, so a schema layer that silently
// accepted everything would make all of them pass while checking nothing. It is
// exercised here directly, including the failures it is supposed to produce.
import { runner } from './harness.mjs';
import { defineCommand } from '../src/runtime/command.mjs';
import {
  count,
  decode,
  idString,
  itemUrl,
  optionalText,
  parseRows,
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

check('a row is flat: a column is a scalar, or a list or map of scalars', () => {
  const accepted = defineCommand({
    ...base,
    row: z.strictObject({
      title: text(),
      price: z.number().nullable(),
      images: z.array(z.string()),
      attributes: z.record(text(), text()),
      role: z.enum(['a', 'b']),
    }),
  });
  assert(accepted.columns.length === 5, 'a flat row of five columns must be accepted');

  refusesDescriptor(
    { row: z.strictObject({ seller: z.object({ name: text() }) }) },
    /column "seller" has a type this contract cannot describe/,
  );
  refusesDescriptor(
    { row: z.strictObject({ rows: z.array(z.array(z.string())) }) },
    /column "rows" nests deeper than one level/,
  );
  refusesDescriptor(
    { row: z.strictObject({ sellers: z.array(z.object({ name: text() })) }) },
    /column "sellers" has a type this contract cannot describe/,
  );
});

check('the column ceiling and the naming rule are checked against the schema', () => {
  const thirteen = Object.fromEntries(
    Array.from({ length: 13 }, (_, index) => [`column${index}`, text()]),
  );
  refusesDescriptor({ row: z.strictObject(thirteen) }, /declares 13 columns, ceiling is 12/);
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

export default await run('schema — the row contract and how Avito payloads become data');
