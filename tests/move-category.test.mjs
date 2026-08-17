// Offline end-to-end for move-category: runs the real browser half against a synthetic
// Avito SSR carrier for the source route and for the target category.
//
// The target is resolved from the navigation state Avito itself rendered, never built from a
// slug, so the checks below are about refusing every ambiguous or non-navigable answer.
import { assertRow, loadCommand, runner } from './harness.mjs';
import {
  FILTERS, ORIGIN, bootstrapHtml, evaluateRunner, item, makeFetch, searchCore,
} from './carrier.mjs';
import { moveCategory } from '../src/browser/commands/move-category.mjs';

const { COMMAND } = await loadCommand('move-category');

const SOURCE_PATH = '/moskva/telefony/mobilnye_telefony/xiaomi-ASgB';
const TARGET_PATH = '/moskva/telefony/mobilnye_telefony-ASgB';
const SOURCE = `${ORIGIN}${SOURCE_PATH}?q=xiaomi`;
const TARGET = `${ORIGIN}${TARGET_PATH}?cd=1&q=xiaomi`;

// Avito hangs the text query on every navigable sidebar URL, so the carrier below spells it
// out the same way the live bootstrap does.
const withQuery = (path) => `${path}${path.includes('?') ? '&' : '?'}cd=1&q=xiaomi`;

const sideNode = ({
  id, name, type = 1, url = withQuery(TARGET_PATH), children = [], isCurrent = false, isOpened = false, hasBack = false,
} = {}) => ({ id, name, type, url, children, isCurrent, isOpened, hasBack });

const SIDE_NODES = [
  sideNode({ id: 1, name: 'Телефоны', type: 0, isOpened: true, url: null, children: [
    sideNode({ id: 2, name: 'Мобильные телефоны', url: withQuery(TARGET_PATH) }),
    sideNode({ id: 3, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery(SOURCE_PATH) }),
    sideNode({ id: 4, name: 'Аксессуары', url: withQuery('/moskva/telefony/aksessuary-ASgB') }),
  ] }),
];

// Avito ships breadcrumbs in the bootstrap and the command reads none of them. This
// deliberately malformed one proves a move cannot break on them (D-034).
const BREADCRUMBS = 'not an array at all';

const sourceState = ({ core = {}, nodes = SIDE_NODES, breadcrumbs = BREADCRUMBS } = {}) => ({
  loaderData: {
    data: {
      searchCore: searchCore({ query: 'xiaomi', ...core }),
      rubricators: { side: { nodes } },
      seoNavigation: { breadcrumbs: { links: breadcrumbs } },
    },
  },
});

const targetState = ({ items = [item()], core = {} } = {}) => ({
  loaderData: {
    data: {
      searchCore: searchCore({ query: 'xiaomi', categoryId: 100, ...core }),
      filtersV2: FILTERS,
      catalog: { items },
    },
  },
});

const sourceRoute = (state = sourceState()) => ({ match: SOURCE, body: bootstrapHtml(state) });
const targetRoute = (state = targetState(), overrides = {}) => ({
  match: TARGET,
  body: bootstrapHtml(state),
  ...overrides,
});

const runEvaluate = evaluateRunner(moveCategory);

const baseArgs = (target = 'Мобильные телефоны', overrides = {}) => ({
  requestedUrl: SOURCE,
  target,
  MAX_SIDE_NODES: 200,
  MAX_DEPTH: 20,
  MAX_NAME_LENGTH: 300,
  MAX_PARAMS: 400,
  ...overrides,
});

const { check, assert, run } = runner();

check('a visible sidebar option resolves to its Avito route and returns its listings', async () => {
  const { fetch, calls } = makeFetch([sourceRoute(), targetRoute()]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls.length === 2 && calls[0] === SOURCE && calls[1] === TARGET,
    `expected the source then the target, got ${JSON.stringify(calls)}`);
  assert(result.resultSearchUrl === TARGET, `unexpected searchUrl: ${result.resultSearchUrl}`);
  const row = result.resultRows[0];
  assert(row.apiPrice === 43691, `the shared card decoder must be used, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Китай-город, до 5 мин.', `location not decoded: ${row.apiLocation}`);
  assert(row.apiDescriptionPreview?.startsWith('Авитодоставка открыта'), 'description not decoded');
});

// Avito ships the moment it sorts by on every card and prints that same moment on the
// listing page; get-item sees only the rendered string, so the exact instant belongs to the
// row (F-059). A card without the stamp keeps its row and reports null, while a stamp in a
// shape no clock produces is drift and stops the call.
check('the publication stamp decodes to the instant Avito prints, and drift stops the call', async () => {
  const routes = (rows) => [sourceRoute(), targetRoute(targetState({ items: rows }))];
  const result = await runEvaluate(baseArgs(), makeFetch(routes([item()])).fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows[0].apiPublished === '2026-08-13T23:15:41Z', `expected the UTC instant, got ${result.resultRows[0].apiPublished}`);

  const absent = await runEvaluate(baseArgs(), makeFetch(routes([item({ sortTimeStamp: null })])).fetch);
  assert(absent.success === true && absent.resultRows[0].apiPublished === null, 'a card without the stamp must keep its row');

  for (const drift of [1786662941, 'вчера', -1, 1.5]) {
    let stopped = false;
    try {
      await runEvaluate(baseArgs(), makeFetch(routes([item({ sortTimeStamp: drift })])).fetch);
    } catch (error) {
      stopped = /publication stamp/.test(String(error?.message ?? error));
    }
    assert(stopped, `a stamp of ${JSON.stringify(drift)} must stop the call`);
  }
});

// Moving a search has to keep being that search. The sidebar has never been observed dropping
// the query, but the day it does the answer would look like a legitimately wider page.
check('a route that drops the text query is refused, not followed', async () => {
  const leaky = [
    sideNode({ id: 1, name: 'Телефоны', type: 0, isOpened: true, url: null, children: [
      sideNode({ id: 2, name: 'Мобильные телефоны', url: withQuery(TARGET_PATH) }),
      sideNode({ id: 3, name: 'Аксессуары', url: '/moskva/telefony/aksessuary-ASgB' }),
    ] }),
  ];
  const { fetch, calls } = makeFetch([sourceRoute(sourceState({ nodes: leaky }))]);
  const result = await runEvaluate(baseArgs('Аксессуары'), fetch);
  assert(result.success === false && result.code === 'argument', `a query-dropping route was taken: ${JSON.stringify(result)}`);
  assert(/drops the search query "xiaomi"/.test(result.message), `unexpected message: ${result.message}`);
  assert(/Мобильные телефоны/.test(result.message), `the usable names must be offered: ${result.message}`);
  assert(calls.length === 1, 'the target was fetched despite a query-dropping route');
});

// On a query-less route Avito renders the whole ancestor chain as navigable back rows, so the
// upward move is a sidebar move there too — the breadcrumbs it also ships are never read.
check('a query-less search widens through the sidebar back rows', async () => {
  const backTarget = `${ORIGIN}/moskva/telefony?cd=1`;
  const browse = sourceState({ core: { query: '' }, nodes: [
    sideNode({ id: 1, name: 'Телефоны', url: '/moskva/telefony?cd=1', hasBack: true }),
    sideNode({ id: 2, name: 'Xiaomi', type: 2, isCurrent: true, url: SOURCE_PATH }),
  ] });
  const { fetch, calls } = makeFetch([
    { match: `${ORIGIN}${SOURCE_PATH}`, body: bootstrapHtml(browse) },
    { match: backTarget, body: bootstrapHtml(targetState({ core: { query: '' } })) },
  ]);
  const result = await runEvaluate(
    baseArgs('Телефоны', { requestedUrl: `${ORIGIN}${SOURCE_PATH}` }),
    fetch,
  );
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls[1] === backTarget, `the back row must be followed, got ${calls[1]}`);
});

// Neither row carries a URL of its own, and no other carrier is consulted for one.
check('an expanded branch and the current category are refused with their reason', async () => {
  const noCrumbs = makeFetch([sourceRoute()]);
  const result = await runEvaluate(baseArgs('Телефоны'), noCrumbs.fetch);
  assert(result.success === false && result.code === 'argument', `expanded branch followed: ${JSON.stringify(result)}`);
  assert(/expanded branch/.test(result.message), `unexpected message: ${result.message}`);
  assert(noCrumbs.calls.length === 1, 'the target was fetched despite an unusable row');

  const current = makeFetch([sourceRoute()]);
  const currentResult = await runEvaluate(baseArgs('Xiaomi'), current.fetch);
  assert(currentResult.success === false && currentResult.code === 'argument', `current row followed: ${JSON.stringify(currentResult)}`);
  assert(/already in/.test(currentResult.message), `unexpected message: ${currentResult.message}`);
  assert(current.calls.length === 1, 'the target was fetched for the current category');
});

check('an unknown name lists the visible categories instead of guessing', async () => {
  const { fetch, calls } = makeFetch([sourceRoute()]);
  const result = await runEvaluate(baseArgs('Ноутбуки'), fetch);
  assert(result.success === false && result.code === 'argument', `unknown name accepted: ${JSON.stringify(result)}`);
  assert(/Мобильные телефоны/.test(result.message) && /Аксессуары/.test(result.message),
    `the visible names must be listed: ${result.message}`);
  assert(calls.length === 1, 'the target was fetched despite an unknown name');
});

check('one name pointing at two routes is refused, not resolved to the first', async () => {
  const twins = [
    sideNode({ id: 1, name: 'Телефоны', type: 0, isOpened: true, url: null, children: [
      sideNode({ id: 2, name: 'Аксессуары', url: withQuery('/moskva/telefony/aksessuary-ASgB') }),
      sideNode({ id: 3, name: 'Аксессуары', url: withQuery('/moskva/audio_i_video/aksessuary-ASgB') }),
    ] }),
  ];
  const { fetch, calls } = makeFetch([sourceRoute(sourceState({ nodes: twins, breadcrumbs: [] }))]);
  const result = await runEvaluate(baseArgs('Аксессуары'), fetch);
  assert(result.success === false && result.code === 'argument', `ambiguity resolved silently: ${JSON.stringify(result)}`);
  assert(/matches 2 different Avito routes/.test(result.message), `unexpected message: ${result.message}`);
  assert(calls.length === 1, 'the target was fetched despite an ambiguous name');
});

// The same name reached through two rows that lead to one route is not ambiguous: the
// caller asked for a category, and Avito named a single destination for it.
check('the same route reached twice is not treated as ambiguous', async () => {
  const duplicated = [
    sideNode({ id: 1, name: 'Телефоны', type: 0, isOpened: true, url: null, children: [
      sideNode({ id: 2, name: 'Мобильные телефоны', url: withQuery(TARGET_PATH) }),
      sideNode({ id: 3, name: 'Мобильные телефоны', url: withQuery(TARGET_PATH) }),
    ] }),
  ];
  const { fetch } = makeFetch([sourceRoute(sourceState({ nodes: duplicated, breadcrumbs: [] })), targetRoute()]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `one destination must resolve: ${result.message}`);
});

check('the name match ignores case and surrounding spaces only', async () => {
  const { fetch } = makeFetch([sourceRoute(), targetRoute()]);
  const result = await runEvaluate(baseArgs('  мобильные ТЕЛЕФОНЫ  '), fetch);
  assert(result.success === true, `a case-different name must resolve: ${result.message}`);

  const partial = makeFetch([sourceRoute()]);
  const partialResult = await runEvaluate(baseArgs('Мобильные'), partial.fetch);
  assert(partialResult.success === false, 'a partial name must not resolve');
});

// The city belongs to the session and to the URL, not to the category, so it must survive
// the move even though the filters and the query deliberately may not.
check('a location changed by the move is drift, not rows', async () => {
  const { fetch } = makeFetch([
    sourceRoute(),
    targetRoute(targetState({ core: { locationId: 654918, locationName: 'Казань' } })),
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `location change accepted: ${JSON.stringify(result)}`);
  assert(/changed the location/.test(result.message), `unexpected message: ${result.message}`);
});

// The URL Avito printed said the query survives; the state of the page it answered with is
// what proves it. A query lost between the two is drift, not a narrower result set.
check('a query lost on the way to the target is drift, not rows', async () => {
  const { fetch } = makeFetch([sourceRoute(), targetRoute(targetState({ core: { query: '' } }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `a lost query was accepted: ${JSON.stringify(result)}`);
  assert(/dropped the search query/.test(result.message), `unexpected message: ${result.message}`);
});

check('a redirect away from the named route is drift, not rows', async () => {
  const { fetch } = makeFetch([
    sourceRoute(),
    targetRoute(undefined, { responseUrl: `${ORIGIN}/moskva/telefony/drugoe-ASgB` }),
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `a redirect was accepted: ${JSON.stringify(result)}`);
  assert(/different route/.test(result.message), `unexpected message: ${result.message}`);
});

check('a deep page and a challenge stop before the move', async () => {
  const deep = makeFetch([sourceRoute(sourceState({ core: { page: 2 } }))]);
  const deepResult = await runEvaluate(baseArgs(), deep.fetch);
  assert(deepResult.success === false && deepResult.code === 'argument', `a page-2 URL was moved: ${JSON.stringify(deepResult)}`);
  assert(deep.calls.length === 1, 'the target was fetched from a page-2 source');

  const blocked = makeFetch([{ match: SOURCE, status: 429, body: '<html><title>Доступ ограничен</title></html>' }]);
  const blockedResult = await runEvaluate(baseArgs(), blocked.fetch);
  assert(blockedResult.success === false && blockedResult.code === 'access', `429 not reported as access: ${JSON.stringify(blockedResult)}`);
});

check('a target category with no listings is a typed empty result', async () => {
  const { fetch } = makeFetch([sourceRoute(), targetRoute(targetState({ items: [] }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'empty', `unexpected: ${JSON.stringify(result)}`);
});

// Node side: argument guards and the shared reservation predicate.
const observedMove = (rows) => ({
  success: true,
  resultSearchLocation: 'Москва',
  resultSearchUrl: TARGET,
  resultRows: rows,
});

const ROW = {
  apiItemId: '8288791269',
  apiTitle: 'Xiaomi Redmi Note 13',
  apiPrice: 15990,
  apiMinPrice: null,
  apiHasPriceList: false,
  apiLocation: 'Москва',
  apiDescriptionPreview: 'Новый, запечатан',
  apiPublished: null,
  apiSeller: { name: 'AMD INTEL', rating: 5, reviewsCount: 2015 },
  apiImages: [],
  apiReserved: false,
  apiUrl: `${ORIGIN}/moskva/telefony/redmi_8288791269`,
};

const movePage = (observed) => {
  const calls = { goto: [], evaluateWithArgs: [] };
  return {
    calls,
    async goto(url) { calls.goto.push(url); },
    async wait() {},
    async evaluateWithArgs(source, args) { calls.evaluateWithArgs.push(args); return observed; },
  };
};

check('the command primes robots.txt once and hands the trimmed name to the browser', async () => {
  const page = movePage(observedMove([ROW]));
  const rows = await COMMAND.run(page, { searchUrl: SOURCE, to: '  Мобильные   телефоны ' });
  assert(rows.length === 1 && rows[0].searchUrl === TARGET, 'the new searchUrl must reach every row');
  assertRow(COMMAND, rows[0]);
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === 'https://www.avito.ru/robots.txt',
    `expected one robots.txt priming, got ${JSON.stringify(page.calls.goto)}`);
  assert(page.calls.evaluateWithArgs[0].target === 'Мобильные телефоны',
    `the name must be whitespace-normalized, got ${JSON.stringify(page.calls.evaluateWithArgs[0].target)}`);
});

check('an empty target and a foreign search URL never reach the network', async () => {
  for (const args of [
    { searchUrl: SOURCE, to: '' },
    { searchUrl: SOURCE, to: '   ' },
    { searchUrl: 'https://example.com/moskva', to: 'Телефоны' },
    { searchUrl: '', to: 'Телефоны' },
  ]) {
    const page = movePage(observedMove([ROW]));
    let failure = null;
    try {
      await COMMAND.run(page, args);
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'ARGUMENT', `${JSON.stringify(args)} accepted: ${failure && failure.code}`);
    assert(page.calls.goto.length === 0, `${JSON.stringify(args)} reached the browser`);
  }
});

check('remove-reserved works the same as in the other listing commands', async () => {
  const rows = [{ ...ROW, apiItemId: '8329291056', apiReserved: true }, ROW];
  const filtered = await COMMAND.run(movePage(observedMove(rows)), {
    searchUrl: SOURCE, to: 'Мобильные телефоны', 'remove-reserved': true,
  });
  assert(filtered.length === 1 && filtered[0].itemId === ROW.apiItemId, 'the reserved row must be dropped');

  const whole = await COMMAND.run(movePage(observedMove(rows)), { searchUrl: SOURCE, to: 'Мобильные телефоны' });
  assert(whole.length === 2, 'without the flag the page must come back whole');
});

export default await run('move-category (browser and node sides)');
