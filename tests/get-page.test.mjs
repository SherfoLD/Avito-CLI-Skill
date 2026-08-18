// Offline end-to-end for the browser-side pagination context: runs the real browser half
// from src/browser/commands/get-page.mjs against a synthetic Avito SSR carrier plus the
// items API response the rows now come from.
import { assertRow, loadCommand, runner } from './harness.mjs';
import {
  FILTERS, ITEMS_API_PATH, ORIGIN, bootstrapHtml, evaluateRunner, item, itemsApiResponse,
  makeFetch, searchCore,
} from './carrier.mjs';
import { paginate } from '../src/browser/commands/get-page.mjs';

const CATALOG_PATH = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB';
const REQUESTED = `${ORIGIN}${CATALOG_PATH}?q=ddr5+32gb`;
const PAGE_2 = `${REQUESTED}&p=2`;
const API = `${ORIGIN}${ITEMS_API_PATH}`;

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

const runEvaluate = evaluateRunner(paginate);

const baseArgs = (overrides = {}) => ({
  requestedUrl: REQUESTED,
  requestedPage: 2,
  MAX_FILTERS: 400,
  MAX_PARAMS: 400,
  MAX_PARAM_VALUES: 2000,
  ...overrides,
});

const { check, assert, run } = runner();

check('the document proves the page and the items API answers it with the rows', async () => {
  const { fetch, calls } = makeFetch(routes());
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls.length === 2, `expected a document and one API call, got ${JSON.stringify(calls)}`);
  assert(calls[0] === PAGE_2, `the document must be the requested page, got ${calls[0]}`);
  assert(calls[1].startsWith(API), `the rows must come from the items API, got ${calls[1]}`);
  // The document's canonical URL is what the next command pages, not the API's.
  assert(result.resultSearchUrl === PAGE_2, `unexpected searchUrl ${result.resultSearchUrl}`);
  const row = result.resultRows[0];
  assert(row.apiPrice === 43691, `price should be the visible bonus price, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Китай-город, до 5 мин.', `location should match the card, got ${row.apiLocation}`);
  assert(row.apiDescriptionPreview?.startsWith('Авитодоставка открыта'), `description not decoded: ${row.apiDescriptionPreview}`);
  assert(row.apiSeller.name === 'AMD INTEL' && row.apiSeller.reviewsCount === 2015, 'seller not decoded');
  assert(row.apiImageCount === 2 && row.apiUrl === `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_7881841669`, 'photo count/url not decoded');
});

// The API is asked for the page the document proved, carrying that document's
// searchCore: without the page key it answers about page 1 (F-091).
check('the API request carries the page number and the searchCore of that document', async () => {
  const { fetch, calls } = makeFetch(routes());
  await runEvaluate(baseArgs(), fetch);
  const requested = new URL(calls[1]);
  assert(requested.searchParams.get('p') === '2', `page not requested: ${calls[1]}`);
  assert(requested.searchParams.get('categoryId') === '101', `searchCore not carried: ${calls[1]}`);
  assert(requested.searchParams.get('name') === 'ddr5 32gb', `query not carried: ${calls[1]}`);
  // A deep document ships no context and the API does not need one (F-092).
  assert(!requested.searchParams.has('context'), `a context was invented: ${calls[1]}`);

  const first = makeFetch(routes(documentRoute(pageState({ page: 1 })), apiRoute(apiState({ page: 1, url: REQUESTED }))));
  await runEvaluate(baseArgs({ requestedPage: 1 }), first.fetch);
  const firstRequest = new URL(first.calls[1]);
  assert(!firstRequest.searchParams.has('p'), `page 1 must be the request without p: ${first.calls[1]}`);
  assert(firstRequest.searchParams.get('context') === 'opaque-context',
    `a page-1 document ships a context and it must be carried: ${first.calls[1]}`);
});

check('a card without a bonus price or geo reference falls back to base fields', async () => {
  const plain = item({ id: '8290916337', visiblePrice: null, geoReference: null, locationName: 'Казань' });
  const { fetch } = makeFetch(routes(documentRoute(), apiRoute(apiState({ items: [plain] }))));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows[0].apiPrice === 43800, `expected base price, got ${result.resultRows[0].apiPrice}`);
  assert(result.resultRows[0].apiLocation === 'Казань', `expected city, got ${result.resultRows[0].apiLocation}`);
});

// Avito ships the moment it sorts by on every card and prints that same moment on the
// listing page; get-item sees only the rendered string, so the exact instant belongs to the
// row (F-059). A card without the stamp keeps its row and reports null, while a stamp in a
// shape no clock produces is drift and stops the call.
check('the publication stamp decodes to the instant Avito prints, and drift stops the call', async () => {
  const withItems = (rows) => routes(documentRoute(), apiRoute(apiState({ items: rows })));
  const result = await runEvaluate(baseArgs(), makeFetch(withItems([item()])).fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows[0].apiPublished === '2026-08-13T23:15:41Z', `expected the UTC instant, got ${result.resultRows[0].apiPublished}`);

  const absent = await runEvaluate(baseArgs(), makeFetch(withItems([item({ sortTimeStamp: null })])).fetch);
  assert(absent.success === true && absent.resultRows[0].apiPublished === null, 'a card without the stamp must keep its row');

  for (const drift of [1786662941, 'вчера', -1, 1.5]) {
    let stopped = false;
    try {
      await runEvaluate(baseArgs(), makeFetch(withItems([item({ sortTimeStamp: drift })])).fetch);
    } catch (error) {
      stopped = /publication stamp/.test(String(error?.message ?? error));
    }
    assert(stopped, `a stamp of ${JSON.stringify(drift)} must stop the call`);
  }
});

// Anonymously Avito ships no seller-info step for a private seller, so the name is null
// while the flat rating still describes the same seller. The name is nullable by contract,
// and a null here must stay a null instead of becoming a guessed one (F-049).
check('a card without the seller-info step keeps its rating and returns no name', async () => {
  const anonymous = item({ id: '8226762910', sellerInfo: false, rating: { score: 4.8, summary: '19 отзывов' } });
  const { fetch } = makeFetch(routes(documentRoute(), apiRoute(apiState({ items: [anonymous] }))));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const seller = result.resultRows[0].apiSeller;
  assert(seller.name === null, `the name must stay null, got ${JSON.stringify(seller)}`);
  assert(seller.rating === 4.8 && seller.reviewsCount === 19, `rating must survive, got ${JSON.stringify(seller)}`);
});

check('page 1 is requested without p and canonicalized the same way', async () => {
  const { fetch, calls } = makeFetch(
    routes(documentRoute(pageState({ page: 1 })), apiRoute(apiState({ page: 1, url: REQUESTED }))),
  );
  const result = await runEvaluate(baseArgs({ requestedPage: 1 }), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls[0] === REQUESTED, `page 1 must drop p, requested ${calls[0]}`);
  assert(result.resultSearchUrl === REQUESTED, `unexpected searchUrl ${result.resultSearchUrl}`);
});

check('a canonical URL that dropped a preserved parameter is drift', async () => {
  const { fetch } = makeFetch(routes(documentRoute(pageState(), { responseUrl: `${ORIGIN}${CATALOG_PATH}?p=2` })));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `drift accepted: ${JSON.stringify(result)}`);
  assert(/preserved search query parameters/.test(result.message), `unexpected message: ${result.message}`);
});

check('searchCore reporting another page is drift, not rows', async () => {
  const { fetch, calls } = makeFetch(routes(documentRoute(pageState({ page: 1 }))));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `wrong page accepted: ${JSON.stringify(result)}`);
  assert(/unexpected page/.test(result.message), `unexpected message: ${result.message}`);
  assert(calls.length === 1, `the API must not be asked after the document already drifted: ${JSON.stringify(calls)}`);
});

// The second carrier is checked against the first, because the document is what
// named the search and the API is only being asked for its rows.
check('an API answer about another page, route or search is drift', async () => {
  const wrongPage = makeFetch(routes(documentRoute(), apiRoute(apiState({ page: 3 }))));
  const wrongPageResult = await runEvaluate(baseArgs(), wrongPage.fetch);
  assert(wrongPageResult.success === false && /items API returned an unexpected page/.test(wrongPageResult.message),
    `wrong API page accepted: ${JSON.stringify(wrongPageResult)}`);

  const wrongUrl = makeFetch(routes(documentRoute(), apiRoute(apiState({ url: `${ORIGIN}/moskva/telefony?q=ddr5+32gb&p=2` }))));
  const wrongUrlResult = await runEvaluate(baseArgs(), wrongUrl.fetch);
  assert(wrongUrlResult.success === false && /answered on a different route/.test(wrongUrlResult.message),
    `wrong API route accepted: ${JSON.stringify(wrongUrlResult)}`);

  const wrongUrlPage = makeFetch(routes(documentRoute(), apiRoute(apiState({ url: `${REQUESTED}&p=7` }))));
  const wrongUrlPageResult = await runEvaluate(baseArgs(), wrongUrlPage.fetch);
  assert(wrongUrlPageResult.success === false && /unexpected page number in its URL/.test(wrongUrlPageResult.message),
    `wrong API URL page accepted: ${JSON.stringify(wrongUrlPageResult)}`);

  const wrongSearch = makeFetch(routes(documentRoute(), apiRoute(apiState({ core: { categoryId: 24 } }))));
  const wrongSearchResult = await runEvaluate(baseArgs(), wrongSearch.fetch);
  assert(wrongSearchResult.success === false && /preserved search field categoryId/.test(wrongSearchResult.message),
    `a changed category accepted: ${JSON.stringify(wrongSearchResult)}`);
});

check('HTTP 429 and access challenges stop before any decoding', async () => {
  const rate = makeFetch(routes(documentRoute(pageState(), { status: 429, body: '<html><title>Доступ ограничен</title></html>' })));
  const rateResult = await runEvaluate(baseArgs(), rate.fetch);
  assert(rateResult.success === false && rateResult.code === 'access', `429 not reported as access: ${JSON.stringify(rateResult)}`);

  const challenge = makeFetch(routes(documentRoute(pageState(), {
    body: '<html><head><title>Доступ ограничен: проблема с IP</title></head><body>проверим, что вы человек</body></html>',
  })));
  const challengeResult = await runEvaluate(baseArgs(), challenge.fetch);
  assert(challengeResult.success === false && challengeResult.code === 'access', `challenge not reported: ${JSON.stringify(challengeResult)}`);

  const apiRate = makeFetch(routes(documentRoute(), apiRoute(apiState(), { status: 429, body: { 'too-many-requests': true } })));
  const apiRateResult = await runEvaluate(baseArgs(), apiRate.fetch);
  assert(apiRateResult.success === false && apiRateResult.code === 'access', `API 429 not reported: ${JSON.stringify(apiRateResult)}`);
});

check('a page without listings is a typed empty result', async () => {
  const { fetch } = makeFetch(routes(documentRoute(), apiRoute(apiState({ items: [] }))));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'empty', `unexpected: ${JSON.stringify(result)}`);
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing Avito put on the page is returned, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const { fetch } = makeFetch(routes(documentRoute(), apiRoute(apiState({ items }))));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows.length === 50, `expected the whole page, got ${result.resultRows.length}`);
  // Every one of them complete: that is the whole reason this command asks a
  // second carrier for rows the document already had in part (F-089).
  assert(result.resultRows.every((row) => row.apiDescriptionPreview && row.apiLocation && row.apiImageCount === 2),
    'the API page must be complete on every row, not only its first twenty');
});

// A row carries how many photos the card has and not one photo URL: the sizes are
// Avito's vocabulary and the originals belong to `get-item`. A card whose photo is
// served from outside the photo CDN — every résumé — is readable because of that (F-087).
check('the row counts the card photos, wherever they are hosted', async () => {
  const { fetch } = makeFetch(routes());
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows[0].apiImageCount === 2,
    `the card ships two photos, got ${result.resultRows[0].apiImageCount}`);

  const elsewhere = makeFetch(routes(documentRoute(), apiRoute(apiState({
    items: [item({ images: [{ '208x208': 'https://www.avito.st/s/common/resume-stub.svg' }] })],
  }))));
  const elsewhereResult = await runEvaluate(baseArgs(), elsewhere.fetch);
  assert(elsewhereResult.success === true, 'a photo outside the CDN must no longer refuse the page');
  assert(elsewhereResult.resultRows[0].apiImageCount === 1, 'the photo must still be counted');

  const malformed = makeFetch(routes(documentRoute(), apiRoute(apiState({ items: [item({ images: 'one photo' })] }))));
  let stopped = false;
  try {
    await runEvaluate(baseArgs(), malformed.fetch);
  } catch (error) {
    stopped = /images are malformed/.test(String(error?.message ?? error));
  }
  assert(stopped, 'a malformed photo list must fail closed, not count zero');
});

check('the reservation flag is decoded from the card, and an absent key stays null', async () => {
  const items = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: '8288791269', isReserved: false }),
    item({ id: '8234297329', isReserved: null }),
  ];
  const { fetch } = makeFetch(routes(documentRoute(), apiRoute(apiState({ items }))));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows.length === 3, 'the flag must not drop rows inside the decoder');
  assert(result.resultRows[0].apiReserved === true, 'a reserved card must decode to true');
  assert(result.resultRows[1].apiReserved === false, 'an available card must decode to false');
  assert(result.resultRows[2].apiReserved === null, 'a missing flag must stay null, not become false');
});

// Node side: --remove-reserved is a declared local predicate over the page Avito returned,
// so it never refills the page and never guesses when the flag is gone (D-024).
const { COMMAND } = await loadCommand('get-page');

const observedPage = (rows) => ({
  success: true,
  resultSearchLocation: 'Москва',
  resultSearchUrl: PAGE_2,
  resultRows: rows,
});

const pageStub = (observed) => ({
  goto: async () => {},
  wait: async () => {},
  evaluateWithArgs: async () => observed,
});

const ROW = {
  apiItemId: '8288791269',
  apiTitle: 'iPhone 11, 128 ГБ',
  apiPrice: 25000,
  apiMinPrice: null,
  apiHasPriceList: false,
  apiLocation: 'Москва',
  apiDescriptionPreview: 'Состояние отличное',
  apiPublished: null,
  apiSeller: { name: 'AMD INTEL', rating: 5, reviewsCount: 2015 },
  apiImageCount: 0,
  apiReserved: false,
  apiUrl: `${ORIGIN}/moskva/telefony/iphone_11_128_gb_8288791269`,
};

check('remove-reserved drops the reserved rows of the requested page', async () => {
  const rows = [
    { ...ROW, apiItemId: '8329291056', apiReserved: true },
    ROW,
    { ...ROW, apiItemId: '8220283533', apiReserved: true },
  ];
  const result = await COMMAND.run(pageStub(observedPage(rows)), {
    searchUrl: REQUESTED, page: 2, 'remove-reserved': true,
  });
  assert(result.length === 1 && result[0].itemId === ROW.apiItemId, `unexpected rows: ${JSON.stringify(result.map((r) => r.itemId))}`);
  assert(!('isReserved' in result[0]), 'the flag must stay out of the row contract');
  assertRow(COMMAND, result[0]);

  const whole = await COMMAND.run(pageStub(observedPage(rows)), { searchUrl: REQUESTED, page: 2 });
  assert(whole.length === 3, 'without the flag the page must come back whole');
});

check('an all-reserved page is empty and a vanished flag refuses the filter', async () => {
  const allReserved = [
    { ...ROW, apiItemId: '8329291056', apiReserved: true },
    { ...ROW, apiItemId: '8220283533', apiReserved: true },
  ];
  let failure = null;
  try {
    await COMMAND.run(pageStub(observedPage(allReserved)), { searchUrl: REQUESTED, page: 2, 'remove-reserved': true });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
  assert(/\(2\) is reserved/.test(failure.message), `page size not reported: ${failure && failure.message}`);

  const drifted = [ROW, { ...ROW, apiItemId: '8234297329', apiReserved: null }];
  let refused = null;
  try {
    await COMMAND.run(pageStub(observedPage(drifted)), { searchUrl: REQUESTED, page: 2, 'remove-reserved': true });
  } catch (error) { refused = error; }
  assert(refused != null && refused.code === 'COMMAND_EXEC', `drifted flag accepted: ${refused && refused.code}`);
  assert(/reservation flag/.test(refused.message), `unexpected message: ${refused && refused.message}`);
});

export default await run('page context (browser side)');
