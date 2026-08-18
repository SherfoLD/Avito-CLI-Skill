// Node-level offline checks for the search command flow: navigation budget, argument
// plumbing and the final guards that run outside the browser context.
import { assertRow, loadCommand, runner } from './harness.mjs';

const { COMMAND, buildQueryUrl, decodeLandedSearch } = await loadCommand('search', [
  'buildQueryUrl', 'decodeLandedSearch',
]);
const { check, assert, run } = runner();

const ROBOTS = 'https://www.avito.ru/robots.txt';
const CANONICAL_PRESERVED = 'https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB?cd=1&q=ddr5+32gb';
const CANONICAL_ABSORBED = 'https://www.avito.ru/moskva/telefony/mobilnye_telefony/apple-ASgB?cd=1&context=H4sIAAAA';

const ROW = {
  apiItemId: '7881841669',
  apiTitle: 'DDR5 32gb Kingston Fury',
  apiPrice: 43691,
  apiMinPrice: null,
  apiHasPriceList: false,
  apiLocation: 'Китай-город, до 5 мин.',
  apiDescriptionPreview: 'Авитодоставка открыта',
  apiPublished: '2026-08-13T23:15:41Z',
  apiSeller: { name: 'AMD INTEL', rating: 5, reviewsCount: 2015 },
  apiImageCount: 1,
  apiUrl: 'https://www.avito.ru/moskva/tovary_dlya_kompyutera/ddr5_7881841669',
};

const context = (searchUrl, overrides = {}) => ({
  success: true,
  refined: false,
  resultSearchLocation: 'Москва',
  resultSearchSort: 'default',
  resultSearchUrl: searchUrl,
  contextLocationId: 637640,
  contextPage: 1,
  resultRows: [ROW],
  ...overrides,
});

function makePage(observed) {
  const calls = { goto: [], evaluateWithArgs: [], fetchJson: [], waits: [] };
  return {
    calls,
    async goto(url) { calls.goto.push(url); },
    async wait(target) { calls.waits.push(target); },
    async evaluate(source) { calls.evaluateWithArgs.push({ source: String(source), args: null }); return null; },
    async evaluateWithArgs(source, args) {
      calls.evaluateWithArgs.push({ source: String(source), args });
      return typeof observed === 'function' ? observed(args) : observed;
    },
    async fetchJson(url) { calls.fetchJson.push(url); throw new Error('unexpected directory call'); },
  };
}

check('buildQueryUrl encodes the query on the bare origin', () => {
  assert(buildQueryUrl('ddr5 32gb') === 'https://www.avito.ru/?q=ddr5+32gb', 'unexpected query URL');
  assert(buildQueryUrl('iphone 13 pro max 256').startsWith('https://www.avito.ru/?q=iphone+13'), 'unexpected encoding');
});

check('preserved q must match exactly, absorbed q is accepted, homepage never is', () => {
  assert(decodeLandedSearch(CANONICAL_PRESERVED, 'ddr5 32gb').accepted === true, 'preserved q rejected');
  assert(decodeLandedSearch(CANONICAL_ABSORBED, 'iphone').accepted === true, 'absorbed query rejected');
  assert(decodeLandedSearch(CANONICAL_ABSORBED, 'iphone').queryPreserved === false, 'absorbed reported as preserved');
  assert(decodeLandedSearch('https://www.avito.ru/moskva/telefony?q=android', 'iphone').reason === 'query', 'foreign q accepted');
  assert(decodeLandedSearch('https://www.avito.ru/?q=iphone', 'iphone').reason === 'homepage', 'homepage accepted');
});

check('a default search primes robots.txt only and never renders a catalog page', async () => {
  const page = makePage(context(CANONICAL_ABSORBED));
  const rows = await COMMAND.run(page, { query: 'iphone', limit: 3 });
  assert(rows.length === 1 && rows[0].itemId === ROW.apiItemId, 'rows not mapped');
  assert(rows[0].price === 43691 && rows[0].location === 'Китай-город, до 5 мин.', 'card semantics not preserved');
  assert(rows[0].searchUrl === CANONICAL_ABSORBED, 'searchUrl not returned');
  assertRow(COMMAND, rows[0]);
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === ROBOTS, `expected one robots.txt priming, got ${JSON.stringify(page.calls.goto)}`);
  assert(page.calls.evaluateWithArgs.length === 1, 'more than one browser evaluation');
  const args = page.calls.evaluateWithArgs[0].args;
  assert(args.queryUrl === 'https://www.avito.ru/?q=iphone' && args.query === 'iphone', 'query arguments not passed');
  assert(!('requestUrl' in args), 'stale requestUrl argument still passed');
});

check('a location refinement keeps the same single-priming budget', async () => {
  const refinedUrl = `${CANONICAL_PRESERVED}&locationId=654918`;
  const page = makePage(context(refinedUrl, { refined: true, contextLocationId: 654918 }));
  const rows = await COMMAND.run(page, { query: 'ddr5 32gb', 'location-id': 654918 });
  assert(rows[0].searchUrl === refinedUrl, 'server URL not preserved');
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === ROBOTS, 'refinement changed the navigation budget');
  assert(page.calls.evaluateWithArgs[0].args.refinement.locationRequested === true, 'refinement not requested');
});

// The six catalog-filter flags moved to `avito apply-filters`, and an agent reading only
// descriptions must not be able to smuggle them back in through this command (D-031).
check('the catalog filter flags are gone and never reach the browser context', async () => {
  const page = makePage(context(CANONICAL_PRESERVED));
  const declared = COMMAND.args.map((arg) => arg.name);
  for (const gone of ['sort', 'price-min', 'price-max', 'seller', 'delivery-only', 'local-priority']) {
    assert(!declared.includes(gone), `${gone} is still declared by avito search`);
  }
  await COMMAND.run(page, {
    query: 'ddr5 32gb', sort: 'date', 'price-max': 30000, seller: 'company', 'delivery-only': true,
  });
  const { refinement } = page.calls.evaluateWithArgs[0].args;
  assert(refinement.apply === false, 'an unknown flag still triggered the items API');
  for (const gone of ['sortRequested', 'priceRequested', 'sellerRequested', 'deliveryOnly', 'localPriority']) {
    assert(!(gone in refinement), `${gone} still travels to the browser context`);
  }
});

check('a search URL that drifted to another query is rejected outside the browser too', async () => {
  const page = makePage(context('https://www.avito.ru/moskva/telefony?q=android'));
  let failure = null;
  try {
    await COMMAND.run(page, { query: 'iphone', limit: 3 });
  } catch (error) { failure = error; }
  assert(failure != null && /different query/.test(failure.message), `foreign query accepted: ${failure && failure.message}`);
});

check('a homepage search URL is rejected outside the browser too', async () => {
  const page = makePage(context('https://www.avito.ru/?q=iphone'));
  let failure = null;
  try {
    await COMMAND.run(page, { query: 'iphone', limit: 3 });
  } catch (error) { failure = error; }
  assert(failure != null && /did not canonicalize/.test(failure.message), `homepage accepted: ${failure && failure.message}`);
});

check('typed errors survive the context boundary', async () => {
  const cases = [
    { observed: { success: false, stage: 'submit', code: 'access', message: 'Доступ ограничен' }, expect: /human verification/, code: 'COMMAND_EXEC' },
    { observed: { success: false, stage: 'catalog', code: 'empty', message: 'No listings match the requested query' }, expect: /No listings/, code: 'EMPTY_RESULT' },
    { observed: { success: false, stage: 'submit', code: 'drift', message: 'Avito answered with a different query' }, expect: /different query/, code: 'COMMAND_EXEC' },
  ];
  for (const testCase of cases) {
    const page = makePage(testCase.observed);
    let failure = null;
    try {
      await COMMAND.run(page, { query: 'iphone', limit: 3 });
    } catch (error) { failure = error; }
    assert(failure != null, `case ${testCase.code} did not fail`);
    assert(failure.code === testCase.code, `expected ${testCase.code}, got ${failure.code}: ${failure.message}`);
    assert(testCase.expect.test(failure.message), `unexpected message: ${failure.message}`);
  }
});

// A bootstrap that came back without the search state is retried exactly once with a
// cache-bypassing read; anything else stops on the first answer.
check('a missing bootstrap is retried once and then reported', async () => {
  let calls = 0;
  const page = makePage(() => {
    calls += 1;
    return { success: false, stage: 'schema', code: 'missing', message: 'Avito SSR search bootstrap has no complete search/filter state' };
  });
  let failure = null;
  try {
    await COMMAND.run(page, { query: 'ddr5 32gb' });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'COMMAND_EXEC', `unexpected error: ${failure && failure.code}`);
  assert(calls === 2, `expected exactly one bounded schema recovery, got ${calls} attempts`);
  assert(page.calls.evaluateWithArgs[1].args.forceFreshSchema === true, 'the retry must bypass the cache');
});

check('geo IDs are validated before any search request', async () => {
  const page = makePage(context(CANONICAL_PRESERVED));
  const seen = [];
  page.fetchJson = async (url) => {
    seen.push(url);
    if (url.includes('/web/1/search/locations')) {
      return { result: { params: [{ parameters: [{ id: 'locationId', value: { id: 650400, names: { 1: 'Казань' }, hasMetro: true } }] }] } };
    }
    return { stations: [{ id: 2046, name: 'Кремлёвская' }] };
  };
  let failure = null;
  try {
    await COMMAND.run(page, { query: 'ddr5 32gb', limit: 3, 'location-id': 650400, metro: '999999' });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'ARGUMENT', `unknown metro accepted: ${failure && failure.message}`);
  assert(seen.length === 2, `expected two directory calls, got ${seen.length}`);
  assert(page.calls.evaluateWithArgs.length === 0, 'search ran despite an invalid geo ID');
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === ROBOTS, 'geo validation changed the navigation budget');
});

check('radius arguments are rejected unless they form one applicable geo mode', async () => {
  const cases = [
    { args: { radius: 5 }, expect: /only together/ },
    { args: { coords: '55.760256,37.611446' }, expect: /only together/ },
    { args: { coords: '55.760256,37.611446', radius: 5 }, expect: /--location-id/ },
    { args: { coords: '55.760256,37.611446', radius: 5, 'location-id': 637640, metro: '118' }, expect: /only one of them/ },
    { args: { coords: '55.760256', radius: 5, 'location-id': 637640 }, expect: /latitude>,<longitude/ },
    { args: { coords: '95.1,37.6', radius: 5, 'location-id': 637640 }, expect: /latitude must be/ },
    { args: { coords: '55.760256,37.611446', radius: 0, 'location-id': 637640 }, expect: /positive integer/ },
  ];
  for (const testCase of cases) {
    const page = makePage(context(CANONICAL_PRESERVED));
    let failure = null;
    try {
      await COMMAND.run(page, { query: 'ddr5 32gb', limit: 3, ...testCase.args });
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'ARGUMENT', `accepted ${JSON.stringify(testCase.args)}`);
    assert(testCase.expect.test(failure.message), `unexpected message: ${failure.message}`);
    assert(page.calls.evaluateWithArgs.length === 0, 'search ran despite an invalid radius argument');
  }
});

check('the radius is checked against the visible list before any search request', async () => {
  const capabilities = {
    result: {
      params: [{
        parameters: [
          { id: 'locationId', value: { id: 637640, names: { 1: 'Москва' }, hasMetro: true, hasDistricts: true } },
          { id: 'smallRadius', type: 'select', values: [
            { id: '1_general', title: '1 км', radiusValue: 1 },
            { id: '5_general', title: '5 км', radiusValue: 5 },
          ] },
        ],
      }],
    },
  };

  const rejecting = makePage(context(CANONICAL_PRESERVED));
  const seen = [];
  rejecting.fetchJson = async (url) => { seen.push(url); return capabilities; };
  let failure = null;
  try {
    await COMMAND.run(rejecting, {
      query: 'ddr5 32gb', limit: 3, 'location-id': 637640, coords: '55.760256,37.611446', radius: 7,
    });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'ARGUMENT', `unoffered radius accepted: ${failure && failure.message}`);
  assert(/Visible values: 1, 5/.test(failure.message), `visible list not reported: ${failure.message}`);
  assert(seen.length === 1 && seen[0].includes('locationId=637640'), `unexpected directory calls: ${JSON.stringify(seen)}`);
  assert(rejecting.calls.evaluateWithArgs.length === 0, 'search ran despite an unoffered radius');
  assert(rejecting.calls.goto.length === 1 && rejecting.calls.goto[0] === ROBOTS, 'radius validation changed the navigation budget');

  const accepting = makePage(context(`${CANONICAL_PRESERVED}&radius=5`, { refined: true }));
  accepting.fetchJson = async () => capabilities;
  const rows = await COMMAND.run(accepting, {
    query: 'ddr5 32gb', limit: 3, 'location-id': 637640, coords: '55.760256,37.611446', radius: 5,
  });
  assert(rows.length === 1, 'offered radius did not search');
  const passed = accepting.calls.evaluateWithArgs[0].args.refinement;
  assert(passed.radiusRequested === true && passed.radius === '5', 'radius not handed to the browser context');
  assert(passed.coords === '55.760256,37.611446', 'coordinate pair not handed to the browser context');
  assert(passed.latitude === '55.760256' && passed.longitude === '37.611446', 'coordinate parts not passed');
});

// Avito offers no server-side reservation filter, so --remove-reserved is an explicit local
// predicate over the page it returned: it drops the reserved rows, refuses to guess when the
// flag is gone and never silently turns a filtered-out page into a successful empty answer.
check('remove-reserved drops reserved rows without asking Avito to refine anything', async () => {
  const rows = [
    { ...ROW, apiItemId: '8329291056', apiReserved: true },
    { ...ROW, apiItemId: '8288791269', apiReserved: false },
    { ...ROW, apiItemId: '8220283533', apiReserved: true },
  ];
  const page = makePage(context(CANONICAL_PRESERVED, { resultRows: rows }));
  const result = await COMMAND.run(page, { query: 'ddr5 32gb', 'remove-reserved': true });
  assert(result.length === 1 && result[0].itemId === '8288791269', `unexpected rows: ${JSON.stringify(result.map((r) => r.itemId))}`);
  assert(!('isReserved' in result[0]), 'the flag must stay out of the row contract');
  const passed = page.calls.evaluateWithArgs[0].args;
  assert(passed.refinement.apply === false, 'remove-reserved must not trigger the items API');
  assert(!('removeReserved' in passed.refinement), 'remove-reserved must not look like a server-applied key');
});

check('a page whose listings are all reserved is a typed empty result', async () => {
  const rows = [
    { ...ROW, apiItemId: '8329291056', apiReserved: true },
    { ...ROW, apiItemId: '8220283533', apiReserved: true },
  ];
  const page = makePage(context(CANONICAL_PRESERVED, { resultRows: rows }));
  let failure = null;
  try {
    await COMMAND.run(page, { query: 'ddr5 32gb', 'remove-reserved': true });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
  assert(/\(2\) is reserved/.test(failure.message), `page size not reported: ${failure && failure.message}`);
});

check('a missing reservation flag refuses the filter instead of keeping the row', async () => {
  const rows = [
    { ...ROW, apiItemId: '8288791269', apiReserved: false },
    { ...ROW, apiItemId: '8234297329', apiReserved: null },
  ];
  const page = makePage(context(CANONICAL_PRESERVED, { resultRows: rows }));
  let failure = null;
  try {
    await COMMAND.run(page, { query: 'ddr5 32gb', 'remove-reserved': true });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'COMMAND_EXEC', `drifted flag accepted: ${failure && failure.code}`);
  assert(/reservation flag/.test(failure.message), `unexpected message: ${failure && failure.message}`);

  const untouched = makePage(context(CANONICAL_PRESERVED, { resultRows: rows }));
  const kept = await COMMAND.run(untouched, { query: 'ddr5 32gb' });
  assert(kept.length === 2, 'without the flag the page must come back whole, drift or not');
});

export default await run('search flow (node side)');
