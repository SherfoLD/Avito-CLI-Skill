// Offline end-to-end for `avito move-category`: the real command over a synthetic
// Avito SSR carrier for the source route, for the target category, and for the
// items API the listings come from.
//
// The target is resolved from the navigation state Avito itself rendered, never built from a
// slug, so the checks below are about refusing every ambiguous or non-navigable answer.
import {
  assertOutput, failureOf, loadCommand, runner,
} from './harness.mjs';
import {
  FILTERS, ITEMS_API_PATH, ORIGIN, bootstrapHtml, browserPage, item, itemsApiResponse, searchCore,
} from './carrier.mjs';

const { COMMAND } = await loadCommand('move-category');

const SOURCE_PATH = '/moskva/telefony/mobilnye_telefony/xiaomi-ASgB';
const TARGET_PATH = '/moskva/telefony/mobilnye_telefony-ASgB';
const SOURCE = `${ORIGIN}${SOURCE_PATH}?q=xiaomi`;
const TARGET = `${ORIGIN}${TARGET_PATH}?cd=1&q=xiaomi`;
const API = `${ORIGIN}${ITEMS_API_PATH}`;

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

const targetState = ({ core = {} } = {}) => ({
  loaderData: {
    data: {
      searchCore: searchCore({ query: 'xiaomi', categoryId: 100, ...core }),
      filtersV2: FILTERS,
      catalog: { items: [] },
      context: 'opaque-context',
    },
  },
});

// The listings of the moved-to category, on the carrier that ships all fifty complete (F-089).
const targetApi = ({ items = [item()], core = {}, url = TARGET } = {}) => ({
  match: API,
  contentType: 'application/json',
  body: itemsApiResponse({
    items,
    core: { query: 'xiaomi', categoryId: 100, ...core },
    url,
  }),
});

const sourceRoute = (state = sourceState()) => ({ match: SOURCE, body: bootstrapHtml(state) });
const targetRoute = (state = targetState(), overrides = {}) => ({
  match: TARGET,
  body: bootstrapHtml(state),
  ...overrides,
});

const routes = (...entries) => entries;

const move = (routeList, args = {}) => {
  const page = browserPage(routeList);
  return { page, answer: COMMAND.run(page, { searchUrl: SOURCE, to: 'Мобильные телефоны', ...args }) };
};

const { check, assert, run } = runner();

check('a visible sidebar option resolves to its Avito route and returns its listings', async () => {
  const { page, answer } = move(routes(sourceRoute(), targetRoute(), targetApi()));
  const returned = await answer;
  assert(page.calls.length === 3 && page.calls[0] === SOURCE && page.calls[1] === TARGET
    && page.calls[2].startsWith(API),
  `expected the source, the target and its listings, got ${JSON.stringify(page.calls)}`);
  assert(returned.searchUrl === TARGET, `unexpected searchUrl: ${returned.searchUrl}`);
  // The category is named as Avito spells it, and the query it had to preserve
  // is stated beside it rather than left to be read out of the URL.
  assert(returned.category === 'Мобильные телефоны', `unexpected category: ${returned.category}`);
  assert(returned.query === 'xiaomi', `unexpected query: ${returned.query}`);
  assert(returned.items.every((entry) => !('searchUrl' in entry)), 'the search URL must not repeat on every listing');
  assertOutput(COMMAND, returned);
  assert(page.navigations.length === 1 && page.navigations[0] === 'https://www.avito.ru/robots.txt',
    `expected one robots.txt priming, got ${JSON.stringify(page.navigations)}`);
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
  const driven = move(routes(sourceRoute(sourceState({ nodes: leaky }))), { to: 'Аксессуары' });
  const failure = await failureOf(() => driven.answer);
  assert(failure?.code === 'ARGUMENT', `a query-dropping route was taken: ${failure && failure.code}`);
  assert(/drops the search query "xiaomi"/.test(failure.message), `unexpected message: ${failure.message}`);
  assert(/Мобильные телефоны/.test(failure.message), `the usable names must be offered: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'the target was fetched despite a query-dropping route');
});

// On a query-less route Avito renders the whole ancestor chain as navigable back entries, so the
// upward move is a sidebar move there too — the breadcrumbs it also ships are never read.
check('a query-less search widens through the sidebar back entries', async () => {
  const backTarget = `${ORIGIN}/moskva/telefony?cd=1`;
  const browse = sourceState({ core: { query: '' }, nodes: [
    sideNode({ id: 1, name: 'Телефоны', url: '/moskva/telefony?cd=1', hasBack: true }),
    sideNode({ id: 2, name: 'Xiaomi', type: 2, isCurrent: true, url: SOURCE_PATH }),
  ] });
  const driven = move([
    { ...targetApi({ core: { query: '' }, url: backTarget }) },
    { match: backTarget, body: bootstrapHtml(targetState({ core: { query: '' } })) },
    { match: `${ORIGIN}${SOURCE_PATH}`, body: bootstrapHtml(browse) },
  ], { searchUrl: `${ORIGIN}${SOURCE_PATH}`, to: 'Телефоны' });
  await driven.answer;
  assert(driven.page.calls[1] === backTarget, `the back entry must be followed, got ${driven.page.calls[1]}`);
});

// An entry with no route of its own, and the route we are already on. No other
// carrier is consulted for a URL either of them lacks.
check('a routeless entry and the current route are refused with their reason', async () => {
  const routeless = move(routes(sourceRoute()), { to: 'Телефоны' });
  const routelessFailure = await failureOf(() => routeless.answer);
  assert(routelessFailure?.code === 'ARGUMENT', `routeless entry followed: ${routelessFailure && routelessFailure.code}`);
  assert(/hangs no route/.test(routelessFailure.message), `unexpected message: ${routelessFailure.message}`);
  assert(routeless.page.calls.length === 1, 'the target was fetched despite an unusable entry');

  const current = move(routes(sourceRoute()), { to: 'Xiaomi' });
  const currentFailure = await failureOf(() => current.answer);
  assert(currentFailure?.code === 'ARGUMENT', `current entry followed: ${currentFailure && currentFailure.code}`);
  assert(/already on/.test(currentFailure.message), `unexpected message: ${currentFailure.message}`);
  assert(current.page.calls.length === 1, 'the target was fetched for the current category');

  // The category Avito marks as current is refused by that mark, not only by its
  // pathname: a canonical route spelled differently from the requested one would
  // otherwise return the same category as a successful move (F-052).
  const canonical = move(routes(sourceRoute(sourceState({
    nodes: [sideNode({ id: 1, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery('/moskva/telefony/xiaomi-ASgB') })],
  }))), { to: 'Xiaomi' });
  const canonicalFailure = await failureOf(() => canonical.answer);
  assert(canonicalFailure != null && /already on/.test(canonicalFailure.message),
    `a canonical copy of the current route was followed: ${canonicalFailure && canonicalFailure.message}`);
  assert(canonical.page.calls.length === 1, 'the target was fetched for the current category');
});

// The route Avito could not place in a category: no `type=2` node anywhere, two
// group heads both marked current, and their own routes are the only way out of
// the search (F-084). The head is followed like any other entry (D-057).
check('a group head that carries a route is followed like any other entry', async () => {
  const rootPath = '/moskva';
  const headPath = '/moskva/predlozheniya_uslug';
  const heads = [
    sideNode({ id: 1, name: 'Услуги', type: 0, isCurrent: true, isOpened: true, url: withQuery(headPath), children: [
      sideNode({ id: 2, name: 'Компьютерная помощь', url: withQuery('/moskva/predlozheniya_uslug/komp-ASgB') }),
    ] }),
    sideNode({ id: 3, name: 'Электроника', type: 0, isCurrent: true, url: withQuery('/moskva/bytovaya_elektronika') }),
  ];
  // The city root is a prefix of every route below it, so the stub matches the
  // head first; live, the two are separate documents.
  const driven = move([
    targetApi({ core: { categoryId: 114 }, url: `${ORIGIN}${withQuery(headPath)}` }),
    { match: `${ORIGIN}${headPath}`, body: bootstrapHtml(targetState({ core: { categoryId: 114 } })) },
    {
      match: `${ORIGIN}${rootPath}`,
      body: bootstrapHtml(sourceState({ core: { categoryId: null }, nodes: heads })),
    },
  ], { searchUrl: `${ORIGIN}${rootPath}?q=xiaomi`, to: 'Услуги' });
  const returned = await driven.answer;
  assert(driven.page.calls[1] === `${ORIGIN}${withQuery(headPath)}`, `the head route must be followed, got ${driven.page.calls[1]}`);
  assert(driven.page.calls[2].startsWith(API), `the listings must come from the API, got ${driven.page.calls[2]}`);
  assert(returned.searchUrl === `${ORIGIN}${withQuery(headPath)}`, `unexpected searchUrl: ${returned.searchUrl}`);
});

check('an unknown name lists the visible categories instead of guessing', async () => {
  const driven = move(routes(sourceRoute()), { to: 'Ноутбуки' });
  const failure = await failureOf(() => driven.answer);
  assert(failure?.code === 'ARGUMENT', `unknown name accepted: ${failure && failure.code}`);
  assert(/Мобильные телефоны/.test(failure.message) && /Аксессуары/.test(failure.message),
    `the visible names must be listed: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'the target was fetched despite an unknown name');
});

check('one name pointing at two routes is refused, not resolved to the first', async () => {
  const twins = [
    sideNode({ id: 1, name: 'Телефоны', type: 0, isOpened: true, url: null, children: [
      sideNode({ id: 2, name: 'Аксессуары', url: withQuery('/moskva/telefony/aksessuary-ASgB') }),
      sideNode({ id: 3, name: 'Аксессуары', url: withQuery('/moskva/audio_i_video/aksessuary-ASgB') }),
    ] }),
  ];
  const driven = move(routes(sourceRoute(sourceState({ nodes: twins, breadcrumbs: [] }))), { to: 'Аксессуары' });
  const failure = await failureOf(() => driven.answer);
  assert(failure?.code === 'ARGUMENT', `ambiguity resolved silently: ${failure && failure.code}`);
  assert(/matches 2 different Avito routes/.test(failure.message), `unexpected message: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'the target was fetched despite an ambiguous name');
});

// The same name reached through two sidebar entries that lead to one route is not ambiguous: the
// caller asked for a category, and Avito named a single destination for it.
check('the same route reached twice is not treated as ambiguous', async () => {
  const duplicated = [
    sideNode({ id: 1, name: 'Телефоны', type: 0, isOpened: true, url: null, children: [
      sideNode({ id: 2, name: 'Мобильные телефоны', url: withQuery(TARGET_PATH) }),
      sideNode({ id: 3, name: 'Мобильные телефоны', url: withQuery(TARGET_PATH) }),
    ] }),
  ];
  const resolved = await move(routes(
    sourceRoute(sourceState({ nodes: duplicated, breadcrumbs: [] })), targetRoute(), targetApi(),
  )).answer;
  assert(resolved.items.length === 1, 'one destination must resolve');
});

check('the name match ignores case and surrounding spaces only', async () => {
  const resolved = await move(routes(sourceRoute(), targetRoute(), targetApi()), { to: '  мобильные ТЕЛЕФОНЫ  ' }).answer;
  assert(resolved.items.length === 1, 'a case-different name must resolve');
  // The name comes back as Avito renders it, never as the caller typed it.
  assert(resolved.category === 'Мобильные телефоны', `unexpected category: ${resolved.category}`);

  const partial = await failureOf(() => move(routes(sourceRoute()), { to: 'Мобильные' }).answer);
  assert(partial != null, 'a partial name must not resolve');
});

// The city belongs to the session and to the URL, not to the category, so it must survive
// the move even though the filters and the query deliberately may not.
check('a location changed by the move is drift, not listings', async () => {
  const failure = await failureOf(() => move(routes(
    sourceRoute(),
    targetRoute(targetState({ core: { locationId: 654918, locationName: 'Казань' } })),
  )).answer);
  assert(failure?.code === 'COMMAND_EXEC', `location change accepted: ${failure && failure.code}`);
  assert(/changed the location/.test(failure.message), `unexpected message: ${failure.message}`);
});

// The URL Avito printed said the query survives; the state of the page it answered with is
// what proves it. A query lost between the two is drift, not a narrower result set.
check('a query lost on the way to the target is drift, not listings', async () => {
  const failure = await failureOf(() => move(routes(
    sourceRoute(), targetRoute(targetState({ core: { query: '' } })),
  )).answer);
  assert(failure?.code === 'COMMAND_EXEC', `a lost query was accepted: ${failure && failure.code}`);
  assert(/dropped the search query/.test(failure.message), `unexpected message: ${failure.message}`);
});

check('a redirect away from the named route is drift, not listings', async () => {
  const failure = await failureOf(() => move(routes(
    sourceRoute(),
    targetRoute(undefined, { responseUrl: `${ORIGIN}/moskva/telefony/drugoe-ASgB` }),
  )).answer);
  assert(failure?.code === 'COMMAND_EXEC', `a redirect was accepted: ${failure && failure.code}`);
  assert(/different route/.test(failure.message), `unexpected message: ${failure.message}`);
});

check('a deep page and a challenge stop before the move', async () => {
  const deep = move(routes(sourceRoute(sourceState({ core: { page: 2 } }))));
  const deepFailure = await failureOf(() => deep.answer);
  assert(deepFailure?.code === 'ARGUMENT', `a page-2 URL was moved: ${deepFailure && deepFailure.code}`);
  assert(deep.page.calls.length === 1, 'the target was fetched from a page-2 source');

  const blocked = await failureOf(() => move([
    { match: SOURCE, status: 429, body: '<html><title>Доступ ограничен</title></html>' },
  ]).answer);
  assert(blocked?.code === 'ACCESS', `429 not reported as access: ${blocked && blocked.code}`);
});

check('a target category with no listings is a typed empty result', async () => {
  const failure = await failureOf(() => move(routes(sourceRoute(), targetRoute(), targetApi({ items: [] }))).answer);
  assert(failure?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
});

check('an empty target and a foreign search URL never reach the network', async () => {
  for (const args of [
    { searchUrl: SOURCE, to: '' },
    { searchUrl: SOURCE, to: '   ' },
    { searchUrl: 'https://example.com/moskva', to: 'Телефоны' },
    { searchUrl: '', to: 'Телефоны' },
  ]) {
    const driven = move(routes(sourceRoute(), targetRoute(), targetApi()), args);
    const failure = await failureOf(() => driven.answer);
    assert(failure?.code === 'ARGUMENT', `${JSON.stringify(args)} accepted: ${failure && failure.code}`);
    assert(driven.page.navigations.length === 0, `${JSON.stringify(args)} reached the browser`);
  }
});

check('remove-reserved works the same as in the other listing commands', async () => {
  const items = [item({ id: '8329291056', isReserved: true }), item({ id: '8288791269' })];
  const withItems = () => routes(sourceRoute(), targetRoute(), targetApi({ items }));
  const filtered = await move(withItems(), { 'remove-reserved': true }).answer;
  assert(filtered.items.length === 1 && filtered.items[0].itemId === '8288791269', 'the reserved listing must be dropped');

  const whole = await move(withItems()).answer;
  assert(whole.items.length === 2, 'without the flag the page must come back whole');
});

// The envelope of the new category describes the page it came back with, prices included,
// and the reservation filter shortens both the list and what is counted from it (D-077).
check('the envelope counts the new page and takes the median of its prices', async () => {
  const items = [
    item({ id: '8329291056', visiblePrice: 100, isReserved: true }),
    item({ id: '8288791269', visiblePrice: 900 }),
    item({ id: '8220283533', visiblePrice: 200 }),
  ];
  const withPrices = () => routes(sourceRoute(), targetRoute(), targetApi({ items }));
  const whole = await move(withPrices()).answer;
  assert(whole.itemsCount === 3 && whole.medianPrice === 200,
    `the whole page: ${whole.itemsCount} listings, median ${whole.medianPrice}`);

  const filtered = await move(withPrices(), { 'remove-reserved': true }).answer;
  assert(filtered.itemsCount === 2 && filtered.medianPrice === 550,
    `the shortened page: ${filtered.itemsCount} listings, median ${filtered.medianPrice}`);
});

export default await run('move-category');
