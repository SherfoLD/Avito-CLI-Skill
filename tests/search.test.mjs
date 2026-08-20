// Offline end-to-end for `avito search`: the real command over a synthetic Avito
// SSR carrier for both document hops plus the items API response the listings come
// from. What a card means is `card.test.mjs`; what this suite watches is the
// argument guards, the directory calls that run before any search request, the
// request the two hops build, and every postcondition on the answer.
import {
  assertOutput, failureOf, loadCommand, runner,
} from './harness.mjs';
import {
  FILTERS, ITEMS_API_PATH, ORIGIN, bootstrapHtml, browserPage, item, itemsApiResponse, searchCore,
} from './carrier.mjs';

const { COMMAND, buildQueryUrl, decodeLandedSearch } = await loadCommand('search', [
  'buildQueryUrl', 'decodeLandedSearch',
]);
const { check, assert, run } = runner();

const ROBOTS = 'https://www.avito.ru/robots.txt';
const CANONICAL = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB?localPriority=1&q=ddr5+32gb';
const ABSORBED = '/moskva/telefony/mobilnye_telefony/apple-ASgB?cd=1&context=H4sIAAA';
const API = `${ORIGIN}${ITEMS_API_PATH}`;

// The sidebar the landed document draws, which is where the category the search
// fell into is named. `type=2` is the current one; a search Avito placed nowhere
// has none of them and several bold branches instead (F-084).
const sideNode = ({
  id, name, type = 1, url = '/moskva/tovary_dlya_kompyutera/komplektuyuschie-ASgB?cd=1&q=ddr5+32gb',
  children = [], isCurrent = false, isOpened = false, hasBack = false,
} = {}) => ({ id, name, type, url, children, isCurrent, isOpened, hasBack });

const SIDE_NODES = [
  sideNode({ id: 1, name: 'Комплектующие', type: 0, isOpened: true, children: [
    sideNode({ id: 2, name: 'Оперативная память', type: 2, isCurrent: true, url: CANONICAL }),
    sideNode({ id: 3, name: 'Видеокарты', url: '/moskva/tovary_dlya_kompyutera/komplektuyuschie/videokarty-ASgB?cd=1&q=ddr5+32gb' }),
  ] }),
];

// The landed document names the search and ships the context that addresses the
// API; its own catalog is never read, being the twenty-complete-cards carrier (F-089).
function catalogState({ query = 'ddr5 32gb', core = {}, sideNodes = SIDE_NODES } = {}) {
  return {
    loaderData: {
      data: {
        searchCore: searchCore({ query, ...core }),
        filtersV2: FILTERS,
        context: 'opaque-context',
        ...(sideNodes === null ? {} : { rubricators: { side: { nodes: sideNodes } } }),
      },
    },
  };
}

const redirectState = (target) => ({ loaderData: { redirect: target, data: { status: 200, redirected: true, url: target } } });

const hop1 = (target = CANONICAL) => ({ match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(target)) });

const hop2 = ({ state = catalogState(), path = '/moskva/tovary', responseUrl = ORIGIN + CANONICAL } = {}) => ({
  match: `${ORIGIN}${path}`,
  body: bootstrapHtml(state),
  responseUrl,
});

const apiRoute = ({
  items = [item()], core = {}, url = ORIGIN + CANONICAL, ...overrides
} = {}) => ({
  match: API,
  contentType: 'application/json',
  body: itemsApiResponse({ items, core: { query: 'ddr5 32gb', ...core }, url }),
  ...overrides,
});

const routes = (api = apiRoute(), document = hop2(), entry = hop1()) => [entry, document, api];

const search = (routeList, args = {}, options = {}) => {
  const page = browserPage(routeList, options);
  return { page, answer: COMMAND.run(page, { query: 'ddr5 32gb', ...args }) };
};

// ── the guards that never reach the network ──────────────────────────────────

check('buildQueryUrl encodes the query on the bare origin', () => {
  assert(buildQueryUrl('ddr5 32gb') === 'https://www.avito.ru/?q=ddr5+32gb', 'unexpected query URL');
  assert(buildQueryUrl('iphone 13 pro max 256').startsWith('https://www.avito.ru/?q=iphone+13'), 'unexpected encoding');
});

check('preserved q must match exactly, absorbed q is accepted, homepage never is', () => {
  assert(decodeLandedSearch(ORIGIN + CANONICAL, 'ddr5 32gb').accepted === true, 'preserved q rejected');
  assert(decodeLandedSearch(ORIGIN + ABSORBED, 'iphone').accepted === true, 'absorbed query rejected');
  assert(decodeLandedSearch(ORIGIN + ABSORBED, 'iphone').queryPreserved === false, 'absorbed reported as preserved');
  assert(decodeLandedSearch(`${ORIGIN}/moskva/telefony?q=android`, 'iphone').reason === 'query', 'foreign q accepted');
  assert(decodeLandedSearch(`${ORIGIN}/?q=iphone`, 'iphone').reason === 'homepage', 'homepage accepted');
});

// The six catalog-filter flags moved to `avito apply-filters`, and an agent reading only
// descriptions must not be able to smuggle them back in through this command (D-031).
check('the catalog filter flags are gone and never reach a request', async () => {
  const declared = COMMAND.args.map((arg) => arg.name);
  for (const gone of ['sort', 'price-min', 'price-max', 'seller', 'delivery-only', 'local-priority']) {
    assert(!declared.includes(gone), `${gone} is still declared by avito search`);
  }
  const driven = search(routes(), {
    sort: 'date', 'price-max': 30000, seller: 'company', 'delivery-only': true,
  });
  await driven.answer;
  const requested = new URL(driven.page.calls[2]);
  assert(requested.get === undefined && requested.searchParams.get('s') === null,
    `a filter flag reached the request: ${driven.page.calls[2]}`);
  assert(requested.searchParams.get('pmax') === null, `a price flag reached the request: ${driven.page.calls[2]}`);
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
    const driven = search(routes(), testCase.args);
    const failure = await failureOf(() => driven.answer);
    assert(failure?.code === 'ARGUMENT', `accepted ${JSON.stringify(testCase.args)}`);
    assert(testCase.expect.test(failure.message), `unexpected message: ${failure.message}`);
    assert(driven.page.calls.length === 0, 'a request was made despite an invalid radius argument');
  }
});

// ── the directory calls that run before any search request ───────────────────

const CAPABILITIES = {
  result: {
    params: [{
      parameters: [
        { id: 'locationId', value: { id: 650400, names: { 1: 'Казань' }, hasMetro: true, hasDistricts: true } },
        { id: 'smallRadius', type: 'select', values: [
          { id: '1_general', title: '1 км', radiusValue: 1 },
          { id: '5_general', title: '5 км', radiusValue: 5 },
        ] },
      ],
    }],
  },
};

const directory = (url) => (url.includes('/web/1/search/locations')
  ? CAPABILITIES
  : { stations: [{ id: 2046, name: 'Кремлёвская' }] });

check('geo IDs are validated before any search request', async () => {
  const driven = search(routes(), { 'location-id': 650400, metro: '999999' }, { directory });
  const failure = await failureOf(() => driven.answer);
  assert(failure?.code === 'ARGUMENT', `unknown metro accepted: ${failure && failure.message}`);
  assert(driven.page.calls.length === 2, `expected two directory calls, got ${JSON.stringify(driven.page.calls)}`);
  assert(driven.page.navigations.length === 1 && driven.page.navigations[0] === ROBOTS,
    'geo validation changed the navigation budget');
});

check('the radius is checked against the visible list before any search request', async () => {
  const rejecting = search(
    routes(), { 'location-id': 650400, coords: '55.760256,37.611446', radius: 7 }, { directory },
  );
  const failure = await failureOf(() => rejecting.answer);
  assert(failure?.code === 'ARGUMENT', `unoffered radius accepted: ${failure && failure.message}`);
  assert(/Visible values: 1, 5/.test(failure.message), `visible list not reported: ${failure.message}`);
  assert(rejecting.page.calls.length === 1 && rejecting.page.calls[0].includes('locationId=650400'),
    `unexpected directory calls: ${JSON.stringify(rejecting.page.calls)}`);
  assert(rejecting.page.navigations.length === 1, 'radius validation changed the navigation budget');

  const accepting = search(routes(apiRoute({
    core: { locationId: 650400, locationName: 'Казань', geoCoords: [55.760256, 37.611446], searchRadius: 5 },
    url: `${ORIGIN}${CANONICAL}&radius=5`,
  })), { 'location-id': 650400, coords: '55.760256,37.611446', radius: 5 }, { directory });
  await accepting.answer;
  const requested = new URL(accepting.page.calls[3]);
  assert(requested.searchParams.get('radius') === '5', `radius not sent: ${accepting.page.calls[3]}`);
  assert(requested.searchParams.get('geoCoords') === '55.760256,37.611446',
    `coordinate pair not sent: ${accepting.page.calls[3]}`);
});

// ── the two hops and the request they build ──────────────────────────────────

check('two document hops name the search and the items API answers it with the listings', async () => {
  const driven = search(routes());
  const answer = await driven.answer;
  assert(driven.page.calls.length === 3, `expected two documents and one API call, got ${JSON.stringify(driven.page.calls)}`);
  assert(driven.page.calls[1] === ORIGIN + CANONICAL, `second hop used ${driven.page.calls[1]}`);
  assert(driven.page.calls[2].startsWith(API), `the listings must come from the items API, got ${driven.page.calls[2]}`);
  assert(answer.searchUrl === ORIGIN + CANONICAL, `unexpected searchUrl ${answer.searchUrl}`);
  // The URL, the region and the query are one each for the whole answer, and the
  // envelope is the only place they are stated (D-073).
  assert(answer.locationId === '637640' && answer.locationName === 'Москва',
    `unexpected effective location ${answer.locationId}/${answer.locationName}`);
  assert(answer.query === 'ddr5 32gb', `unexpected query ${answer.query}`);
  assert(answer.items.every((entry) => !('searchUrl' in entry)), 'the search URL must not repeat on every listing');
  assertOutput(COMMAND, answer);
  assert(driven.page.navigations.length === 1 && driven.page.navigations[0] === ROBOTS,
    `expected one robots.txt priming, got ${JSON.stringify(driven.page.navigations)}`);
});

// The category is a fact about the whole answer, so it sits on the envelope
// beside the region (D-073, D-076). It is spelled exactly as `move-category --to`
// takes it, which is the only reason it is a name and not an ID.
check('the envelope names the category Avito placed the search in', async () => {
  const { answer } = search(routes());
  const decoded = await answer;
  assert(decoded.category === 'Оперативная память', `unexpected category ${decoded.category}`);
  assert(decoded.items.every((entry) => !('category' in entry)), 'the category must not repeat on every listing');

  // A query Avito could place in no category is drawn as several bold branches
  // with no current node at all, and null is that answer rather than a gap (F-084).
  const nowhere = await search(routes(apiRoute(), hop2({ state: catalogState({ sideNodes: [
    sideNode({ id: 1, name: 'Услуги', type: 0, isCurrent: true, isOpened: true }),
    sideNode({ id: 2, name: 'Электроника', type: 0, isCurrent: true, isOpened: true }),
  ] }) }))).answer;
  assert(nowhere.category === null, `expected no category, got ${nowhere.category}`);
  assertOutput(COMMAND, nowhere);
});

// The category is read off a carrier, so a carrier that stopped being one ends
// the call. Returning null there would say "Avito placed this search nowhere",
// which is a different answer from "the sidebar could not be read".
check('a sidebar this reader cannot walk stops the search before the listings', async () => {
  const missing = await failureOf(() => search(
    routes(apiRoute(), hop2({ state: catalogState({ sideNodes: null }) })),
  ).answer);
  assert(missing?.code === 'COMMAND_EXEC', `expected a typed refusal, got ${missing?.code}`);

  // Two current categories is not a category to choose between.
  const doubled = await failureOf(() => search(routes(apiRoute(), hop2({ state: catalogState({ sideNodes: [
    sideNode({ id: 1, name: 'Оперативная память', type: 2, isCurrent: true, url: CANONICAL }),
    sideNode({ id: 2, name: 'Видеокарты', type: 2, isCurrent: true }),
  ] }) }))).answer);
  assert(/more than one current category/.test(doubled?.message ?? ''), `unexpected refusal ${doubled?.message}`);

  // Both refusals land before the listings are asked for.
  const driven = search(routes(apiRoute(), hop2({ state: catalogState({ sideNodes: null }) })));
  await failureOf(() => driven.answer);
  assert(driven.page.calls.every((url) => !url.startsWith(API)), 'the items API must not be asked');
});

// A search without a geo argument refines nothing, and that is exactly what the
// request must say: the landed searchCore carried over unchanged, no geo key added.
check('a search with no geo argument still asks the API, carrying the landed context', async () => {
  const driven = search(routes());
  await driven.answer;
  const requested = new URL(driven.page.calls[2]);
  assert(requested.searchParams.get('context') === 'opaque-context', `context not carried: ${driven.page.calls[2]}`);
  assert(requested.searchParams.get('categoryId') === '101', `searchCore not carried: ${driven.page.calls[2]}`);
  assert(requested.searchParams.get('locationId') === '637640', `the landed location must be carried: ${driven.page.calls[2]}`);
  assert(!requested.searchParams.has('metro[0]') && !requested.searchParams.has('district[0]'),
    `no geo may be invented: ${driven.page.calls[2]}`);
  assert(!requested.searchParams.has('p'), `the initial search is page 1: ${driven.page.calls[2]}`);
});

check('an absorbed query is accepted and a foreign q is rejected', async () => {
  const absorbed = search([
    hop1(ABSORBED),
    hop2({ state: catalogState({ query: '' }), path: '/moskva/telefony', responseUrl: ORIGIN + ABSORBED }),
    apiRoute({ core: { query: '' }, url: ORIGIN + ABSORBED }),
  ], { query: 'iphone' });
  const answer = await absorbed.answer;
  assert(answer.items.length === 1, 'absorbed query rejected');
  assert(answer.query === null, `an absorbed query must read as null, got ${JSON.stringify(answer.query)}`);

  const foreign = search([hop1('/moskva/telefony?q=android')], { query: 'iphone' });
  const failure = await failureOf(() => foreign.answer);
  assert(failure != null && /different query/.test(failure.message), `foreign q accepted: ${failure && failure.message}`);
  assert(foreign.page.calls.length === 1, 'second hop ran despite a failed guard');
});

check('a homepage target never passes as a search result', async () => {
  const driven = search([hop1('/')]);
  const failure = await failureOf(() => driven.answer);
  assert(failure != null && /did not canonicalize/.test(failure.message), `homepage accepted: ${failure && failure.message}`);
  assert(driven.page.calls.length === 1, 'second hop ran for a homepage target');
});

check('HTTP 429 and access challenges stop on the first hop', async () => {
  const rate = await failureOf(() => search([
    { match: `${ORIGIN}/?q=`, status: 429, body: '<html><title>Доступ ограничен</title></html>' },
  ]).answer);
  assert(rate?.code === 'ACCESS', `429 not reported as access: ${rate && rate.code}`);

  // A verification page is 200 HTML with no state script, which is exactly what a
  // bootstrap that did not arrive looks like. Nothing reads the page text to tell
  // them apart — they call for the same thing.
  const challenge = await failureOf(() => search([{
    match: `${ORIGIN}/?q=`,
    body: '<html><head><title>Доступ ограничен: проблема с IP</title></head><body>проверим, что вы человек</body></html>',
  }]).answer);
  assert(challenge?.code === 'ACCESS', `challenge not reported as access: ${challenge && challenge.code}`);
});

check('an empty catalog with a zero count is a typed empty result', async () => {
  const failure = await failureOf(() => search(routes(apiRoute({ items: [], count: 0 }))).answer);
  assert(failure?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
});

// ── the geo refinements, on the request and on the answer ────────────────────

// The city cannot be applied by editing the URL, so an explicit location travels as a
// key of the API request and is confirmed against the searchCore that came back.
check('a location refinement is carried on the request and confirmed on the answer', async () => {
  const apiRow = item({ id: '8299623583', visiblePrice: 25000, basePrice: 25500 });
  const driven = search(routes(apiRoute({
    items: [apiRow],
    core: { locationId: 654918, locationName: 'Казань' },
    url: `${ORIGIN}${CANONICAL}&locationId=654918`,
  })), { 'location-id': 654918 }, { directory: () => CAPABILITIES });
  const answer = await driven.answer;
  assert(answer.items[0].itemId === '8299623583', 'API listings not used');
  assert(answer.items.length === 1 && driven.page.calls.filter((c) => c.startsWith(API)).length === 1, 'more than one API request');
  const requested = new URL(driven.page.calls[2]);
  assert(requested.searchParams.get('locationId') === '654918', `requested location not sent: ${driven.page.calls[2]}`);
  assert(requested.searchParams.get('spaFlow') === 'true' && requested.searchParams.get('context') === 'opaque-context',
    `unexpected API URL: ${driven.page.calls[2]}`);
  assert(answer.searchUrl === `${ORIGIN}${CANONICAL}&locationId=654918`, 'server URL not returned');
  assert(answer.locationId === '654918' && answer.locationName === 'Казань',
    `the applied location must be reported: ${answer.locationId}/${answer.locationName}`);
  assertOutput(COMMAND, answer);
});

// A location that came back as the landed one means Avito ignored the request, and
// that answers 200 with a full plausible page.
check('a location the API did not apply is drift, not listings', async () => {
  const failure = await failureOf(() => search(
    routes(apiRoute({ url: `${ORIGIN}${CANONICAL}` })), { 'location-id': 654918 },
  ).answer);
  assert(failure != null && /did not apply the requested location/.test(failure.message),
    `an ignored location was accepted: ${failure && failure.message}`);
});

// The catalog filters of the landed route belong to `avito apply-filters`, so this command
// must carry them untouched and stop if Avito changes one behind its back.
check('a catalog filter changed by Avito during a location refinement is drift', async () => {
  const failure = await failureOf(() => search(routes(apiRoute({
    core: { locationId: 654918, locationName: 'Казань', sort: '104' },
    url: `${ORIGIN}${CANONICAL}&locationId=654918`,
  })), { 'location-id': 654918 }).answer);
  assert(failure != null && /preserved search field sort/.test(failure.message),
    `a changed sort must be drift: ${failure && failure.message}`);
});

// Geo travels as indexed keys, so a landed route that already carries one and a
// caller who asks for another must not end up sending both under `metro[0]`.
check('a requested geo selection replaces the one the route landed with', async () => {
  const landed = catalogState({ core: { metroId: ['1', '2'] } });
  const driven = search(
    routes(apiRoute({ core: { metroId: ['9'], locationId: 650400, locationName: 'Казань' } }), hop2({ state: landed })),
    { 'location-id': 650400, metro: '9' },
    { directory: (url) => (url.includes('/search/locations') ? CAPABILITIES : { stations: [{ id: 9, name: 'Кремлёвская' }] }) },
  );
  await driven.answer;
  const apiCall = driven.page.calls.find((call) => call.startsWith(API));
  const sent = [...new URL(apiCall).searchParams.entries()].filter(([key]) => key.startsWith('metro['));
  assert(sent.length === 1 && sent[0][0] === 'metro[0]' && sent[0][1] === '9',
    `the carried selection must be replaced, not stacked: ${JSON.stringify(sent)}`);
});

// The city the caller names is a different place, and a metro ID of the old one
// describes nothing in it — Avito accepts a foreign ID in silence (F-037).
check('a requested city discards the geo of the route the query landed on', async () => {
  const landed = catalogState({ core: { metroId: ['1'], geoCoords: [55.75, 37.61], searchRadius: 5 } });
  const driven = search(routes(
    apiRoute({ core: { locationId: 654918, locationName: 'Казань' }, url: `${ORIGIN}${CANONICAL}&locationId=654918` }),
    hop2({ state: landed }),
  ), { 'location-id': 654918 });
  await driven.answer;
  const sent = new URL(driven.page.calls[2]).searchParams;
  assert(![...sent.keys()].some((key) => key.startsWith('metro[') || key.startsWith('district[')),
    `the old geo IDs must not travel to a new city: ${driven.page.calls[2]}`);
  assert(!sent.has('geoCoords') && !sent.has('radius'), `the old point must not travel either: ${driven.page.calls[2]}`);
});

// Geo the caller did not touch is part of the search, so losing it is drift and
// not a wider result set.
check('geo the caller did not touch must come back unchanged', async () => {
  const landed = catalogState({ core: { metroId: ['1', '2'] } });
  const kept = search(routes(apiRoute({ core: { metroId: ['1', '2'] } }), hop2({ state: landed })));
  await kept.answer;
  const sent = [...new URL(kept.page.calls[2]).searchParams.entries()].filter(([key]) => key.startsWith('metro['));
  assert(sent.length === 2, `the landed selection must be carried: ${JSON.stringify(sent)}`);

  const dropped = await failureOf(() => search(
    routes(apiRoute({ core: { metroId: [] } }), hop2({ state: landed })),
  ).answer);
  assert(dropped != null && /preserved geo selection/.test(dropped.message),
    `a dropped selection was accepted: ${dropped && dropped.message}`);

  const moved = await failureOf(() => search(routes(
    apiRoute({ core: { geoCoords: [55.75, 37.61], searchRadius: 5 } }), hop2({ state: catalogState() }),
  )).answer);
  assert(moved != null && /preserved search point/.test(moved.message),
    `an invented point was accepted: ${moved && moved.message}`);
});

// ── the page, whole ──────────────────────────────────────────────────────────

// Avito fixes the page at 50 listings and offers no page-size parameter, so a full page
// must come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40.
check('every listing Avito put on the page is returned, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const answer = await search(routes(apiRoute({ items }))).answer;
  assert(answer.items.length === 50, `expected the whole page, got ${answer.items.length}`);
  assert(answer.items.every((entry) => entry.descriptionPreview && entry.location && entry.imageCount === 2),
    'the API page must be complete on every listing, not only its first twenty');
});

// Avito offers no server-side reservation filter, so --remove-reserved is an explicit local
// predicate over the page it returned: it drops the reserved listings, refuses to guess when
// the flag is gone and never silently turns a filtered-out page into a successful empty answer.
check('remove-reserved drops reserved listings without asking Avito to refine anything', async () => {
  const items = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: '8288791269', isReserved: false }),
    item({ id: '8220283533', isReserved: true }),
  ];
  const driven = search(routes(apiRoute({ items })), { 'remove-reserved': true });
  const { items: kept } = await driven.answer;
  assert(kept.length === 1 && kept[0].itemId === '8288791269', `unexpected listings: ${JSON.stringify(kept.map((entry) => entry.itemId))}`);
  assert(!('isReserved' in kept[0]) && !('reserved' in kept[0]), 'the flag must stay out of the contract');
  const requested = new URL(driven.page.calls[2]);
  assert(![...requested.searchParams.keys()].some((key) => /reserv/i.test(key)),
    `remove-reserved must never become a request key: ${driven.page.calls[2]}`);
});

check('a page whose listings are all reserved is a typed empty result', async () => {
  const items = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: '8220283533', isReserved: true }),
  ];
  const failure = await failureOf(() => search(routes(apiRoute({ items })), { 'remove-reserved': true }).answer);
  assert(failure?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
  assert(/\(2\) is reserved/.test(failure.message), `page size not reported: ${failure.message}`);
});

check('a missing reservation flag refuses the filter instead of keeping the listing', async () => {
  const items = [
    item({ id: '8288791269', isReserved: false }),
    item({ id: '8234297329', isReserved: null }),
  ];
  const failure = await failureOf(() => search(routes(apiRoute({ items })), { 'remove-reserved': true }).answer);
  assert(failure?.code === 'COMMAND_EXEC', `drifted flag accepted: ${failure && failure.code}`);
  assert(/reservation flag/.test(failure.message), `unexpected message: ${failure.message}`);

  const kept = await search(routes(apiRoute({ items }))).answer;
  assert(kept.items.length === 2, 'without the flag the page must come back whole, drift or not');
});

// `itemsCount` and `medianPrice` are facts about the answer rather than about the search:
// both are taken from the cards this call returns, after --remove-reserved shortened the
// page, and never from the size or the prices of the result set Avito reports (D-077).
check('the answer counts the listings it carries and takes the median of their prices', async () => {
  const priced = (index, visiblePrice, overrides = {}) => item({
    id: String(7881841669 + index), visiblePrice, ...overrides,
  });

  const odd = await search(routes(apiRoute({ items: [priced(0, 300), priced(1, 100), priced(2, 200)] }))).answer;
  assertOutput(COMMAND, odd);
  assert(odd.itemsCount === 3, `itemsCount must count the answer: ${odd.itemsCount}`);
  assert(odd.medianPrice === 200, `median of three prices: ${odd.medianPrice}`);

  const even = await search(routes(apiRoute({
    items: [priced(0, 300), priced(1, 100), priced(2, 200), priced(3, 500)],
  }))).answer;
  assert(even.medianPrice === 250, `median of four prices sits between the middle two: ${even.medianPrice}`);
});

// A card priced «от …» or by a table carries no single price (D-056), so it is left out of
// the median rather than counted at its floor, and a page of nothing but those has none.
check('the median reads price and never a floor or a price table', async () => {
  const priced = (index, visiblePrice, overrides = {}) => item({
    id: String(7881841669 + index), visiblePrice, ...overrides,
  });

  const mixed = await search(routes(apiRoute({
    items: [priced(0, 100), priced(1, 900, { priceForm: 'floor' }), priced(2, 300)],
  }))).answer;
  assert(mixed.itemsCount === 3, `every listing stays in the answer: ${mixed.itemsCount}`);
  assert(mixed.medianPrice === 200, `the floor must not be counted as a price: ${mixed.medianPrice}`);

  // «Бесплатно» is a price of nought rather than a missing one (F-076), so it counts;
  // «Цена договорная» carries no number at all, and a page of nothing but those has no median.
  const free = await search(routes(apiRoute({
    items: [priced(0, 0, { priceForm: 'free' }), priced(1, 100), priced(2, 300)],
  }))).answer;
  assert(free.medianPrice === 100, `a free listing is a price of nought: ${free.medianPrice}`);

  const unpriced = await search(routes(apiRoute({
    items: [priced(0, 0, { priceForm: 'negotiable' }), priced(1, 0, { priceForm: 'negotiable' })],
  }))).answer;
  assertOutput(COMMAND, unpriced);
  assert(unpriced.medianPrice === null, `a page with no price has no median: ${unpriced.medianPrice}`);
  assert(unpriced.itemsCount === 2, `the listings themselves are still counted: ${unpriced.itemsCount}`);
});

check('both are taken after remove-reserved shortened the page', async () => {
  const items = [
    item({ id: '8329291056', visiblePrice: 100, isReserved: true }),
    item({ id: '8288791269', visiblePrice: 900, isReserved: false }),
    item({ id: '8220283533', visiblePrice: 200, isReserved: true }),
  ];
  const whole = await search(routes(apiRoute({ items }))).answer;
  assert(whole.itemsCount === 3 && whole.medianPrice === 200,
    `the whole page: ${whole.itemsCount} listings, median ${whole.medianPrice}`);

  const filtered = await search(routes(apiRoute({ items })), { 'remove-reserved': true }).answer;
  assert(filtered.itemsCount === 1 && filtered.medianPrice === 900,
    `the shortened page: ${filtered.itemsCount} listings, median ${filtered.medianPrice}`);
});

export default await run('search');
