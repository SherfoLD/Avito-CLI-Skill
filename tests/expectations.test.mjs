// Offline checks for the live expectations and the machinery that applies them.
//
// `npm run verify` needs a browser, so nothing here runs a command. What it can
// check is everything up to that point: that every expectation loads, that it
// constrains fields its command actually returns, and that the matcher reports a
// violation instead of passing it.
import { runner } from './harness.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import {
  listExpectations,
  loadExpectation,
  validateExpectation,
  validateOutput,
} from '../scripts/lib/expectation.mjs';
import { idString, text, z } from '../src/runtime/schema.mjs';

const { check, assert, run } = runner();

const manifest = await loadManifest();
const outputOf = new Map(manifest.map((entry) => [entry.name, entry.output]));

check('every command has an expectation that loads and agrees with its fields', async () => {
  const known = listExpectations().map((entry) => entry.command);
  for (const entry of manifest) {
    assert(known.includes(entry.name), `expectations/${entry.name}.mjs is missing`);
  }
  for (const command of known) {
    const expectation = await loadExpectation(command);
    const problems = validateExpectation(expectation, { outputSchema: outputOf.get(command) });
    assert(problems.length === 0, `${command}: ${problems.join('; ')}`);
  }
});

check('an expectation that could not fail is refused', () => {
  const outputSchema = z.strictObject({
    searchUrl: text(),
    items: z.array(z.strictObject({ itemId: idString(), title: text() })),
  });
  const cases = [
    [{}, /must export `output`/],
    [{ output: z.array(z.looseObject({})) }, /must export `output`/],
    [{ output: z.looseObject({ sellerSlug: z.string() }) }, /names "sellerSlug", which the command does not return/],
    // A name that exists on the envelope but not inside the list is the mistake
    // the envelope makes possible, so the path is walked rather than the keys.
    [{ output: z.looseObject({ items: z.array(z.looseObject({ sellerSlug: z.string() })) }) },
      /names "items\.sellerSlug", which the command does not return/],
    [{ output: z.looseObject({}) }, /constrains nothing/],
    // Naming a container is not a claim: the output schema already guarantees
    // `items` exists, and a plausible range is true of every page.
    [{ output: z.looseObject({ items: z.array(z.looseObject({})).min(1).max(50) }) }, /constrains nothing/],
    [{ output: z.looseObject({ searchUrl: text() }), args: 'ddr5' }, /args must be/],
  ];
  for (const [expectation, pattern] of cases) {
    const problems = validateExpectation(expectation, { outputSchema });
    assert(problems.length > 0, `accepted an expectation that constrains nothing: ${Object.keys(expectation)}`);
    assert(pattern.test(problems.join('; ')), `unexpected problem: ${problems.join('; ')}`);
  }

  // Naming one field is a claim; so is a rule over a value, at any depth.
  const accepted = [
    ['a named envelope field', z.looseObject({ searchUrl: z.literal('x') })],
    ['a named field inside a list', z.looseObject({ items: z.array(z.looseObject({ title: z.literal('x') })) })],
    ['an exact count on a list', z.looseObject({ items: z.array(z.looseObject({})).length(50) })],
    ['a refine on a list', z.looseObject({ items: z.array(z.looseObject({})).refine(() => true, 'x') })],
    ['a refine on the whole answer', z.looseObject({}).refine(() => true, 'x')],
  ];
  for (const [what, output] of accepted) {
    const problems = validateExpectation({ output }, { outputSchema });
    assert(problems.length === 0, `${what} must be a claim, got: ${problems.join('; ')}`);
  }
});

check('the matcher names the path that failed', async () => {
  const expectation = await loadExpectation('get-coords');
  const found = {
    address: 'Россия, Тверь, Советская улица, 11',
    kind: 'house',
    locality: 'Тверь',
    latitude: 56.85,
    longitude: 35.9,
    postalCode: '170100',
  };
  assert(validateOutput(found, expectation).length === 0, 'the recorded answer must satisfy its own expectation');

  // Avito resolving the same address in another city is the failure this
  // expectation exists for, and it is invisible in the shape (F-045).
  const elsewhere = validateOutput({ ...found, locality: 'Москва' }, expectation);
  assert(elsewhere.length === 1, `expected one failure, got ${elsewhere.length}`);
  assert(/^locality: /.test(elsewhere[0].detail), `the path must be named: ${elsewhere[0].detail}`);

  assert(validateOutput({ ...found, postalCode: '17010' }, expectation).length === 1, 'a short postal code must fail');
});

check('a rule over a list fires on the list, not on one entry', async () => {
  const expectation = await loadExpectation('get-categories');
  // A sidebar the other rules of the expectation accept, so only the count of
  // current categories decides: the first is the branch above, the rest hang
  // under it, and the one we are on is the one with no route.
  const answer = (currents) => ({
    query: 'ddr5 32gb',
    locationId: '637640',
    searchUrl: 'https://www.avito.ru/moskva?cd=1&q=ddr5+32gb',
    categories: Array.from({ length: 4 }, (unused, index) => {
      const current = index >= 1 && index <= currents;
      return {
        role: index === 0 ? 'branch' : 'option',
        name: `Category ${index}`,
        depth: index === 0 ? 0 : 1,
        parent: index === 0 ? null : 'Category 0',
        current,
        hasChildren: index === 0,
        navigable: !current,
        preservesQuery: current ? null : true,
        targetUrl: current ? null : `https://www.avito.ru/moskva/category-${index}?cd=1&q=ddr5+32gb`,
      };
    }),
  });

  assert(validateOutput(answer(1), expectation).length === 0, 'one current category is the shape of a sidebar');
  for (const currents of [0, 2]) {
    const failures = validateOutput(answer(currents), expectation);
    assert(failures.length === 1, `${currents} current categories should fail, got ${failures.length}`);
    assert(/exactly one entry is the category/.test(failures[0].detail), `unexpected: ${failures[0].detail}`);
  }
});

export default await run('expectations — the live claims, checked offline');
