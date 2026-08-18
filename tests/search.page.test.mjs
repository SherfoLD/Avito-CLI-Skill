// Offline end-to-end for the browser half in src/browser/commands/search.mjs, against a synthetic
// Avito SSR carrier plus the items API response the rows come from.
import { runner } from './harness.mjs';
import { searchContext } from '../src/browser/commands/search.mjs';
import {
  FILTERS, ITEMS_API_PATH, ORIGIN, bootstrapHtml, evaluateRunner, item, itemsApiResponse,
  makeFetch, searchCore,
} from './carrier.mjs';

const CANONICAL = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB?localPriority=1&q=ddr5+32gb';
const ABSORBED = '/moskva/telefony/mobilnye_telefony/apple-ASgB?cd=1&context=H4sIAAA';
const API = `${ORIGIN}${ITEMS_API_PATH}`;

// The landed document names the search and ships the context that addresses the
// API; its own catalog is never read, being the twenty-complete-cards carrier (F-089).
function catalogState({ query = 'ddr5 32gb', core = {} } = {}) {
  return {
    loaderData: {
      data: {
        searchCore: searchCore({ query, ...core }),
        filtersV2: FILTERS,
        context: 'opaque-context',
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

const runEvaluate = evaluateRunner(searchContext);

const baseArgs = (overrides = {}) => ({
  queryUrl: `${ORIGIN}/?q=ddr5+32gb`,
  query: 'ddr5 32gb',
  // Only geo refines the initial search: price, seller, delivery, local priority and
  // sort became ordinary keys of `avito apply-filters` (D-031).
  refinement: {
    locationRequested: false, locationId: null, geoMode: null, geoIds: null,
    radiusRequested: false, radius: null, coords: null, latitude: null, longitude: null,
  },
  MAX_PARAMS: 400,
  MAX_PARAM_VALUES: 2000,
  forceFreshSchema: false,
  ...overrides,
});

const { check, assert, run } = runner();

check('two document hops name the search and the items API answers it with the rows', async () => {
  const { fetch, calls } = makeFetch(routes());
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls.length === 3, `expected two documents and one API call, got ${JSON.stringify(calls)}`);
  assert(calls[1] === ORIGIN + CANONICAL, `second hop used ${calls[1]}`);
  assert(calls[2].startsWith(API), `the rows must come from the items API, got ${calls[2]}`);
  assert(result.resultSearchUrl === ORIGIN + CANONICAL, `unexpected searchUrl ${result.resultSearchUrl}`);
  const row = result.resultRows[0];
  assert(row.apiPrice === 43691, `price should be the visible bonus price, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Китай-город, до 5 мин.', `location should match the card, got ${row.apiLocation}`);
  assert(row.apiDescriptionPreview.startsWith('Авитодоставка открыта'), 'description not decoded');
  assert(row.apiSeller.name === 'AMD INTEL' && row.apiSeller.reviewsCount === 2015, 'seller not decoded');
  assert(row.apiImageCount === 2 && row.apiUrl === `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_7881841669`, 'photo count/url not decoded');
});

// A search without a geo argument refines nothing, and that is exactly what the
// request must say: the landed searchCore carried over unchanged, no geo key added.
check('a search with no geo argument still asks the API, carrying the landed context', async () => {
  const { fetch, calls } = makeFetch(routes());
  await runEvaluate(baseArgs(), fetch);
  const requested = new URL(calls[2]);
  assert(requested.searchParams.get('context') === 'opaque-context', `context not carried: ${calls[2]}`);
  assert(requested.searchParams.get('categoryId') === '101', `searchCore not carried: ${calls[2]}`);
  assert(requested.searchParams.get('locationId') === '637640', `the landed location must be carried: ${calls[2]}`);
  assert(!requested.searchParams.has('metro[0]') && !requested.searchParams.has('district[0]'),
    `no geo may be invented: ${calls[2]}`);
  assert(!requested.searchParams.has('p'), `the initial search is page 1: ${calls[2]}`);
});

check('a card without a bonus price or geo reference falls back to base fields', async () => {
  const plain = item({ id: '8290916337', visiblePrice: null, geoReference: null, locationName: 'Казань' });
  const { fetch } = makeFetch(routes(apiRoute({ items: [plain] })));
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
  const withItems = (rows) => routes(apiRoute({ items: rows }));
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
  const { fetch } = makeFetch(routes(apiRoute({ items: [anonymous] })));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const seller = result.resultRows[0].apiSeller;
  assert(seller.name === null, `the name must stay null, got ${JSON.stringify(seller)}`);
  assert(seller.rating === 4.8 && seller.reviewsCount === 19, `rating must survive, got ${JSON.stringify(seller)}`);
});

check('an absorbed query is accepted and a foreign q is rejected', async () => {
  const absorbed = makeFetch(routes(
    apiRoute({ core: { query: '' }, url: ORIGIN + ABSORBED }),
    hop2({ state: catalogState({ query: '' }), path: '/moskva/telefony', responseUrl: ORIGIN + ABSORBED }),
    hop1(ABSORBED),
  ));
  const ok = await runEvaluate(baseArgs({ queryUrl: `${ORIGIN}/?q=iphone`, query: 'iphone' }), absorbed.fetch);
  assert(ok.success === true, `absorbed query rejected: ${ok.message}`);

  const foreign = makeFetch([hop1('/moskva/telefony?q=android')]);
  const bad = await runEvaluate(baseArgs({ queryUrl: `${ORIGIN}/?q=iphone`, query: 'iphone' }), foreign.fetch);
  assert(bad.success === false && bad.stage === 'submit' && /different query/.test(bad.message), `foreign q accepted: ${JSON.stringify(bad)}`);
  assert(foreign.calls.length === 1, 'second hop ran despite a failed guard');
});

check('a homepage target never passes as a search result', async () => {
  const { fetch, calls } = makeFetch([hop1('/')]);
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
  const { fetch } = makeFetch(routes(apiRoute({ items: [], count: 0 })));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'empty', `unexpected: ${JSON.stringify(result)}`);
});

// The city cannot be applied by editing the URL, so an explicit location travels as a
// key of the API request and is confirmed against the searchCore that came back.
check('a location refinement is carried on the request and confirmed on the answer', async () => {
  const apiRow = item({ id: '8299623583', visiblePrice: 25000, basePrice: 25500 });
  const { fetch, calls } = makeFetch(routes(apiRoute({
    items: [apiRow],
    core: { locationId: 654918, locationName: 'Казань' },
    url: `${ORIGIN}${CANONICAL}&locationId=654918`,
  })));
  const args = baseArgs();
  args.refinement = { ...args.refinement, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === true, `refinement failed: ${result.message}`);
  assert(result.resultRows[0].apiItemId === '8299623583', 'API rows not used');
  assert(result.resultRows[0].apiPrice === 25000, 'refined rows must use the same visible-price decoder');
  assert(calls.filter((c) => c.startsWith(API)).length === 1, 'more than one API request');
  const requested = new URL(calls[2]);
  assert(requested.searchParams.get('locationId') === '654918', `requested location not sent: ${calls[2]}`);
  assert(requested.searchParams.get('spaFlow') === 'true' && requested.searchParams.get('context') === 'opaque-context',
    `unexpected API URL: ${calls[2]}`);
  assert(result.resultSearchUrl === `${ORIGIN}${CANONICAL}&locationId=654918`, 'server URL not returned');
  assert(result.resultSearchLocation === 'Казань', `effective location not reported: ${result.resultSearchLocation}`);
});

// A location that came back as the landed one means Avito ignored the request, and
// that answers 200 with a full plausible page.
check('a location the API did not apply is drift, not rows', async () => {
  const { fetch } = makeFetch(routes(apiRoute({ url: `${ORIGIN}${CANONICAL}` })));
  const args = baseArgs();
  args.refinement = { ...args.refinement, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === false && /did not apply the requested location/.test(result.message),
    `an ignored location was accepted: ${JSON.stringify(result)}`);
});

// The catalog filters of the landed route belong to `avito apply-filters`, so this command
// must carry them untouched and stop if Avito changes one behind its back.
check('a catalog filter changed by Avito during a location refinement is drift', async () => {
  const { fetch } = makeFetch(routes(apiRoute({
    core: { locationId: 654918, locationName: 'Казань', sort: '104' },
    url: `${ORIGIN}${CANONICAL}&locationId=654918`,
  })));
  const args = baseArgs();
  args.refinement = { ...args.refinement, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === false && /preserved search field sort/.test(result.message),
    `a changed sort must be drift: ${JSON.stringify(result)}`);
});

check('the API is never called when the guard fails', async () => {
  const { fetch, calls } = makeFetch([hop1('/')]);
  const args = baseArgs();
  args.refinement = { ...args.refinement, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === false, 'guard passed a homepage target');
  assert(calls.every((c) => !c.startsWith(API)), 'API called after a failed guard');
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing Avito put on the page is returned, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const { fetch } = makeFetch(routes(apiRoute({ items })));
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.resultRows.length === 50, `expected the whole page, got ${result.resultRows.length}`);
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

  const elsewhere = makeFetch(routes(apiRoute({
    items: [item({ images: [{ '208x208': 'https://www.avito.st/s/common/resume-stub.svg' }] })],
  })));
  const elsewhereResult = await runEvaluate(baseArgs(), elsewhere.fetch);
  assert(elsewhereResult.success === true, 'a photo outside the CDN must no longer refuse the page');
  assert(elsewhereResult.resultRows[0].apiImageCount === 1, 'the photo must still be counted');

  const unsent = makeFetch(routes(apiRoute({ items: [item({ images: null })] })));
  const unsentResult = await runEvaluate(baseArgs(), unsent.fetch);
  assert(unsentResult.resultRows[0].apiImageCount === null,
    'a card Avito sent without its photo block must not count as zero (D-062)');

  const malformed = makeFetch(routes(apiRoute({ items: [item({ images: 'one photo' })] })));
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

// Geo travels as indexed keys, so a landed route that already carries one and a
// caller who asks for another must not end up sending both under `metro[0]`.
check('a requested geo selection replaces the one the route landed with', async () => {
  const landed = catalogState({ core: { metroId: ['1', '2'] } });
  const { fetch, calls } = makeFetch(routes(
    apiRoute({ core: { metroId: ['9'] } }),
    hop2({ state: landed }),
  ));
  const args = baseArgs();
  args.refinement = { ...args.refinement, geoMode: 'metro', geoIds: ['9'] };
  const result = await runEvaluate(args, fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const sent = [...new URL(calls[2]).searchParams.entries()].filter(([key]) => key.startsWith('metro['));
  assert(sent.length === 1 && sent[0][0] === 'metro[0]' && sent[0][1] === '9',
    `the carried selection must be replaced, not stacked: ${JSON.stringify(sent)}`);
});

// The city the caller names is a different place, and a metro ID of the old one
// describes nothing in it — Avito accepts a foreign ID in silence (F-037).
check('a requested city discards the geo of the route the query landed on', async () => {
  const landed = catalogState({ core: { metroId: ['1'], geoCoords: [55.75, 37.61], searchRadius: 5 } });
  const { fetch, calls } = makeFetch(routes(
    apiRoute({ core: { locationId: 654918, locationName: 'Казань' }, url: `${ORIGIN}${CANONICAL}&locationId=654918` }),
    hop2({ state: landed }),
  ));
  const args = baseArgs();
  args.refinement = { ...args.refinement, locationRequested: true, locationId: '654918' };
  const result = await runEvaluate(args, fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const sent = new URL(calls[2]).searchParams;
  assert(![...sent.keys()].some((key) => key.startsWith('metro[') || key.startsWith('district[')),
    `the old geo IDs must not travel to a new city: ${calls[2]}`);
  assert(!sent.has('geoCoords') && !sent.has('radius'), `the old point must not travel either: ${calls[2]}`);
});

// Geo the caller did not touch is part of the search, so losing it is drift and
// not a wider result set.
check('geo the caller did not touch must come back unchanged', async () => {
  const landed = catalogState({ core: { metroId: ['1', '2'] } });
  const { fetch, calls } = makeFetch(routes(apiRoute({ core: { metroId: ['1', '2'] } }), hop2({ state: landed })));
  const kept = await runEvaluate(baseArgs(), fetch);
  assert(kept.success === true, `a preserved selection failed: ${kept.message}`);
  const sent = [...new URL(calls[2]).searchParams.entries()].filter(([key]) => key.startsWith('metro['));
  assert(sent.length === 2, `the landed selection must be carried: ${JSON.stringify(sent)}`);

  const dropped = makeFetch(routes(apiRoute({ core: { metroId: [] } }), hop2({ state: landed })));
  const droppedResult = await runEvaluate(baseArgs(), dropped.fetch);
  assert(droppedResult.success === false && /preserved geo selection/.test(droppedResult.message),
    `a dropped selection was accepted: ${JSON.stringify(droppedResult)}`);

  const movedPoint = makeFetch(routes(
    apiRoute({ core: { geoCoords: [55.75, 37.61], searchRadius: 5 } }),
    hop2({ state: catalogState() }),
  ));
  const movedResult = await runEvaluate(baseArgs(), movedPoint.fetch);
  assert(movedResult.success === false && /preserved search point/.test(movedResult.message),
    `an invented point was accepted: ${JSON.stringify(movedResult)}`);
});

export default await run('search context (browser side)');
