// Offline end-to-end for the browser half in src/browser/commands/search.mjs, against a synthetic
// Avito SSR carrier and a stubbed fetch.
import { runner } from './harness.mjs';
import { searchContext } from '../src/browser/commands/search.mjs';
import {
  FILTERS, ORIGIN, bootstrapHtml, evaluateRunner, item, makeFetch, searchCore,
} from './carrier.mjs';

const CANONICAL = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB?localPriority=1&q=ddr5+32gb';
const ABSORBED = '/moskva/telefony/mobilnye_telefony/apple-ASgB?cd=1&context=H4sIAAA';

function catalogState({ items = [item()], query = 'ddr5 32gb' } = {}) {
  return {
    loaderData: {
      data: {
        searchCore: searchCore({ query }),
        filtersV2: FILTERS,
        catalog: { items },
        context: 'opaque-context',
      },
    },
  };
}

const redirectState = (target) => ({ loaderData: { redirect: target, data: { status: 200, redirected: true, url: target } } });

const runEvaluate = evaluateRunner(searchContext);

const baseArgs = (overrides = {}) => ({
  queryUrl: `${ORIGIN}/?q=ddr5+32gb`,
  query: 'ddr5 32gb',
  // Only geo refines the initial search now: price, seller, delivery, local priority and
  // sort became ordinary keys of `avito apply-filters` (D-031).
  refinement: {
    apply: false, locationRequested: false, locationId: null, geoMode: null, geoIds: null,
    radiusRequested: false, radius: null, coords: null, latitude: null, longitude: null,
  },
  MAX_PARAMS: 400,
  MAX_PARAM_VALUES: 2000,
  forceFreshSchema: false,
  ...overrides,
});

const { check, assert, run } = runner();

check('two hops decode SSR rows with the visible price, metro line and card text', async () => {
  const { fetch, calls } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState()), responseUrl: ORIGIN + CANONICAL },
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.refined === false, 'default branch reported refinement');
  assert(calls.length === 2, `expected two documents, got ${calls.length}`);
  assert(calls[1] === ORIGIN + CANONICAL, `second hop used ${calls[1]}`);
  assert(result.resultSearchUrl === ORIGIN + CANONICAL, `unexpected searchUrl ${result.resultSearchUrl}`);
  const row = result.resultRows[0];
  assert(row.apiPrice === 43691, `price should be the visible bonus price, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Китай-город, до 5 мин.', `location should match the card, got ${row.apiLocation}`);
  assert(row.apiDescriptionPreview.startsWith('Авитодоставка открыта'), 'description not decoded');
  assert(row.apiSeller.name === 'AMD INTEL' && row.apiSeller.reviewsCount === 2015, 'seller not decoded');
  assert(row.apiImageCount === 2 && row.apiUrl === `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_7881841669`, 'photo count/url not decoded');
});

check('a card without a bonus price or geo reference falls back to base fields', async () => {
  const plain = item({ id: '8290916337', visiblePrice: null, geoReference: null, locationName: 'Казань' });
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState({ items: [plain] })), responseUrl: ORIGIN + CANONICAL },
  ]);
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
  const routes = (rows) => [
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState({ items: rows })), responseUrl: ORIGIN + CANONICAL },
  ];
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
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState({ items: [anonymous] })), responseUrl: ORIGIN + CANONICAL },
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const seller = result.resultRows[0].apiSeller;
  assert(seller.name === null, `the name must stay null, got ${JSON.stringify(seller)}`);
  assert(seller.rating === 4.8 && seller.reviewsCount === 19, `rating must survive, got ${JSON.stringify(seller)}`);
});

check('an absorbed query is accepted and a foreign q is rejected', async () => {
  const absorbed = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(ABSORBED)) },
    { match: `${ORIGIN}/moskva/telefony`, body: bootstrapHtml(catalogState({ query: '' })), responseUrl: ORIGIN + ABSORBED },
  ]);
  const ok = await runEvaluate(baseArgs({ queryUrl: `${ORIGIN}/?q=iphone`, query: 'iphone' }), absorbed.fetch);
  assert(ok.success === true, `absorbed query rejected: ${ok.message}`);

  const foreign = makeFetch([{ match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState('/moskva/telefony?q=android')) }]);
  const bad = await runEvaluate(baseArgs({ queryUrl: `${ORIGIN}/?q=iphone`, query: 'iphone' }), foreign.fetch);
  assert(bad.success === false && bad.stage === 'submit' && /different query/.test(bad.message), `foreign q accepted: ${JSON.stringify(bad)}`);
  assert(foreign.calls.length === 1, 'second hop ran despite a failed guard');
});

check('a homepage target never passes as a search result', async () => {
  const { fetch, calls } = makeFetch([{ match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState('/')) }]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && /did not canonicalize/.test(result.message), `homepage accepted: ${JSON.stringify(result)}`);
  assert(calls.length === 1, 'second hop ran for a homepage target');
});

check('HTTP 429 and access challenges stop on the first hop', async () => {
  const rate = makeFetch([{ match: `${ORIGIN}/?q=`, status: 429, body: '<html><title>Доступ ограничен</title></html>' }]);
  const rateResult = await runEvaluate(baseArgs(), rate.fetch);
  assert(rateResult.success === false && rateResult.code === 'access', `429 not reported as access: ${JSON.stringify(rateResult)}`);

  const challenge = makeFetch([{ match: `${ORIGIN}/?q=`, body: '<html><head><title>Доступ ограничен: проблема с IP</title></head><body>проверим, что вы человек</body></html>' }]);
  const challengeResult = await runEvaluate(baseArgs(), challenge.fetch);
  assert(challengeResult.success === false && challengeResult.code === 'access', `challenge not reported: ${JSON.stringify(challengeResult)}`);
});

check('an empty catalog is a typed empty result, not a shape error', async () => {
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState({ items: [] })), responseUrl: ORIGIN + CANONICAL },
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'empty', `unexpected: ${JSON.stringify(result)}`);
});

// The city cannot be applied by editing the URL, so an explicit location is the one thing
// that still costs this command an items API request.
check('a location refinement adds exactly one items API request and uses its rows', async () => {
  const apiRow = item({ id: '8299623583', visiblePrice: 25000, basePrice: 25500 });
  let apiUrl = null;
  const { fetch, calls } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState()), responseUrl: ORIGIN + CANONICAL },
    {
      match: `${ORIGIN}/web/1/js/items`,
      contentType: 'application/json',
      body: (url) => {
        apiUrl = url;
        return {
          searchCore: {
            page: 1, query: 'ddr5 32gb', locationId: 654918, locationName: 'Казань',
            categoryId: 101, rootCategoryId: 1, verticalCategoryId: 2, params: {}, sort: null,
          },
          filtersV2: FILTERS,
          catalog: { items: [apiRow] },
          url: `${ORIGIN}${CANONICAL}&locationId=654918`,
        };
      },
    },
  ]);
  const args = baseArgs();
  args.refinement = { ...args.refinement, apply: true, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === true, `refinement failed: ${result.message}`);
  assert(result.refined === true && result.resultRows[0].apiItemId === '8299623583', 'API rows not used');
  assert(result.resultRows[0].apiPrice === 25000, 'refined rows must use the same visible-price decoder');
  assert(calls.filter((c) => c.includes('/web/1/js/items')).length === 1, 'more than one API request');
  assert(apiUrl.includes('locationId=654918') && apiUrl.includes('spaFlow=true') && apiUrl.includes('context=opaque-context'), `unexpected API URL: ${apiUrl}`);
  assert(result.resultSearchUrl === `${ORIGIN}${CANONICAL}&locationId=654918`, 'server URL not returned');
});

// The catalog filters of the landed route belong to `avito apply-filters`, so this command
// must carry them untouched and stop if Avito changes one behind its back.
check('a catalog filter changed by Avito during a location refinement is drift', async () => {
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState()), responseUrl: ORIGIN + CANONICAL },
    {
      match: `${ORIGIN}/web/1/js/items`,
      contentType: 'application/json',
      body: () => ({
        searchCore: {
          page: 1, query: 'ddr5 32gb', locationId: 654918, locationName: 'Казань',
          categoryId: 101, rootCategoryId: 1, verticalCategoryId: 2, params: {}, sort: '104',
        },
        filtersV2: FILTERS,
        catalog: { items: [item()] },
        url: `${ORIGIN}${CANONICAL}&locationId=654918`,
      }),
    },
  ]);
  const args = baseArgs();
  args.refinement = { ...args.refinement, apply: true, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === false && /preserved search field sort/.test(result.message),
    `a changed sort must be drift: ${JSON.stringify(result)}`);
});

check('the API is never called when the guard fails', async () => {
  const { fetch, calls } = makeFetch([{ match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState('/')) }]);
  const args = baseArgs();
  args.refinement = { ...args.refinement, apply: true, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === false, 'guard passed a homepage target');
  assert(calls.every((c) => !c.includes('/web/1/js/items')), 'API called after a failed guard');
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing Avito put on the page is returned, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState({ items })), responseUrl: ORIGIN + CANONICAL },
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows.length === 50, `expected the whole page, got ${result.resultRows.length}`);
});

// A row carries how many photos the card has and not one photo URL: the sizes are
// Avito's vocabulary and the originals belong to `get-item`. A card whose photo is
// served from outside the photo CDN — every résumé — is readable because of that (F-087).
check('the row counts the card photos, wherever they are hosted', async () => {
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState()), responseUrl: ORIGIN + CANONICAL },
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows[0].apiImageCount === 2,
    `the card ships two photos, got ${result.resultRows[0].apiImageCount}`);

  const elsewhere = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    {
      match: `${ORIGIN}/moskva/tovary`,
      body: bootstrapHtml(catalogState({
        items: [item({ images: [{ '208x208': 'https://www.avito.st/s/common/resume-stub.svg' }] })],
      })),
      responseUrl: ORIGIN + CANONICAL,
    },
  ]);
  const elsewhereResult = await runEvaluate(baseArgs(), elsewhere.fetch);
  assert(elsewhereResult.success === true, 'a photo outside the CDN must no longer refuse the page');
  assert(elsewhereResult.resultRows[0].apiImageCount === 1, 'the photo must still be counted');

  const unsent = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    {
      match: `${ORIGIN}/moskva/tovary`,
      body: bootstrapHtml(catalogState({ items: [item({ images: null })] })),
      responseUrl: ORIGIN + CANONICAL,
    },
  ]);
  const unsentResult = await runEvaluate(baseArgs(), unsent.fetch);
  assert(unsentResult.resultRows[0].apiImageCount === null,
    'a card Avito sent without its photo block must not count as zero (F-089)');

  const malformed = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    {
      match: `${ORIGIN}/moskva/tovary`,
      body: bootstrapHtml(catalogState({ items: [item({ images: 'one photo' })] })),
      responseUrl: ORIGIN + CANONICAL,
    },
  ]);
  // A photo list that is not a list is schema drift: the decoder must stop the command
  // instead of reporting a listing with no photos.
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
  const { fetch } = makeFetch([
    { match: `${ORIGIN}/?q=`, body: bootstrapHtml(redirectState(CANONICAL)) },
    { match: `${ORIGIN}/moskva/tovary`, body: bootstrapHtml(catalogState({ items })), responseUrl: ORIGIN + CANONICAL },
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows.length === 3, 'the flag must not drop rows inside the decoder');
  assert(result.resultRows[0].apiReserved === true, 'a reserved card must decode to true');
  assert(result.resultRows[1].apiReserved === false, 'an available card must decode to false');
  assert(result.resultRows[2].apiReserved === null, 'a missing flag must stay null, not become false');
});

export default await run('search context (browser side)');
