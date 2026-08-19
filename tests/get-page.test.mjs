// Offline end-to-end for `avito get-page`: the real command over a synthetic
// Avito SSR document plus the items API response the rows come from. What a card
// means is `card.test.mjs`; what this suite watches is the two carriers being
// tied to one another, and the page coming back whole.
import {
  assertRow, assertRows, failureOf, loadCommand, runner,
} from './harness.mjs';
import {
  FILTERS, ITEMS_API_PATH, ORIGIN, bootstrapHtml, browserPage, item, itemsApiResponse, searchCore,
} from './carrier.mjs';

const CATALOG_PATH = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB';
const REQUESTED = `${ORIGIN}${CATALOG_PATH}?q=ddr5+32gb`;
const PAGE_2 = `${REQUESTED}&p=2`;
const API = `${ORIGIN}${ITEMS_API_PATH}`;

const { COMMAND } = await loadCommand('get-page');
const { check, assert, run } = runner();

// The document is read for the page it proves, not for its catalog: past the
// twentieth card that catalog carries stubs, which is why the rows come from the
// API below (F-089). Only a page-1 document ships a `context`, so the carrier
// spells that difference out the way Avito does (F-092).
function pageState({ page = 2, query = 'ddr5 32gb', sort = null } = {}) {
  return {
    loaderData: {
      data: {
        searchCore: searchCore({ page, query, sort }),
        filtersV2: FILTERS,
        catalog: { items: [] },
        ...(page === 1 ? { context: 'opaque-context' } : {}),
      },
    },
  };
}

const apiState = ({ items = [item()], page = 2, url = PAGE_2, core = {} } = {}) => itemsApiResponse({
  items,
  url,
  core: { page, ...core },
});

const documentRoute = (state = pageState(), overrides = {}) => ({
  match: `${ORIGIN}${CATALOG_PATH}`,
  body: bootstrapHtml(state),
  ...overrides,
});

const apiRoute = (state = apiState(), overrides = {}) => ({
  match: API,
  contentType: 'application/json',
  body: state,
  ...overrides,
});

// The API prefix has to be matched before the catalog route, because a stubbed
// route is chosen by prefix and both hang off the same origin.
const routes = (document = documentRoute(), api = apiRoute()) => [api, document];

const paginate = (routeList, args = {}) => {
  const page = browserPage(routeList);
  return { page, rows: COMMAND.run(page, { searchUrl: REQUESTED, page: 2, ...args }) };
};

check('the document proves the page and the items API answers it with the rows', async () => {
  const { page, rows } = paginate(routes());
  const returned = await rows;
  assert(page.calls.length === 2, `expected a document and one API call, got ${JSON.stringify(page.calls)}`);
  assert(page.calls[0] === PAGE_2, `the document must be the requested page, got ${page.calls[0]}`);
  assert(page.calls[1].startsWith(API), `the rows must come from the items API, got ${page.calls[1]}`);
  // The document's canonical URL is what the next command pages, not the API's.
  assert(returned[0].searchUrl === PAGE_2, `unexpected searchUrl ${returned[0].searchUrl}`);
  assertRows(COMMAND, returned);
});

// The API is asked for the page the document proved, carrying that document's
// searchCore: without the page key it answers about page 1 (F-091).
check('the API request carries the page number and the searchCore of that document', async () => {
  const { page: driven, rows } = paginate(routes());
  await rows;
  const requested = new URL(driven.calls[1]);
  assert(requested.searchParams.get('p') === '2', `page not requested: ${driven.calls[1]}`);
  assert(requested.searchParams.get('categoryId') === '101', `searchCore not carried: ${driven.calls[1]}`);
  assert(requested.searchParams.get('name') === 'ddr5 32gb', `query not carried: ${driven.calls[1]}`);
  // A deep document ships no context and the API does not need one (F-092).
  assert(!requested.searchParams.has('context'), `a context was invented: ${driven.calls[1]}`);

  const first = paginate(
    routes(documentRoute(pageState({ page: 1 })), apiRoute(apiState({ page: 1, url: REQUESTED }))),
    { page: 1 },
  );
  await first.rows;
  const firstRequest = new URL(first.page.calls[1]);
  assert(!firstRequest.searchParams.has('p'), `page 1 must be the request without p: ${first.page.calls[1]}`);
  assert(firstRequest.searchParams.get('context') === 'opaque-context',
    `a page-1 document ships a context and it must be carried: ${first.page.calls[1]}`);
});

check('page 1 is requested without p and canonicalized the same way', async () => {
  const { page, rows } = paginate(
    routes(documentRoute(pageState({ page: 1 })), apiRoute(apiState({ page: 1, url: REQUESTED }))),
    { page: 1 },
  );
  const returned = await rows;
  assert(page.calls[0] === REQUESTED, `page 1 must drop p, requested ${page.calls[0]}`);
  assert(returned[0].searchUrl === REQUESTED, `unexpected searchUrl ${returned[0].searchUrl}`);
});

check('a canonical URL that dropped a preserved parameter is drift', async () => {
  const failure = await failureOf(() => paginate(
    routes(documentRoute(pageState(), { responseUrl: `${ORIGIN}${CATALOG_PATH}?p=2` })),
  ).rows);
  assert(failure != null && /preserved search query parameters/.test(failure.message),
    `drift accepted: ${failure && failure.message}`);
});

check('searchCore reporting another page is drift, not rows', async () => {
  const driven = paginate(routes(documentRoute(pageState({ page: 1 }))));
  const failure = await failureOf(() => driven.rows);
  assert(failure != null && /unexpected page/.test(failure.message), `wrong page accepted: ${failure && failure.message}`);
  assert(driven.page.calls.length === 1,
    `the API must not be asked after the document already drifted: ${JSON.stringify(driven.page.calls)}`);
});

// The second carrier is checked against the first, because the document is what
// named the search and the API is only being asked for its rows.
check('an API answer about another page, route or search is drift', async () => {
  const cases = [
    [apiState({ page: 3 }), /items API returned an unexpected page/],
    [apiState({ url: `${ORIGIN}/moskva/telefony?q=ddr5+32gb&p=2` }), /answered on a different route/],
    [apiState({ url: `${REQUESTED}&p=7` }), /unexpected page number in its URL/],
    [apiState({ core: { categoryId: 24 } }), /preserved search field categoryId/],
  ];
  for (const [answer, expected] of cases) {
    const failure = await failureOf(() => paginate(routes(documentRoute(), apiRoute(answer))).rows);
    assert(failure != null && expected.test(failure.message),
      `an answer matching ${expected} was accepted: ${failure && failure.message}`);
  }
});

check('HTTP 429 and access challenges stop before any decoding', async () => {
  const rate = await failureOf(() => paginate(
    routes(documentRoute(pageState(), { status: 429, body: '<html><title>Доступ ограничен</title></html>' })),
  ).rows);
  assert(rate?.code === 'ACCESS', `429 not reported as access: ${rate && rate.code}`);

  // A verification page is 200 HTML with no state script, which is exactly what a
  // bootstrap that did not arrive looks like. Nothing reads the page text to tell
  // them apart — they call for the same thing.
  const challenge = await failureOf(() => paginate(routes(documentRoute(pageState(), {
    body: '<html><head><title>Доступ ограничен: проблема с IP</title></head><body>проверим, что вы человек</body></html>',
  }))).rows);
  assert(challenge?.code === 'ACCESS', `challenge not reported as access: ${challenge && challenge.code}`);

  const apiRate = await failureOf(() => paginate(
    routes(documentRoute(), apiRoute(apiState(), { status: 429, body: { 'too-many-requests': true } })),
  ).rows);
  assert(apiRate?.code === 'ACCESS', `API 429 not reported as access: ${apiRate && apiRate.code}`);
});

// The state is JSON with hundreds of Avito's own keys in it, and any of them may
// spell `captcha`. A detector reading the document as text would call this page a
// challenge — the same trap `robots.txt` already sprang once (F-044). Nothing
// reads the page text any more; a state script is either there or it is not.
check('a normal page whose state carries the word captcha is not a refusal', async () => {
  const state = pageState();
  state.loaderData.data.meta = { captchaProvider: 'none', captcha: false };
  const rows = await paginate(routes(documentRoute(state))).rows;
  assert(rows.length > 0, 'the rows must come back untouched');
});

// This command applies no filter and reads none, but a document whose schema
// stopped being a schema is not a document to hand fifty rows from.
check('a page whose filter schema stopped being one does not hand over rows', async () => {
  const state = pageState();
  state.loaderData.data.filtersV2 = { Sections: [{ Filters: 'нет фильтров' }] };
  const failure = await failureOf(() => paginate(routes(documentRoute(state))).rows);
  assert(failure?.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${failure && failure.code}`);
  assert(/filtersV2\.Sections\.0\.Filters/.test(failure.message), `the path must be named: ${failure.message}`);
});

check('a page whose catalog decodes to nothing is a typed empty result', async () => {
  const failure = await failureOf(() => paginate(routes(documentRoute(), apiRoute(apiState({ items: [] })))).rows);
  assert(failure?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing Avito put on the page is returned, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const rows = await paginate(routes(documentRoute(), apiRoute(apiState({ items })))).rows;
  assert(rows.length === 50, `expected the whole page, got ${rows.length}`);
  // Every one of them complete: that is the whole reason this command asks a
  // second carrier for rows the document already had in part (F-089).
  assert(rows.every((row) => row.descriptionPreview && row.location && row.imageCount === 2),
    'the API page must be complete on every row, not only its first twenty');
});

// Node side: --remove-reserved is a declared local predicate over the page Avito returned,
// so it never refills the page and never guesses when the flag is gone (D-024).
const CARD_ID = '8288791269';
const withReservations = (items) => routes(documentRoute(), apiRoute(apiState({ items })));

check('remove-reserved drops the reserved rows of the requested page', async () => {
  const items = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: CARD_ID, isReserved: false }),
    item({ id: '8220283533', isReserved: true }),
  ];
  const rows = await paginate(withReservations(items), { 'remove-reserved': true }).rows;
  assert(rows.length === 1 && rows[0].itemId === CARD_ID, `unexpected rows: ${JSON.stringify(rows.map((r) => r.itemId))}`);
  assert(!('isReserved' in rows[0]) && !('reserved' in rows[0]), 'the flag must stay out of the row contract');
  assertRow(COMMAND, rows[0]);

  const whole = await paginate(withReservations(items)).rows;
  assert(whole.length === 3, 'without the flag the page must come back whole');
});

check('an all-reserved page is empty and a vanished flag refuses the filter', async () => {
  const allReserved = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: '8220283533', isReserved: true }),
  ];
  const empty = await failureOf(() => paginate(withReservations(allReserved), { 'remove-reserved': true }).rows);
  assert(empty?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${empty && empty.code}`);
  assert(/\(2\) is reserved/.test(empty.message), `page size not reported: ${empty.message}`);

  const drifted = [item({ id: CARD_ID }), item({ id: '8234297329', isReserved: null })];
  const refused = await failureOf(() => paginate(withReservations(drifted), { 'remove-reserved': true }).rows);
  assert(refused?.code === 'COMMAND_EXEC', `drifted flag accepted: ${refused && refused.code}`);
  assert(/reservation flag/.test(refused.message), `unexpected message: ${refused.message}`);
});

export default await run('get-page');
