// Offline checks for the live fixtures and the machinery that applies them.
//
// `npm run verify` needs a browser, so nothing here runs a command. What it can
// check is everything up to that point: that every fixture loads, that it
// constrains columns its command actually returns, and that the matcher reports
// a violation instead of passing it.
import { runner } from './harness.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { listFixtures, loadFixture, validateFixture, validateRows } from '../scripts/lib/verify-fixture.mjs';
import { z } from '../src/runtime/schema.mjs';

const { check, assert, run } = runner();

const manifest = await loadManifest();
const columnsOf = new Map(manifest.map((entry) => [entry.name, entry.columns]));

check('every command has a fixture that loads and agrees with its columns', async () => {
  const fixtures = listFixtures().map((entry) => entry.command);
  for (const entry of manifest) {
    assert(fixtures.includes(entry.name), `verify/${entry.name}.mjs is missing`);
  }
  for (const command of fixtures) {
    const fixture = await loadFixture(command);
    const problems = validateFixture(fixture, { declaredColumns: columnsOf.get(command) });
    assert(problems.length === 0, `${command}: ${problems.join('; ')}`);
  }
});

check('a fixture that could not fail is refused', () => {
  const columns = ['itemId', 'title'];
  const cases = [
    [{}, /must export `rows`/],
    [{ rows: z.looseObject({}) }, /must export `rows`/],
    [{ rows: z.array(z.looseObject({ sellerSlug: z.string() })) }, /does not return/],
    // A plausible range is true of every page this command could return.
    [{ rows: z.array(z.looseObject({})).min(1).max(50) }, /constrains nothing/],
    [{ rows: z.array(z.looseObject({})), args: 'ddr5' }, /args must be/],
  ];
  for (const [fixture, pattern] of cases) {
    const problems = validateFixture(fixture, { declaredColumns: columns });
    assert(problems.length > 0, `accepted a fixture that constrains nothing: ${Object.keys(fixture)}`);
    assert(pattern.test(problems[0]), `unexpected problem: ${problems[0]}`);
  }

  // An exact count and a rule over the whole set are both real claims.
  assert(validateFixture({ rows: z.array(z.looseObject({})).length(31) }, {}).length === 0,
    'an exact row count is a claim about this route');
  assert(validateFixture({ rows: z.array(z.looseObject({})).refine(() => true, 'x') }, {}).length === 0,
    'a rule over the whole set is a claim about this request');
});

check('the matcher reports the row and the column that failed', async () => {
  const fixture = await loadFixture('get-coords');
  const found = {
    address: 'Россия, Тверь, Советская улица, 11',
    kind: 'house',
    locality: 'Тверь',
    latitude: 56.85,
    longitude: 35.9,
    postalCode: '170100',
  };
  assert(validateRows([found], fixture).length === 0, 'the recorded answer must satisfy its own fixture');

  // Avito resolving the same address in another city is the failure this fixture
  // exists for, and it is invisible in the row's shape (F-045).
  const elsewhere = validateRows([{ ...found, locality: 'Москва' }], fixture);
  assert(elsewhere.length === 1, `expected one failure, got ${elsewhere.length}`);
  assert(/^0\.locality: /.test(elsewhere[0].detail), `the row and column must be named: ${elsewhere[0].detail}`);

  assert(validateRows([found, found], fixture).length === 1, 'a second row must fail the count');
  assert(validateRows([{ ...found, postalCode: '17010' }], fixture).length === 1, 'a short postal code must fail');
});

check('a rule over the whole set fires on the set, not on a row', async () => {
  const fixture = await loadFixture('get-categories');
  // A sidebar the other rules of the fixture accept, so only the count of
  // current rows decides: the first row is the branch above, the rest hang
  // under it, and the row we are on is the one with no route.
  const rows = (currents) => Array.from({ length: 4 }, (_, index) => {
    const current = index >= 1 && index <= currents;
    return {
      rank: index + 1,
      role: index === 0 ? 'branch' : 'option',
      name: `Category ${index}`,
      depth: index === 0 ? 0 : 1,
      parent: index === 0 ? null : 'Category 0',
      current,
      navigable: !current,
      preservesQuery: current ? null : true,
      searchUrl: current ? null : `https://www.avito.ru/moskva/category-${index}?cd=1&q=ddr5+32gb`,
    };
  });

  assert(validateRows(rows(1), fixture).length === 0, 'one current category is the shape of a sidebar');
  for (const currents of [0, 2]) {
    const failures = validateRows(rows(currents), fixture);
    assert(failures.length === 1, `${currents} current categories should fail, got ${failures.length}`);
    assert(/exactly one row is the category/.test(failures[0].detail), `unexpected: ${failures[0].detail}`);
  }
});

export default await run('verify fixtures — the live claims, checked offline');
