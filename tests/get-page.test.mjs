// Offline end-to-end for the browser-side pagination context: runs the real browser half
// from src/browser/commands/get-page.mjs against a synthetic Avito SSR carrier and a stubbed fetch.
import { assertRow, loadCommand, runner } from './harness.mjs';
import {
  FILTERS, ORIGIN, bootstrapHtml, evaluateRunner, item, makeFetch, searchCore,
} from './carrier.mjs';
import { paginate } from '../src/browser/commands/get-page.mjs';

const CATALOG_PATH = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB';
const REQUESTED = `${ORIGIN}${CATALOG_PATH}?q=ddr5+32gb`;
const PAGE_2 = `${REQUESTED}&p=2`;

function pageState({ items = [item()], page = 2, query = 'ddr5 32gb', sort = null } = {}) {
  return {
    loaderData: {
      data: {
        searchCore: searchCore({ page, query, sort }),
        filtersV2: FILTERS,
        catalog: { items },
      },
    },
  };
}

const documentRoute = (state, overrides = {}) => ({
  match: `${ORIGIN}${CATALOG_PATH}`,
  body: bootstrapHtml(state),
  ...overrides,
});

const runEvaluate = evaluateRunner(paginate);

const baseArgs = (overrides = {}) => ({
  requestedUrl: REQUESTED,
  requestedPage: 2,
  MAX_FILTERS: 400,
  MAX_PARAMS: 400,
  ...overrides,
});

const { check, assert, run } = runner();

check('one document decodes page-2 rows with the visible price, metro line and card text', async () => {
  const { fetch, calls } = makeFetch([documentRoute(pageState())]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls.length === 1 && calls[0] === PAGE_2, `expected one page-2 document, got ${JSON.stringify(calls)}`);
  assert(result.resultSearchUrl === PAGE_2, `unexpected searchUrl ${result.resultSearchUrl}`);
  const row = result.resultRows[0];
  assert(row.apiPrice === 43691, `price should be the visible bonus price, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Китай-город, до 5 мин.', `location should match the card, got ${row.apiLocation}`);
  // The SSR carrier leaves the flat description empty, so this column can only
  // come from the visible decoder.
  assert(row.apiDescriptionPreview?.startsWith('Авитодоставка открыта'), `description not decoded: ${row.apiDescriptionPreview}`);
  assert(row.apiSeller.name === 'AMD INTEL' && row.apiSeller.reviewsCount === 2015, 'seller not decoded');
  assert(row.apiImageCount === 2 && row.apiUrl === `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_7881841669`, 'photo count/url not decoded');
});

check('a card without a bonus price or geo reference falls back to base fields', async () => {
  const plain = item({ id: '8290916337', visiblePrice: null, geoReference: null, locationName: 'Казань' });
  const { fetch } = makeFetch([documentRoute(pageState({ items: [plain] }))]);
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
  const routes = (rows) => [documentRoute(pageState({ items: rows }))];
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

// Anonymously Avito ships no seller-info step for a private seller, so the name is null
// while the flat rating still describes the same seller. The name is nullable by contract,
// and a null here must stay a null instead of becoming a guessed one (F-049).
check('a card without the seller-info step keeps its rating and returns no name', async () => {
  const anonymous = item({ id: '8226762910', sellerInfo: false, rating: { score: 4.8, summary: '19 отзывов' } });
  const { fetch } = makeFetch([documentRoute(pageState({ items: [anonymous] }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const seller = result.resultRows[0].apiSeller;
  assert(seller.name === null, `the name must stay null, got ${JSON.stringify(seller)}`);
  assert(seller.rating === 4.8 && seller.reviewsCount === 19, `rating must survive, got ${JSON.stringify(seller)}`);
});

check('page 1 is requested without p and canonicalized the same way', async () => {
  const { fetch, calls } = makeFetch([documentRoute(pageState({ page: 1 }))]);
  const result = await runEvaluate(baseArgs({ requestedPage: 1 }), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls[0] === REQUESTED, `page 1 must drop p, requested ${calls[0]}`);
  assert(result.resultSearchUrl === REQUESTED, `unexpected searchUrl ${result.resultSearchUrl}`);
});

check('a canonical URL that dropped a preserved parameter is drift', async () => {
  const { fetch } = makeFetch([documentRoute(pageState(), { responseUrl: `${ORIGIN}${CATALOG_PATH}?p=2` })]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `drift accepted: ${JSON.stringify(result)}`);
  assert(/preserved search query parameters/.test(result.message), `unexpected message: ${result.message}`);
});

check('searchCore reporting another page is drift, not rows', async () => {
  const { fetch } = makeFetch([documentRoute(pageState({ page: 1 }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `wrong page accepted: ${JSON.stringify(result)}`);
  assert(/unexpected page/.test(result.message), `unexpected message: ${result.message}`);
});

check('HTTP 429 and access challenges stop before any decoding', async () => {
  const rate = makeFetch([documentRoute(pageState(), { status: 429, body: '<html><title>Доступ ограничен</title></html>' })]);
  const rateResult = await runEvaluate(baseArgs(), rate.fetch);
  assert(rateResult.success === false && rateResult.code === 'access', `429 not reported as access: ${JSON.stringify(rateResult)}`);

  const challenge = makeFetch([documentRoute(pageState(), {
    body: '<html><head><title>Доступ ограничен: проблема с IP</title></head><body>проверим, что вы человек</body></html>',
  })]);
  const challengeResult = await runEvaluate(baseArgs(), challenge.fetch);
  assert(challengeResult.success === false && challengeResult.code === 'access', `challenge not reported: ${JSON.stringify(challengeResult)}`);
});

check('a page without listings is a typed empty result', async () => {
  const { fetch } = makeFetch([documentRoute(pageState({ items: [] }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'empty', `unexpected: ${JSON.stringify(result)}`);
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing Avito put on the page is returned, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const { fetch } = makeFetch([documentRoute(pageState({ items }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows.length === 50, `expected the whole page, got ${result.resultRows.length}`);
});

// A row carries how many photos the card has and not one photo URL: the sizes are
// Avito's vocabulary and the originals belong to `get-item`. A card whose photo is
// served from outside the photo CDN — every résumé — is readable because of that (F-087).
check('the row counts the card photos, wherever they are hosted', async () => {
  const { fetch } = makeFetch([documentRoute(pageState())]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows[0].apiImageCount === 2,
    `the card ships two photos, got ${result.resultRows[0].apiImageCount}`);

  const elsewhere = makeFetch([documentRoute(pageState({
    items: [item({ images: [{ '208x208': 'https://www.avito.st/s/common/resume-stub.svg' }] })],
  }))]);
  const elsewhereResult = await runEvaluate(baseArgs(), elsewhere.fetch);
  assert(elsewhereResult.success === true, 'a photo outside the CDN must no longer refuse the page');
  assert(elsewhereResult.resultRows[0].apiImageCount === 1, 'the photo must still be counted');

  const malformed = makeFetch([documentRoute(pageState({ items: [item({ images: 'one photo' })] }))]);
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
  const { fetch } = makeFetch([documentRoute(pageState({ items }))]);
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
