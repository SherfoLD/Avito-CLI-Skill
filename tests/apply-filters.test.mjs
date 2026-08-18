// Offline end-to-end for the browser-side filter context: runs the real browser half from
// src/browser/commands/apply-filters.mjs against a synthetic Avito SSR carrier plus a stubbed items
// API response.
// The selections are built by the command's own parser, so the `;`/`,`/`..` grammar and the
// request it produces are checked as one path (D-032).
import { assertRow, loadCommand, runner } from './harness.mjs';
import {
  FILTERS, ORIGIN, bootstrapHtml, evaluateRunner, item, makeFetch, searchCore,
} from './carrier.mjs';
import { applyFilters } from '../src/browser/commands/apply-filters.mjs';

const { COMMAND, normalizeSelections, SHORT_KEYS } = await loadCommand(
  'apply-filters',
  ['normalizeSelections', 'SHORT_KEYS'],
);

const CATALOG_PATH = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB';
const REQUESTED = `${ORIGIN}${CATALOG_PATH}?q=ddr5+32gb`;
const API_PATH = '/web/1/js/items';

const PARAM_FILTER = {
  id: 'params[159478]',
  type: 'multiselect',
  values: [{ value: '18629557', name: 'DDR5' }, { value: '18629556', name: 'DDR4' }],
};
const SECOND_PARAM_FILTER = {
  id: 'params[121588]',
  type: 'multiselect',
  values: [{ value: '2850684', name: 'Новое' }, { value: '2850685', name: 'Б/у' }],
};
const RANGE_PARAM_FILTER = { id: 'params[99001]', type: 'numericRange' };

const sections = (filters) => ({ Sections: [{ Filters: filters }] });

const sourceFilters = ({
  type = PARAM_FILTER.type,
  values = PARAM_FILTER.values,
  extra = [SECOND_PARAM_FILTER, RANGE_PARAM_FILTER],
} = {}) => [...FILTERS.Sections[0].Filters, { ...PARAM_FILTER, type, values }, ...extra];

const ssrState = ({ page = 1, core = {}, filters = sourceFilters() } = {}) => ({
  loaderData: {
    data: {
      searchCore: searchCore({ page, ...core }),
      filtersV2: sections(filters),
      context: 'opaque-context',
    },
  },
});

const apiState = ({
  items = [item()],
  params = { 159478: ['18629557'] },
  current = { 'params[159478]': ['18629557'] },
  core = {},
  filters = sourceFilters(),
  count = null,
} = {}) => ({
  searchCore: searchCore({ params, ...core }),
  filtersV2: sections(filters.map((filter) => (
    Object.hasOwn(current, filter.id) ? { ...filter, currentValue: current[filter.id] } : filter
  ))),
  catalog: { items },
  url: `${ORIGIN}${CATALOG_PATH}?q=ddr5+32gb&params[159478]=18629557`,
  ...(count == null ? {} : { count }),
});

const ssrRoute = (state = ssrState(), overrides = {}) => ({
  match: `${ORIGIN}${CATALOG_PATH}`,
  body: bootstrapHtml(state),
  ...overrides,
});

const apiRoute = (state = apiState(), overrides = {}) => ({
  match: `${ORIGIN}${API_PATH}`,
  contentType: 'application/json',
  body: state,
  ...overrides,
});

const runEvaluate = evaluateRunner(applyFilters);

const baseArgs = (overrides = {}) => ({
  requestedUrl: REQUESTED,
  selections: normalizeSelections('params[159478]=18629557'),
  SHORT_KEYS,
  MAX_FILTERS: 400,
  MAX_PARAMS: 400,
  MAX_PARAM_VALUES: 2000,
  ...overrides,
});

const withSet = (set, overrides = {}) => baseArgs({ selections: normalizeSelections(set), ...overrides });

const { check, assert, run } = runner();

check('the items API rows decode the visible price, metro line and card text', async () => {
  const { fetch, calls } = makeFetch([ssrRoute(), apiRoute()]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls.length === 2 && calls[0] === REQUESTED, `expected one SSR read then one API call, got ${JSON.stringify(calls)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[159478][0]=18629557'), `selection not serialized: ${apiUrl}`);
  assert(apiUrl.includes('spaFlow=true') && apiUrl.includes('context=opaque-context'), `unexpected API URL: ${apiUrl}`);
  const row = result.apiRows[0];
  assert(row.apiPrice === 43691, `price should be the visible bonus price, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Китай-город, до 5 мин.', `location should match the card, got ${row.apiLocation}`);
  assert(row.apiDescriptionPreview?.startsWith('Авитодоставка открыта'), `description not decoded: ${row.apiDescriptionPreview}`);
  assert(row.apiSeller.name === 'AMD INTEL' && row.apiSeller.reviewsCount === 2015, 'seller not decoded');
  assert(row.apiImageCount === 2 && row.apiUrl === `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_7881841669`, 'photo count/url not decoded');
});

check('a card without iva steps falls back to the flat items API fields', async () => {
  // The items API keeps item.description populated, so the flat field stays a real fallback
  // here even though the SSR catalog leaves it empty.
  const plain = item({
    id: '8290916337',
    visiblePrice: null,
    geoReference: null,
    locationName: 'Казань',
    description: null,
    flatDescription: 'Оперативная память с гарантией.',
  });
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ items: [plain] }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const row = result.apiRows[0];
  assert(row.apiPrice === 43800, `expected base price, got ${row.apiPrice}`);
  assert(row.apiLocation === 'Казань', `expected city, got ${row.apiLocation}`);
  assert(row.apiDescriptionPreview === 'Оперативная память с гарантией.', `flat description not used: ${row.apiDescriptionPreview}`);
});

// Avito prints a phrase where a card has no number, and the flat value is 0 under both
// phrases: «Цена договорная», which is no price, and «Бесплатно», which is a real zero.
// Reading the flat field turned the first into the second (F-076). A services card prices
// by a table, and then the scalar beside it is a floor rather than a price (F-079).
check('a card with no number reports none, and a real zero survives as zero', async () => {
  const routes = (rows) => [ssrRoute(), apiRoute(apiState({ items: rows }))];
  const decode = async (card) => {
    const result = await runEvaluate(baseArgs(), makeFetch(routes([card])).fetch);
    assert(result.success === true, `failed: ${result.message}`);
    return result.apiRows[0];
  };

  const negotiable = await decode(item({ priceForm: 'negotiable' }));
  assert(negotiable.apiPrice === null, `«Цена договорная» must not be a number, got ${negotiable.apiPrice}`);

  const free = await decode(item({ priceForm: 'free' }));
  assert(free.apiPrice === 0, `«Бесплатно» is a real zero, got ${free.apiPrice}`);

  // The unit is Avito's and no column carries it, so it must not change the
  // number either: «43 691 ₽ за м²» is the same 43691 as «43 691 ₽» (F-077).
  const perUnit = await decode(item({ priceUnit: 'за м²' }));
  assert(perUnit.apiPrice === 43691, `the unit must not disturb the number, got ${perUnit.apiPrice}`);

  // «от 43 691» is a floor, and the floor is not the price. The word is matched
  // by nothing: a string of digits and spaces is a price, one carrying anything
  // else is a floor (F-078).
  const floor = await decode(item({ priceForm: 'floor' }));
  assert(floor.apiPrice === null, `a floor is not a price, got ${floor.apiPrice}`);
  assert(floor.apiMinPrice === 43691, `the floor must survive as one, got ${floor.apiMinPrice}`);

  const plain = await decode(item());
  assert(plain.apiPrice === 43691 && plain.apiMinPrice === null, 'a plain price must stay a price');
  assert(negotiable.apiMinPrice === null && free.apiMinPrice === null, 'a phrase carries no floor');

  // A step Avito sent is the whole answer: the flat field carries the base price,
  // a different quantity, and its 0 under a phrase is what made «Цена договорная»
  // a free listing. A step with no value key at all must not reopen that path.
  const stepWithoutValue = item();
  delete stepWithoutValue.iva.PriceStep[0].payload.priceDetailed.value;
  stepWithoutValue.iva.PriceStep[0].payload.priceDetailed.string = 'Цена договорная';
  const guarded = await decode(stepWithoutValue);
  assert(guarded.apiPrice === null, `the flat zero must stay out of it, got ${guarded.apiPrice}`);

  const priced = await decode(item({
    priceList: {
      values: [{ title: 'Диагностика', price: 'Цена договорная' }],
      valuesAll: [{ title: 'Диагностика', price: 'Цена договорная' }, { title: 'Замена ТЭН', price: 'от 1 500 ₽' }],
      countHint: 'Ещё 1 услуга',
    },
  }));
  assert(priced.apiHasPriceList === true, 'a card priced by a table must say so');
  assert(priced.apiPrice === null, `one number cannot stand for a table, got ${priced.apiPrice}`);
  assert(priced.apiMinPrice === 43691, `the number Avito printed beside the table is its floor, got ${priced.apiMinPrice}`);
  assert(plain.apiHasPriceList === false, 'a card without a table must say so too');

  let stopped = false;
  try {
    await decode(item({ priceList: { values: [], countHint: 'Ещё 1 услуга' } }));
  } catch (error) {
    stopped = /price list is malformed/.test(String(error?.message ?? error));
  }
  assert(stopped, 'a price list Avito sent in an unknown shape must stop the call');
});

// Avito ships the moment it sorts by on every card and prints that same moment on the
// listing page; get-item sees only the rendered string, so the exact instant belongs to the
// row (F-059). A card without the stamp keeps its row and reports null, while a stamp in a
// shape no clock produces is drift and stops the call.
check('the publication stamp decodes to the instant Avito prints, and drift stops the call', async () => {
  const routes = (rows) => [ssrRoute(), apiRoute(apiState({ items: rows }))];
  const result = await runEvaluate(baseArgs(), makeFetch(routes([item()])).fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.apiRows[0].apiPublished === '2026-08-13T23:15:41Z', `expected the UTC instant, got ${result.apiRows[0].apiPublished}`);

  const absent = await runEvaluate(baseArgs(), makeFetch(routes([item({ sortTimeStamp: null })])).fetch);
  assert(absent.success === true && absent.apiRows[0].apiPublished === null, 'a card without the stamp must keep its row');

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
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ items: [anonymous] }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const seller = result.apiRows[0].apiSeller;
  assert(seller.name === null, `the name must stay null, got ${JSON.stringify(seller)}`);
  assert(seller.rating === 4.8 && seller.reviewsCount === 19, `rating must survive, got ${JSON.stringify(seller)}`);
});

check('a selection Avito did not apply is drift, not rows', async () => {
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ params: {}, current: {} }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.stage === 'postcondition', `unapplied selection accepted: ${JSON.stringify(result)}`);
  assert(/did not apply every requested value of params\[159478\]/.test(result.message), `unexpected message: ${result.message}`);
});

check('a value missing from the fresh schema stops before the API', async () => {
  const { fetch, calls } = makeFetch([ssrRoute(ssrState({ filters: sourceFilters({ values: [{ value: '18629556', name: 'DDR4' }] }) }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'argument', `unknown value accepted: ${JSON.stringify(result)}`);
  assert(calls.length === 1, 'API called despite an unavailable selection');
});

// A key that is absent from the fresh schema was never visible to the caller either, so it
// is refused by name instead of being applied in a second round (D-031).
check('a key missing from the fresh schema is refused by name before the API', async () => {
  const { fetch, calls } = makeFetch([ssrRoute()]);
  const result = await runEvaluate(withSet('params[777777]=1'), fetch);
  assert(result.success === false && result.code === 'argument', `unknown key accepted: ${JSON.stringify(result)}`);
  assert(/params\[777777\] is not available/.test(result.message), `unexpected message: ${result.message}`);
  assert(/avito get-filters/.test(result.message), 'the caller must be told where to read the current keys');
  assert(calls.length === 1, 'API called despite an unavailable key');
});

// A multi-value Avito filter takes several of its own options at once and serializes them
// as params[id][0], params[id][1], …. Chaining calls cannot express this: a second call for
// the same key replaces the first selection instead of adding to it (F-050).
check('several values of one filter are serialized and confirmed together', async () => {
  const both = ['18629557', '18629556'];
  const { fetch, calls } = makeFetch([
    ssrRoute(),
    apiRoute(apiState({ params: { 159478: both }, current: { 'params[159478]': both } })),
  ]);
  const result = await runEvaluate(withSet('params[159478]=18629557,18629556'), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[159478][0]=18629557'), `first value not serialized: ${apiUrl}`);
  assert(apiUrl.includes('params[159478][1]=18629556'), `second value not serialized: ${apiUrl}`);
  assert(!/params\[159478\]=/.test(apiUrl), `the scalar form must not be sent too: ${apiUrl}`);
});

check('a partly applied multi-value selection is drift, not rows', async () => {
  const { fetch } = makeFetch([
    ssrRoute(),
    apiRoute(apiState({ params: { 159478: ['18629557'] }, current: { 'params[159478]': ['18629557'] } })),
  ]);
  const result = await runEvaluate(withSet('params[159478]=18629557,18629556'), fetch);
  assert(result.success === false && result.stage === 'postcondition', `partial application accepted: ${JSON.stringify(result)}`);
  assert(/did not apply every requested value/.test(result.message), `unexpected message: ${result.message}`);
});

check('several values are refused for a single-value filter before the API', async () => {
  const { fetch, calls } = makeFetch([ssrRoute(ssrState({ filters: sourceFilters({ type: 'select' }) }))]);
  const result = await runEvaluate(withSet('params[159478]=18629557,18629556'), fetch);
  assert(result.success === false && result.code === 'argument', `single-value filter took two values: ${JSON.stringify(result)}`);
  assert(/takes a single value/.test(result.message), `unexpected message: ${result.message}`);
  assert(calls.length === 1, 'API called despite an unusable selection');

  const singleValued = sourceFilters({ type: 'select' });
  const one = makeFetch([
    ssrRoute(ssrState({ filters: singleValued })),
    apiRoute(apiState({ filters: singleValued })),
  ]);
  const single = await runEvaluate(baseArgs(), one.fetch);
  assert(single.success === true, `a single value must still apply to a single-value filter: ${single.message}`);
});

// Live evidence: three different filters and five values went out in one request, came back
// 200 and passed every postcondition (F-050). The command therefore never splits a call.
check('several different filters travel in one request and are confirmed one by one', async () => {
  const { fetch, calls } = makeFetch([
    ssrRoute(),
    apiRoute(apiState({
      params: { 159478: ['18629557'], 121588: ['2850684'] },
      current: { 'params[159478]': ['18629557'], 'params[121588]': ['2850684'] },
      core: { owner: '2', priceMin: '1000', priceMax: '5000' },
    })),
  ]);
  const result = await runEvaluate(withSet('params[159478]=18629557;params[121588]=2850684;user=2;price=1000..5000'), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(calls.length === 2, `several filters must still cost one API request, got ${calls.length - 1}`);
  const apiUrl = decodeURIComponent(calls[1]);
  for (const expected of ['params[159478][0]=18629557', 'params[121588][0]=2850684', 'user=2', 'pmin=1000', 'pmax=5000']) {
    assert(apiUrl.includes(expected), `${expected} not serialized: ${apiUrl}`);
  }
});

// The short keys are ordinary keys for the caller, but their applied value is read from
// searchCore only: filtersV2.currentValue arrives stale or omitted for them even when the
// server URL proves the value was applied.
check('a short key is confirmed from searchCore and a stale filtersV2 does not fail it', async () => {
  const stale = sourceFilters().map((filter) => (
    filter.id === 'sort' ? { ...filter, currentValue: '101' } : filter
  ));
  const { fetch, calls } = makeFetch([
    ssrRoute(),
    apiRoute(apiState({ params: {}, current: {}, core: { sort: '104' }, filters: stale })),
  ]);
  const result = await runEvaluate(withSet('sort=104'), fetch);
  assert(result.success === true, `a stale short-key facet must not fail the call: ${result.message}`);
  assert(decodeURIComponent(calls[1]).includes('s=104'), 'sort must be serialized as s');
});

check('a short key Avito did not apply is drift, not rows', async () => {
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ params: {}, current: {}, core: { owner: null } }))]);
  const result = await runEvaluate(withSet('user=2'), fetch);
  assert(result.success === false && result.stage === 'postcondition', `unapplied short key accepted: ${JSON.stringify(result)}`);
  assert(/did not apply the requested value of user/.test(result.message), `unexpected message: ${result.message}`);
});

// Clearing means the key is not sent at all, and the answer must show it gone. Chaining back
// to an older searchUrl would drop every later filter with it, so the clear lives here.
check('an empty value clears a filter and the clearing is confirmed', async () => {
  const source = ssrState({ core: { params: { 159478: ['18629557'] }, owner: '2' } });
  const { fetch, calls } = makeFetch([
    ssrRoute(source),
    apiRoute(apiState({ params: {}, current: { 'params[159478]': [] }, core: { owner: null } })),
  ]);
  const result = await runEvaluate(withSet('params[159478]=;user='), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(!apiUrl.includes('params[159478]'), `a cleared filter must not be sent: ${apiUrl}`);
  assert(!/[?&]user=/.test(apiUrl), `a cleared short key must not be sent: ${apiUrl}`);
});

check('a filter Avito kept despite the clear is drift, not rows', async () => {
  const source = ssrState({ core: { params: { 159478: ['18629557'] } } });
  const { fetch } = makeFetch([
    ssrRoute(source),
    apiRoute(apiState({ params: { 159478: ['18629557'] }, current: { 'params[159478]': ['18629557'] } })),
  ]);
  const result = await runEvaluate(withSet('params[159478]='), fetch);
  assert(result.success === false && result.stage === 'postcondition', `an ignored clear was accepted: ${JSON.stringify(result)}`);
  assert(/did not clear filter params\[159478\]/.test(result.message), `unexpected message: ${result.message}`);
});

// A range inside params[...] is refused because Avito's serialization for it has never been
// observed; the only confirmed range is the short key price (D-032).
// A range inside `params[...]` travels in the two keys Avito's own inputs block declares,
// and both carriers answer with the same `{from, to}` object (D-041, F-063).
check('a params range travels in the two keys Avito declares for it', async () => {
  const applied = { 99001: { from: 2015, to: 2018 } };
  const { fetch, calls } = makeFetch([
    ssrRoute(),
    apiRoute(apiState({ params: applied, current: { 'params[99001]': { from: '2015', to: '2018' } } })),
  ]);
  const result = await runEvaluate(withSet('params[99001]=2015..2018'), fetch);
  assert(result.success === true, `a params range was refused: ${JSON.stringify(result)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[99001][from]=2015') && apiUrl.includes('params[99001][to]=2018'),
    `a range must be sent as two bounds: ${apiUrl}`);
});

check('an omitted bound is not sent, and the bound Avito calls empty is not a value', async () => {
  const { fetch, calls } = makeFetch([
    ssrRoute(),
    apiRoute(apiState({ params: { 99001: { from: 2015, to: 0 } }, current: { 'params[99001]': { from: '2015', to: null } } })),
  ]);
  const result = await runEvaluate(withSet('params[99001]=2015..'), fetch);
  assert(result.success === true, `a one-sided range was refused: ${JSON.stringify(result)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[99001][from]=2015') && !apiUrl.includes('params[99001][to]'),
    `the omitted bound must not be sent: ${apiUrl}`);
});

check('a range Avito did not apply is drift, not rows', async () => {
  const cases = [
    { params: { 99001: { from: 2015, to: 2017 } }, current: { 'params[99001]': { from: '2015', to: '2017' } } },
    // The shape of an echoed key: searchCore repeats what it was sent while the schema, which
    // is what Avito actually applied, stays empty (F-062).
    { params: { 99001: { from: 2015, to: 2018 } }, current: {} },
  ];
  for (const state of cases) {
    const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState(state))]);
    const result = await runEvaluate(withSet('params[99001]=2015..2018'), fetch);
    assert(result.success === false && result.stage === 'postcondition',
      `an unapplied range was accepted: ${JSON.stringify(result)}`);
  }
});

// The range already on the URL belongs to the caller as much as the one being applied: it is
// carried in the same two keys, and it is compared as a range instead of being flattened.
check('a range already applied to the URL survives the next call', async () => {
  const carried = { 159478: ['18629557'], 99001: { from: 2015, to: 0 } };
  const { fetch, calls } = makeFetch([
    ssrRoute(ssrState({ core: { params: carried } })),
    apiRoute(apiState({ params: { ...carried, 121588: ['2850684'] }, current: { 'params[121588]': ['2850684'] } })),
  ]);
  const result = await runEvaluate(withSet('params[121588]=2850684'), fetch);
  assert(result.success === true, `a carried range broke the call: ${JSON.stringify(result)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[99001][from]=2015') && !apiUrl.includes('params[99001][to]'),
    `the untouched range must be carried unchanged: ${apiUrl}`);

  const { fetch: drifted } = makeFetch([
    ssrRoute(ssrState({ core: { params: carried } })),
    apiRoute(apiState({
      params: { ...carried, 99001: { from: 2010, to: 0 }, 121588: ['2850684'] },
      current: { 'params[121588]': ['2850684'] },
    })),
  ]);
  const result2 = await runEvaluate(withSet('params[121588]=2850684'), drifted);
  assert(result2.success === false && result2.stage === 'postcondition',
    `a changed range must not pass as preserved: ${JSON.stringify(result2)}`);
});

// Avito groups the options of one control into named sections and repeats the popular ones
// in both groups, so a value the caller read from `get-filters` must be found through the
// grouping and a repeat must not read as an ambiguity (F-060).
check('a value of a sectioned control is found through its groups', async () => {
  const sectioned = [
    { id: '', title: 'Популярные', options: [{ value: '18629557', name: 'DDR5' }] },
    { id: '', title: 'Все', options: [{ value: '18629557', name: 'DDR5' }, { value: '18629556', name: 'DDR4' }] },
  ];
  const filters = sourceFilters({ type: 'sectionedMultiselect', values: sectioned });
  const { fetch, calls } = makeFetch([
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters })),
  ]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `a sectioned option was refused: ${JSON.stringify(result)}`);
  assert(calls.length === 2, `expected the SSR read and one API call, got ${calls.length}`);
});

check('one value under two names in two groups stops before the API', async () => {
  const drifted = [
    { id: '', title: 'Популярные', options: [{ value: '18629557', name: 'DDR5' }] },
    { id: '', title: 'Все', options: [{ value: '18629557', name: 'DDR-5' }] },
  ];
  const { fetch, calls } = makeFetch([ssrRoute(ssrState({ filters: sourceFilters({ type: 'sectionedMultiselect', values: drifted }) }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'argument', `an ambiguous option was accepted: ${JSON.stringify(result)}`);
  assert(/unavailable or ambiguous/.test(result.message), `unexpected message: ${result.message}`);
  assert(calls.length === 1, 'API called despite an ambiguous option');
});

// A slider is the range Avito draws as a track: both its ends are option values, so they are
// checked against the same vocabulary as any other value — and their order is the order of
// that list, not of the numbers behind the IDs.
const SLIDER = {
  id: 'params[99002]',
  type: 'slider',
  values: [
    { value: '3261702', name: '0.2 л' },
    { value: '3261703', name: '0.3 л' },
    { value: '3261704', name: '0.4 л' },
  ],
};
const withSlider = () => sourceFilters({ extra: [SECOND_PARAM_FILTER, RANGE_PARAM_FILTER, SLIDER] });

check('the bounds of a slider are its own option values', async () => {
  const filters = withSlider();
  const { fetch, calls } = makeFetch([
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({
      filters,
      params: { 99002: { from: 3261702, to: 3261704 } },
      current: { 'params[99002]': { from: '3261702', to: '3261704' } },
    })),
  ]);
  const result = await runEvaluate(withSet('params[99002]=3261702..3261704'), fetch);
  assert(result.success === true, `a slider range was refused: ${JSON.stringify(result)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[99002][from]=3261702') && apiUrl.includes('params[99002][to]=3261704'),
    `a slider must be sent as two bounds: ${apiUrl}`);
});

check('a bound outside the slider vocabulary and a reversed pair stop before the API', async () => {
  const filters = withSlider();
  const cases = [
    ['params[99002]=3261702..9999999', /must be one of the option values/],
    ['params[99002]=3261704..3261702', /must come before the upper bound/],
    // A list where Avito has a range, and a range where Avito has a list.
    ['params[99002]=3261702', /is a range; pass it as/],
    ['params[159478]=1..5', /is not a range in the fresh Avito schema/],
  ];
  for (const [set, expected] of cases) {
    const { fetch, calls } = makeFetch([ssrRoute(ssrState({ filters }))]);
    const result = await runEvaluate(withSet(set), fetch);
    assert(result.success === false && result.code === 'argument', `${set} was accepted: ${JSON.stringify(result)}`);
    assert(expected.test(result.message), `unexpected message for ${set}: ${result.message}`);
    assert(calls.length === 1, `API called despite a refused selection: ${set}`);
  }
});

// A keyword field takes what the caller typed: several words travel in the same indexed list
// as several options, and Avito carries them back with their spaces and case intact (F-064).
const KEYWORDS = { id: 'params[149569]', type: 'keywords' };
const withKeywords = () => sourceFilters({ extra: [SECOND_PARAM_FILTER, RANGE_PARAM_FILTER, KEYWORDS] });

check('typed words are applied as a list and confirmed verbatim', async () => {
  const filters = withKeywords();
  const typed = ['Kingston HyperX', 'новая'];
  const { fetch, calls } = makeFetch([
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 149569: typed }, current: { 'params[149569]': typed } })),
  ]);
  const result = await runEvaluate(withSet('params[149569]=Kingston HyperX,новая'), fetch);
  assert(result.success === true, `typed words were refused: ${JSON.stringify(result)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  // A space travels form-encoded as `+`, which is the form Avito answered live.
  assert(apiUrl.includes('params[149569][0]=Kingston+HyperX') && apiUrl.includes('params[149569][1]=новая'),
    `words must travel as an indexed list: ${apiUrl}`);

  // Avito lower-casing or trimming what it was sent would change which listings come back,
  // so a rewritten word is drift rather than a match.
  const rewritten = makeFetch([
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({
      filters,
      params: { 149569: ['kingston hyperx', 'новая'] },
      current: { 'params[149569]': ['kingston hyperx', 'новая'] },
    })),
  ]);
  const drifted = await runEvaluate(withSet('params[149569]=Kingston HyperX,новая'), rewritten.fetch);
  assert(drifted.success === false && drifted.stage === 'postcondition',
    `a rewritten keyword must not pass: ${JSON.stringify(drifted)}`);
});

check('a keyword that reads as a range is refused instead of sent as one', async () => {
  const filters = withKeywords();
  const { fetch, calls } = makeFetch([ssrRoute(ssrState({ filters }))]);
  const result = await runEvaluate(withSet('params[149569]=2015..2018'), fetch);
  assert(result.success === false && result.code === 'argument', `a range-looking keyword was sent: ${JSON.stringify(result)}`);
  assert(/takes text/.test(result.message), `unexpected message: ${result.message}`);
  assert(calls.length === 1, 'API called despite an ambiguous keyword');
});

// A checkbox carries no vocabulary, so there is nothing to look a value up in: Avito's own
// control sends the bare key with `1`, and the schema is what proves it was applied — an
// unknown key is echoed back in searchCore with an empty currentValue (F-062).
const CHECKBOX = { id: 'params[191434]', type: 'bannerCheckBoxWithImage' };
const withCheckbox = () => sourceFilters({ extra: [SECOND_PARAM_FILTER, RANGE_PARAM_FILTER, CHECKBOX] });

check('a checkbox is sent as the bare key and confirmed by both carriers', async () => {
  const filters = withCheckbox();
  const { fetch, calls } = makeFetch([
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 191434: 1 }, current: { 'params[191434]': 1 } })),
  ]);
  const result = await runEvaluate(withSet('params[191434]=1'), fetch);
  assert(result.success === true, `a checkbox was refused: ${JSON.stringify(result)}`);
  const apiUrl = decodeURIComponent(calls[1]);
  assert(apiUrl.includes('params[191434]=1') && !apiUrl.includes('params[191434][0]'),
    `a checkbox has no index: ${apiUrl}`);

  const echoed = makeFetch([
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 191434: 1 }, current: {} })),
  ]);
  const unconfirmed = await runEvaluate(withSet('params[191434]=1'), echoed.fetch);
  assert(unconfirmed.success === false && unconfirmed.stage === 'postcondition',
    `an echoed checkbox must not pass as applied: ${JSON.stringify(unconfirmed)}`);
});

check('a checkbox takes 1 and nothing else', async () => {
  const filters = withCheckbox();
  for (const set of ['params[191434]=2', 'params[191434]=1,1', 'params[191434]=1..5']) {
    const { fetch, calls } = makeFetch([ssrRoute(ssrState({ filters }))]);
    let result;
    try {
      result = await runEvaluate(withSet(set), fetch);
    } catch (error) {
      result = { success: false, code: 'argument', message: error.message };
    }
    assert(result.success === false && result.code === 'argument', `${set} was accepted: ${JSON.stringify(result)}`);
    assert(calls.length <= 1, `API called despite a refused checkbox value: ${set}`);
  }
});

// `avito search` may have created this URL with a city, metro, districts or a radius, and a
// refinement of it must not widen the search behind the caller's back.
check('the geo of the source URL is carried into the request and checked as preserved', async () => {
  const geo = { metroId: ['117'], geoCoords: [55.760256, 37.611446], searchRadius: 5 };
  const kept = makeFetch([
    ssrRoute(ssrState({ core: geo })),
    apiRoute(apiState({ core: geo })),
  ]);
  const result = await runEvaluate(baseArgs(), kept.fetch);
  assert(result.success === true, `carried geo must pass: ${result.message}`);
  const apiUrl = decodeURIComponent(kept.calls[1]);
  assert(apiUrl.includes('metro[0]=117'), `metro not carried: ${apiUrl}`);
  assert(apiUrl.includes('geoCoords=55.760256,37.611446') && apiUrl.includes('radius=5'), `radius not carried: ${apiUrl}`);

  const dropped = makeFetch([
    ssrRoute(ssrState({ core: geo })),
    apiRoute(apiState({ core: { ...geo, metroId: [] } })),
  ]);
  const drift = await runEvaluate(baseArgs(), dropped.fetch);
  assert(drift.success === false && /preserved search field metroId/.test(drift.message),
    `a dropped metro must be drift: ${JSON.stringify(drift)}`);
});

check('an items API rate limit or challenge stops as access', async () => {
  const rate = makeFetch([ssrRoute(), apiRoute(undefined, { status: 429, body: { 'too-many-requests': true } })]);
  const rateResult = await runEvaluate(baseArgs(), rate.fetch);
  assert(rateResult.success === false && rateResult.code === 'access', `429 not reported as access: ${JSON.stringify(rateResult)}`);

  const captcha = makeFetch([ssrRoute(), apiRoute(undefined, { body: { firewallCaptcha: true } })]);
  const captchaResult = await runEvaluate(baseArgs(), captcha.fetch);
  assert(captchaResult.success === false && captchaResult.code === 'access', `captcha not reported: ${JSON.stringify(captchaResult)}`);
});

check('a zero-count result is a typed empty result, not a shape error', async () => {
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ items: [], count: 0 }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === false && result.code === 'empty', `unexpected: ${JSON.stringify(result)}`);
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing the items API returned is kept, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ items }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.apiRows.length === 50, `expected the whole page, got ${result.apiRows.length}`);
});

// A row carries how many photos the card has and not one photo URL: the sizes are
// Avito's vocabulary and the originals belong to `get-item`. A card whose photo is
// served from outside the photo CDN — every résumé — is readable because of that (F-087).
check('the row counts the card photos, wherever they are hosted', async () => {
  const { fetch } = makeFetch([ssrRoute(), apiRoute()]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.apiRows[0].apiImageCount === 2,
    `the card ships two photos, got ${result.apiRows[0].apiImageCount}`);

  const elsewhere = makeFetch([ssrRoute(), apiRoute(apiState({
    items: [item({ images: [{ '208x208': 'https://www.avito.st/s/common/resume-stub.svg' }] })],
  }))]);
  const elsewhereResult = await runEvaluate(baseArgs(), elsewhere.fetch);
  assert(elsewhereResult.success === true, 'a photo outside the CDN must no longer refuse the page');
  assert(elsewhereResult.apiRows[0].apiImageCount === 1, 'the photo must still be counted');

  const malformed = makeFetch([ssrRoute(), apiRoute(apiState({ items: [item({ images: 'one photo' })] }))]);
  let stopped = false;
  try {
    await runEvaluate(baseArgs(), malformed.fetch);
  } catch (error) {
    stopped = /images are malformed/.test(String(error?.message ?? error));
  }
  assert(stopped, 'a malformed photo list must fail closed, not count zero');
});

check('the reservation flag is decoded from the API card, and an absent key stays null', async () => {
  const items = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: '8288791269', isReserved: false }),
    item({ id: '8234297329', isReserved: null }),
  ];
  const { fetch } = makeFetch([ssrRoute(), apiRoute(apiState({ items }))]);
  const result = await runEvaluate(baseArgs(), fetch);
  assert(result.success === true, `failed: ${result.message}`);
  assert(result.apiRows.length === 3, 'the flag must not drop rows inside the decoder');
  assert(result.apiRows[0].apiReserved === true, 'a reserved card must decode to true');
  assert(result.apiRows[1].apiReserved === false, 'an available card must decode to false');
  assert(result.apiRows[2].apiReserved === null, 'a missing flag must stay null, not become false');
});

// Node side: the flag is a local predicate over the returned page and is never a selection.
const observedFilter = (rows) => ({
  success: true,
  apiSearchLocation: 'Москва',
  apiSearchUrl: `${REQUESTED}&params[159478]=18629557`,
  apiRows: rows,
});

const filterStub = (observed) => {
  const seen = [];
  return {
    seen,
    goto: async () => {},
    wait: async () => {},
    evaluateWithArgs: async (source, args) => { seen.push(args); return observed; },
  };
};

const ROW = {
  apiItemId: '8288791269',
  apiTitle: 'DDR5 32gb Kingston Fury',
  apiPrice: 43691,
  apiMinPrice: null,
  apiHasPriceList: false,
  apiLocation: 'Москва',
  apiDescriptionPreview: 'Авитодоставка открыта',
  apiPublished: '2026-08-13T23:15:41Z',
  apiSeller: { name: 'AMD INTEL', rating: 5, reviewsCount: 2015 },
  apiImageCount: 0,
  apiReserved: false,
  apiUrl: `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_8288791269`,
};

const filterArgs = (extra = {}) => ({ searchUrl: REQUESTED, set: 'params[159478]=18629557', ...extra });

check('remove-reserved drops the reserved rows without touching the selection', async () => {
  const rows = [
    { ...ROW, apiItemId: '8329291056', apiReserved: true },
    ROW,
    { ...ROW, apiItemId: '8220283533', apiReserved: true },
  ];
  const stub = filterStub(observedFilter(rows));
  const result = await COMMAND.run(stub, filterArgs({ 'remove-reserved': true }));
  assert(result.length === 1 && result[0].itemId === ROW.apiItemId, `unexpected rows: ${JSON.stringify(result.map((r) => r.itemId))}`);
  assert(!('isReserved' in result[0]), 'the flag must stay out of the row contract');
  assertRow(COMMAND, result[0]);
  assert(stub.seen[0].selections[0].key === 'params[159478]', 'the selection must reach the browser unchanged');
  assert(!('removeReserved' in stub.seen[0]), 'remove-reserved must never look like an Avito selection');

  const whole = await COMMAND.run(filterStub(observedFilter(rows)), filterArgs());
  assert(whole.length === 3, 'without the flag the page must come back whole');
});

check('an all-reserved page is empty and a vanished flag refuses the filter', async () => {
  const allReserved = [
    { ...ROW, apiItemId: '8329291056', apiReserved: true },
    { ...ROW, apiItemId: '8220283533', apiReserved: true },
  ];
  let failure = null;
  try {
    await COMMAND.run(filterStub(observedFilter(allReserved)), filterArgs({ 'remove-reserved': true }));
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);
  assert(/\(2\) is reserved/.test(failure.message), `page size not reported: ${failure && failure.message}`);

  const drifted = [ROW, { ...ROW, apiItemId: '8234297329', apiReserved: null }];
  let refused = null;
  try {
    await COMMAND.run(filterStub(observedFilter(drifted)), filterArgs({ 'remove-reserved': true }));
  } catch (error) { refused = error; }
  assert(refused != null && refused.code === 'COMMAND_EXEC', `drifted flag accepted: ${refused && refused.code}`);
  assert(/reservation flag/.test(refused.message), `unexpected message: ${refused && refused.message}`);
});

// `;` separates filters, `,` separates values of one filter, `..` carries a range and an
// empty value clears. All four are parsed fail-closed: a malformed entry would otherwise
// reach Avito as a different request than the one that was asked for (D-032).
check('the set grammar is parsed fail-closed', async () => {
  const stub = filterStub(observedFilter([ROW]));
  await COMMAND.run(stub, filterArgs({ set: 'params[159478]=18629557, 18629556 ; price=1000..5000; user= ' }));
  const [ram, price, user] = stub.seen[0].selections;
  assert(JSON.stringify(ram.values) === JSON.stringify(['18629557', '18629556']), `values not parsed: ${JSON.stringify(ram)}`);
  assert(price.from === '1000' && price.to === '5000' && price.kind === 'range', `range not parsed: ${JSON.stringify(price)}`);
  assert(user.clear === true && user.values.length === 0, `clear not parsed: ${JSON.stringify(user)}`);

  const open = filterStub(observedFilter([ROW]));
  await COMMAND.run(open, filterArgs({ set: 'price=..30000' }));
  assert(open.seen[0].selections[0].from === null && open.seen[0].selections[0].to === '30000',
    `an open lower bound must parse: ${JSON.stringify(open.seen[0].selections[0])}`);

  for (const [set, pattern] of [
    ['params[159478]=18629557,', /no empty value/],
    ['params[159478]=,18629557', /no empty value/],
    ['params[159478]=18629557,18629557', /repeat the same value/],
    ['params[159478]=1;params[159478]=2', /must not repeat filter/],
    ['params[159478]', /must use <key>=<value>/],
    ['price=1000', /must be a range/],
    ['price=5000..1000', /lower bound of price must be <= upper bound/],
    ['price=..', /at least one bound/],
    ['user=1,2', /takes a single value/],
    ['localPriority=2', /must be 1/],
    ['s=104', /is not applicable/],
    ['', /at least one/],
  ]) {
    let failure = null;
    try {
      await COMMAND.run(filterStub(observedFilter([ROW])), filterArgs({ set }));
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'ARGUMENT', `"${set}" accepted: ${failure && failure.code}`);
    assert(pattern.test(failure.message), `unexpected message for "${set}": ${failure.message}`);
  }
});

// Commander keeps only the last repeat of a named option, so before 2026-08-15 a second
// --set silently dropped the first selection and the output looked completely normal (F-050).
check('a repeated --set is refused instead of silently keeping the last one', async () => {
  const argv = process.argv;
  process.argv = [...argv, '--set', 'params[159478]=18629557', '--set', 'params[121588]=2850684'];
  let failure = null;
  try {
    await COMMAND.run(filterStub(observedFilter([ROW])), filterArgs());
  } catch (error) { failure = error; } finally { process.argv = argv; }
  assert(failure != null && failure.code === 'ARGUMENT', `repeated --set accepted: ${failure && failure.code}`);
  assert(/set may be passed once/.test(failure.message), `unexpected message: ${failure.message}`);
});

export default await run('apply-filters context (browser side)');
