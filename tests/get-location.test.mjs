// Node-level offline checks for the location resolver.
//
// These are the rules that stop a plausible wrong answer rather
// than an obvious one — an exact-match requirement that keeps `--geo` from
// listing the metro of a neighbouring city, and a refusal to truncate that
// keeps 347 of Moscow's 357 stations from disappearing in silence.
import { assertOutput, loadCommand, runner } from './harness.mjs';

const { COMMAND } = await loadCommand('get-location');
const { check, assert, run } = runner();

const PRIMED_ORIGIN = 'https://www.avito.ru/';

const suggestion = (id, name, parent = null) => ({
  id,
  names: { 1: name },
  ...(parent ? { parent: { names: { 1: parent } } } : {}),
});

const SUGGESTIONS = {
  result: {
    locations: [
      suggestion(637640, 'Москва'),
      suggestion(637780, 'Московская область'),
    ],
  },
};

const capabilities = ({ hasMetro = true, hasDistricts = true, id = 637640 } = {}) => ({
  result: {
    params: [{
      parameters: [
        { id: 'locationId', value: { id, names: { 1: 'Москва' }, hasMetro, hasDistricts } },
      ],
    }],
  },
});

const METRO = {
  lines: [
    { id: 1, name: 'Сокольническая' },
    { id: 2, name: 'Замоскворецкая' },
  ],
  stations: [
    { id: 100, name: 'Охотный Ряд', lineIds: [1] },
    { id: 101, name: 'Театральная', lineIds: [2] },
    { id: 102, name: 'Библиотека имени Ленина', lineIds: [1, 2] },
  ],
};

const DISTRICTS = {
  regions: [
    { shortName: 'ЦАО', fullName: 'Центральный административный округ', districtIds: [200, 201] },
  ],
  districts: [
    { id: 200, name: 'Арбат' },
    { id: 201, name: 'Хамовники' },
    { id: 202, name: 'Северное Бутово' },
  ],
};

// The three directories, keyed by the path each read hits. A route the command
// does not ask for is an error, so a change in the request budget is loud.
function makePage(routes) {
  const calls = { goto: [], fetchJson: [] };
  let tabOrigin = 'null';
  return {
    calls,
    async goto(url) { calls.goto.push(url); tabOrigin = new URL(url).origin; },
    async evaluate(expression) {
      if (expression === 'location.origin') return tabOrigin;
      throw new Error(`unexpected page.evaluate: ${expression}`);
    },
    async wait() {},
    async fetchJson(url) {
      calls.fetchJson.push(url);
      const path = new URL(url).pathname;
      if (!(path in routes)) throw new Error(`unexpected directory read: ${url}`);
      const route = routes[path];
      return typeof route === 'function' ? route(new URL(url)) : route;
    },
  };
}

const ALL_ROUTES = {
  '/web/1/slocations': SUGGESTIONS,
  '/web/1/search/locations': capabilities(),
  '/web/2/locations/metro': METRO,
  '/web/2/locations/districts': DISTRICTS,
};

const refuses = async (page, args, code, pattern) => {
  let failure = null;
  try {
    await COMMAND.run(page, args);
  } catch (error) { failure = error; }
  if (failure == null) throw new Error(`accepted ${JSON.stringify(args)}`);
  if (failure.code !== code) throw new Error(`expected ${code}, got ${failure.code}: ${failure.message}`);
  if (!pattern.test(failure.message)) throw new Error(`unexpected message: ${failure.message}`);
  return failure;
};

check('resolver mode costs one directory read and returns the suggestions', async () => {
  const page = makePage(ALL_ROUTES);
  const answer = await COMMAND.run(page, { query: '  Москва ' });
  const { locations } = answer;
  assert(answer.query === 'Москва', `the query must come back trimmed, got ${JSON.stringify(answer.query)}`);
  assert(locations.length === 2, `expected both suggestions, got ${locations.length}`);
  assert(locations[0].locationId === '637640' && locations[0].locationName === 'Москва', 'the location was not decoded');
  assert(answer.geoMode === null && answer.geo.length === 0, 'suggestion mode answers about no geo at all');
  assertOutput(COMMAND, answer);
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === PRIMED_ORIGIN,
    `expected one origin priming navigation, got ${JSON.stringify(page.calls.goto)}`);
  assert(page.calls.fetchJson.length === 1, `resolver mode must cost one read, got ${page.calls.fetchJson.length}`);
  const asked = new URL(page.calls.fetchJson[0]);
  assert(asked.searchParams.get('q') === 'Москва', 'the query must be collapsed and passed verbatim');
  assert(asked.searchParams.get('limit') === '10', 'the resolver asks for the observed UI limit');
});

// The IDs must belong to the location the caller named. Avito suggests neighbours
// freely, so taking the first suggestion would list the metro of another city while
// the answer looked perfectly ordinary.
check('geo mode requires one exact name match, never the first suggestion', async () => {
  const page = makePage(ALL_ROUTES);
  const { locations } = await COMMAND.run(page, { query: 'москва', geo: 'metro' });
  assert(locations.length === 1 && locations[0].locationId === '637640',
    'geo mode answers about the one location it matched');

  const near = makePage({ ...ALL_ROUTES, '/web/1/slocations': { result: { locations: [suggestion(637780, 'Московская область')] } } });
  const failure = await refuses(near, { query: 'Москва', geo: 'metro' }, 'ARGUMENT', /No exact Avito location match/);
  assert(/Московская область/.test(failure.message), 'the suggestions must be offered back');
  assert(near.calls.fetchJson.length === 1, 'a directory was read despite no exact match');

  const twins = makePage({
    ...ALL_ROUTES,
    '/web/1/slocations': { result: { locations: [suggestion(1, 'Пушкино', 'Московская область'), suggestion(2, 'Пушкино', 'Санкт-Петербург')] } },
  });
  const ambiguous = await refuses(twins, { query: 'Пушкино', geo: 'metro' }, 'ARGUMENT', /is ambiguous/);
  assert(/\(1\)/.test(ambiguous.message) && /\(2\)/.test(ambiguous.message),
    `both candidates must be named with their IDs: ${ambiguous.message}`);
});

check('metro entries carry the line names as their group', async () => {
  const page = makePage(ALL_ROUTES);
  const answer = await COMMAND.run(page, { query: 'Москва', geo: 'metro' });
  const { geo } = answer;
  assert(geo.length === 3, `expected every station, got ${geo.length}`);
  assert(answer.geoMode === 'metro' && geo[0].geoId === '100' && geo[0].geoName === 'Охотный Ряд',
    `station not decoded: ${JSON.stringify(geo[0])}`);
  assert(geo[0].geoGroup === 'Сокольническая', 'a single line is the group');
  assert(geo[2].geoGroup === 'Сокольническая, Замоскворецкая', 'an interchange lists both lines');
  // The city is one fact about the whole answer, and the stations no longer repeat it.
  assert(answer.locations.length === 1 && answer.locations[0].locationName === 'Москва',
    'the resolved city belongs to the answer, not to every station');
  assert(geo.every((entry) => !('locationName' in entry)), 'a station must not carry the city');
  assertOutput(COMMAND, answer);
  assert(page.calls.fetchJson.length === 3, `geo mode costs three reads, got ${page.calls.fetchJson.length}`);
});

check('district entries carry their region, and a district in none carries null', async () => {
  const { geo } = await COMMAND.run(makePage(ALL_ROUTES), { query: 'Москва', geo: 'districts' });
  assert(geo.length === 3, `expected every district, got ${geo.length}`);
  assert(geo[0].geoName === 'Арбат' && geo[0].geoGroup === 'ЦАО', 'the region must become the group');
  assert(geo[2].geoName === 'Северное Бутово' && geo[2].geoGroup === null,
    'a district in no listed region carries null, not an invented group');
});

check('geo-query filters by the visible name and reports an empty match', async () => {
  const { geo } = await COMMAND.run(makePage(ALL_ROUTES), { query: 'Москва', geo: 'metro', 'geo-query': 'театр' });
  assert(geo.length === 1 && geo[0].geoName === 'Театральная', `filter did not apply: ${JSON.stringify(geo)}`);

  await refuses(
    makePage(ALL_ROUTES),
    { query: 'Москва', geo: 'metro', 'geo-query': 'нетакойстанции' },
    'EMPTY_RESULT',
    /matched "нетакойстанции"/,
  );
});

// Moscow has 357 stations. Handing back the first 10 with no sign that 347 were
// dropped is the silent clamp this repository exists to refuse.
check('a result larger than the limit is refused, never truncated', async () => {
  const failure = await refuses(
    makePage(ALL_ROUTES),
    { query: 'Москва', geo: 'metro', limit: 2 },
    'ARGUMENT',
    /has 3 matching metro entries but limit is 2/,
  );
  assert(/--geo-query|--limit/.test(failure.message), 'the caller must be told how to proceed');

  const within = await COMMAND.run(makePage(ALL_ROUTES), { query: 'Москва', geo: 'metro', limit: 3 });
  assert(within.geo.length === 3, 'a limit that fits must return every entry');
});

check('the limit ceiling differs between the two modes', async () => {
  await refuses(makePage(ALL_ROUTES), { query: 'Москва', limit: 11 }, 'ARGUMENT', /limit must be <= 10/);
  await refuses(makePage(ALL_ROUTES), { query: 'Москва', geo: 'metro', limit: 401 }, 'ARGUMENT', /limit must be <= 400/);
  await refuses(makePage(ALL_ROUTES), { query: 'Москва', limit: 0 }, 'ARGUMENT', /positive integer/);

  // Resolver mode still trims to the limit: those matches are Avito's own ranking of
  // suggestions, so asking for fewer is asking for the top of a list, not a clamp.
  const { locations } = await COMMAND.run(makePage(ALL_ROUTES), { query: 'Москва', limit: 1 });
  assert(locations.length === 1 && locations[0].locationName === 'Москва', 'the resolver must honour its limit');
});

check('a location without the requested geo is refused by name', async () => {
  const page = makePage({ ...ALL_ROUTES, '/web/1/search/locations': capabilities({ hasMetro: false }) });
  const failure = await refuses(page, { query: 'Москва', geo: 'metro' }, 'ARGUMENT', /has no metro/);
  assert(/637640/.test(failure.message), 'the location must be named with its ID');
  assert(page.calls.fetchJson.length === 2, 'the directory was read for a location that has none');
});

check('a bad query and a geo-query without a mode never reach the network', async () => {
  for (const args of [{ query: '' }, { query: '   ' }, { query: 'Москва', 'geo-query': 'театр' }, { query: 'Москва', geo: 'oblast' }]) {
    const page = makePage(ALL_ROUTES);
    let failure = null;
    try {
      await COMMAND.run(page, args);
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'ARGUMENT', `${JSON.stringify(args)} accepted`);
    assert(page.calls.goto.length === 0, `${JSON.stringify(args)} reached the browser`);
  }
});

check('a refused directory stops the command on that response', async () => {
  const page = makePage({
    ...ALL_ROUTES,
    '/web/1/slocations': () => { throw new Error('Avito answered 429 — rate limit or access challenge'); },
  });
  await refuses(page, { query: 'Москва' }, 'COMMAND_EXEC', /429/);
  assert(page.calls.fetchJson.length === 1, 'the refusal must stop on the first directory response');
});

check('a drifted directory response fails closed instead of returning fewer entries', async () => {
  const cases = [
    [{ '/web/1/slocations': { result: {} } }, /unexpected shape/],
    [{ '/web/1/slocations': { result: { locations: [{ id: 0, names: { 1: 'Москва' } }] } } }, /result\.locations\.0\.id: Too small/],
    [{ '/web/1/search/locations': { result: { params: [] } } }, /unexpected shape/],
    [{ '/web/1/search/locations': capabilities({ id: 999 }) }, /capabilities for a different location/],
    [{ '/web/1/search/locations': { result: { params: [{ parameters: [{ id: 'locationId', value: { id: 637640 } }] }] } } }, /hasMetro: .*expected boolean/],
    [{ '/web/2/locations/metro': { stations: METRO.stations } }, /metro response has an unexpected shape/],
    [{ '/web/2/locations/metro': { ...METRO, lines: [{ id: 1 }] } }, /lines\.0\.name: must not be empty/],
    [{ '/web/2/locations/metro': { ...METRO, stations: [{ id: 100 }] } }, /stations\.0\.name: must not be empty/],
    [{ '/web/2/locations/metro': { ...METRO, stations: [METRO.stations[0], METRO.stations[0]] } }, /duplicate ID 100/],
  ];
  for (const [override, pattern] of cases) {
    await refuses(makePage({ ...ALL_ROUTES, ...override }), { query: 'Москва', geo: 'metro' }, 'COMMAND_EXEC', pattern);
  }
});

check('no locations at all is a typed empty result', async () => {
  await refuses(
    makePage({ ...ALL_ROUTES, '/web/1/slocations': { result: { locations: [] } } }),
    { query: 'Юзерляндия' },
    'EMPTY_RESULT',
    /No locations matched/,
  );
});

export default await run('get-location (node side)');
