// Offline end-to-end for `avito apply-filters`: the real command over a synthetic
// Avito SSR document plus a stubbed items API response. The selections go through
// the command's own parser, so the `;`/`,`/`..` grammar, the request it produces
// and the postconditions on the answer are all one path (D-032).
//
// What a card means is `card.test.mjs`. What this suite watches is which
// selections are refused before a request exists, how each one is serialized, and
// what the answer has to show before its rows are handed over.
import {
  assertRow, failureOf, loadCommand, runner,
} from './harness.mjs';
import {
  FILTERS, ITEMS_API_PATH, ORIGIN, bootstrapHtml, browserPage, item, searchCore,
} from './carrier.mjs';

const { COMMAND, normalizeSelections } = await loadCommand('apply-filters', ['normalizeSelections', 'SHORT_KEYS']);

const CATALOG_PATH = '/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgB';
const REQUESTED = `${ORIGIN}${CATALOG_PATH}?q=ddr5+32gb`;
const API = `${ORIGIN}${ITEMS_API_PATH}`;

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
  match: API,
  contentType: 'application/json',
  body: state,
  ...overrides,
});

// The API prefix has to be matched before the catalog route, because a stubbed
// route is chosen by prefix and both hang off the same origin.
const routes = (ssr = ssrRoute(), api = apiRoute()) => [api, ssr];

const apply = (routeList, set = 'params[159478]=18629557', args = {}) => {
  const page = browserPage(routeList);
  return { page, rows: COMMAND.run(page, { searchUrl: REQUESTED, set, ...args }) };
};

/** The request the page was told to fetch, readable. */
const requested = (page) => decodeURIComponent(page.calls.find((call) => call.startsWith(API)) ?? '');

const { check, assert, run } = runner();

check('the selection is serialized onto the sealed request and its rows come back', async () => {
  const driven = apply(routes());
  const rows = await driven.rows;
  assert(driven.page.calls.length === 2 && driven.page.calls[0] === REQUESTED,
    `expected one SSR read then one API call, got ${JSON.stringify(driven.page.calls)}`);
  const url = requested(driven.page);
  assert(url.includes('params[159478][0]=18629557'), `selection not serialized: ${url}`);
  assert(url.includes('spaFlow=true') && url.includes('context=opaque-context'), `unexpected API URL: ${url}`);
  assertRow(COMMAND, rows[0]);
});

check('a selection Avito did not apply is drift, not rows', async () => {
  const failure = await failureOf(() => apply(routes(ssrRoute(), apiRoute(apiState({ params: {}, current: {} })))).rows);
  assert(failure?.code === 'COMMAND_EXEC', `unapplied selection accepted: ${failure && failure.code}`);
  assert(/did not apply every requested value of params\[159478\]/.test(failure.message), `unexpected message: ${failure.message}`);
});

check('a value missing from the fresh schema stops before the API', async () => {
  const driven = apply(routes(ssrRoute(ssrState({ filters: sourceFilters({ values: [{ value: '18629556', name: 'DDR4' }] }) }))));
  const failure = await failureOf(() => driven.rows);
  assert(failure?.code === 'ARGUMENT', `unknown value accepted: ${failure && failure.code}`);
  assert(driven.page.calls.length === 1, 'API called despite an unavailable selection');
});

// A key that is absent from the fresh schema was never visible to the caller either, so it
// is refused by name instead of being applied in a second round (D-031).
check('a key missing from the fresh schema is refused by name before the API', async () => {
  const driven = apply(routes(ssrRoute()), 'params[777777]=1');
  const failure = await failureOf(() => driven.rows);
  assert(failure?.code === 'ARGUMENT', `unknown key accepted: ${failure && failure.code}`);
  assert(/params\[777777\] is not available/.test(failure.message), `unexpected message: ${failure.message}`);
  assert(/avito get-filters/.test(failure.message), 'the caller must be told where to read the current keys');
  assert(driven.page.calls.length === 1, 'API called despite an unavailable key');
});

// A multi-value Avito filter takes several of its own options at once and serializes them
// as params[id][0], params[id][1], …. Chaining calls cannot express this: a second call for
// the same key replaces the first selection instead of adding to it (F-050).
check('several values of one filter are serialized and confirmed together', async () => {
  const both = ['18629557', '18629556'];
  const driven = apply(
    routes(ssrRoute(), apiRoute(apiState({ params: { 159478: both }, current: { 'params[159478]': both } }))),
    'params[159478]=18629557,18629556',
  );
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('params[159478][0]=18629557'), `first value not serialized: ${url}`);
  assert(url.includes('params[159478][1]=18629556'), `second value not serialized: ${url}`);
  assert(!/params\[159478\]=/.test(url), `the scalar form must not be sent too: ${url}`);
});

check('a partly applied multi-value selection is drift, not rows', async () => {
  const failure = await failureOf(() => apply(
    routes(ssrRoute(), apiRoute(apiState({ params: { 159478: ['18629557'] }, current: { 'params[159478]': ['18629557'] } }))),
    'params[159478]=18629557,18629556',
  ).rows);
  assert(failure?.code === 'COMMAND_EXEC', `partial application accepted: ${failure && failure.code}`);
  assert(/did not apply every requested value/.test(failure.message), `unexpected message: ${failure.message}`);
});

check('several values are refused for a single-value filter before the API', async () => {
  const singleValued = sourceFilters({ type: 'select' });
  const driven = apply(routes(ssrRoute(ssrState({ filters: singleValued }))), 'params[159478]=18629557,18629556');
  const failure = await failureOf(() => driven.rows);
  assert(failure?.code === 'ARGUMENT', `single-value filter took two values: ${failure && failure.code}`);
  assert(/takes a single value/.test(failure.message), `unexpected message: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'API called despite an unusable selection');

  const one = await apply(routes(
    ssrRoute(ssrState({ filters: singleValued })), apiRoute(apiState({ filters: singleValued })),
  )).rows;
  assert(one.length === 1, 'a single value must still apply to a single-value filter');
});

// Live evidence: three different filters and five values went out in one request, came back
// 200 and passed every postcondition (F-050). The command therefore never splits a call.
check('several different filters travel in one request and are confirmed one by one', async () => {
  const driven = apply(routes(ssrRoute(), apiRoute(apiState({
    params: { 159478: ['18629557'], 121588: ['2850684'] },
    current: { 'params[159478]': ['18629557'], 'params[121588]': ['2850684'] },
    core: { owner: '2', priceMin: '1000', priceMax: '5000' },
  }))), 'params[159478]=18629557;params[121588]=2850684;user=2;price=1000..5000');
  await driven.rows;
  assert(driven.page.calls.length === 2, `several filters must still cost one API request, got ${driven.page.calls.length - 1}`);
  const url = requested(driven.page);
  for (const expected of ['params[159478][0]=18629557', 'params[121588][0]=2850684', 'user=2', 'pmin=1000', 'pmax=5000']) {
    assert(url.includes(expected), `${expected} not serialized: ${url}`);
  }
});

// The short keys are ordinary keys for the caller, but their applied value is read from
// searchCore only: filtersV2.currentValue arrives stale or omitted for them even when the
// server URL proves the value was applied.
check('a short key is confirmed from searchCore and a stale filtersV2 does not fail it', async () => {
  const stale = sourceFilters().map((filter) => (
    filter.id === 'sort' ? { ...filter, currentValue: '101' } : filter
  ));
  const driven = apply(
    routes(ssrRoute(), apiRoute(apiState({ params: {}, current: {}, core: { sort: '104' }, filters: stale }))),
    'sort=104',
  );
  await driven.rows;
  assert(requested(driven.page).includes('s=104'), 'sort must be serialized as s');
});

check('a short key Avito did not apply is drift, not rows', async () => {
  const failure = await failureOf(() => apply(
    routes(ssrRoute(), apiRoute(apiState({ params: {}, current: {}, core: { owner: null } }))), 'user=2',
  ).rows);
  assert(failure?.code === 'COMMAND_EXEC', `unapplied short key accepted: ${failure && failure.code}`);
  assert(/did not apply the requested value of user/.test(failure.message), `unexpected message: ${failure.message}`);
});

// Clearing means the key is not sent at all, and the answer must show it gone. Chaining back
// to an older searchUrl would drop every later filter with it, so the clear lives here.
check('an empty value clears a filter and the clearing is confirmed', async () => {
  const source = ssrState({ core: { params: { 159478: ['18629557'] }, owner: '2' } });
  const driven = apply(
    routes(ssrRoute(source), apiRoute(apiState({ params: {}, current: { 'params[159478]': [] }, core: { owner: null } }))),
    'params[159478]=;user=',
  );
  await driven.rows;
  const url = requested(driven.page);
  assert(!url.includes('params[159478]'), `a cleared filter must not be sent: ${url}`);
  assert(!/[?&]user=/.test(url), `a cleared short key must not be sent: ${url}`);
});

check('a filter Avito kept despite the clear is drift, not rows', async () => {
  const source = ssrState({ core: { params: { 159478: ['18629557'] } } });
  const failure = await failureOf(() => apply(routes(
    ssrRoute(source),
    apiRoute(apiState({ params: { 159478: ['18629557'] }, current: { 'params[159478]': ['18629557'] } })),
  ), 'params[159478]=').rows);
  assert(failure?.code === 'COMMAND_EXEC', `an ignored clear was accepted: ${failure && failure.code}`);
  assert(/did not clear filter params\[159478\]/.test(failure.message), `unexpected message: ${failure.message}`);
});

// A range inside `params[...]` travels in the two keys Avito's own inputs block declares,
// and both carriers answer with the same `{from, to}` object (D-041, F-063).
check('a params range travels in the two keys Avito declares for it', async () => {
  const driven = apply(routes(ssrRoute(), apiRoute(apiState({
    params: { 99001: { from: 2015, to: 2018 } },
    current: { 'params[99001]': { from: '2015', to: '2018' } },
  }))), 'params[99001]=2015..2018');
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('params[99001][from]=2015') && url.includes('params[99001][to]=2018'),
    `a range must be sent as two bounds: ${url}`);
});

check('an omitted bound is not sent, and the bound Avito calls empty is not a value', async () => {
  const driven = apply(routes(ssrRoute(), apiRoute(apiState({
    params: { 99001: { from: 2015, to: 0 } },
    current: { 'params[99001]': { from: '2015', to: null } },
  }))), 'params[99001]=2015..');
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('params[99001][from]=2015') && !url.includes('params[99001][to]'),
    `the omitted bound must not be sent: ${url}`);
});

check('a range Avito did not apply is drift, not rows', async () => {
  const cases = [
    { params: { 99001: { from: 2015, to: 2017 } }, current: { 'params[99001]': { from: '2015', to: '2017' } } },
    // The shape of an echoed key: searchCore repeats what it was sent while the schema, which
    // is what Avito actually applied, stays empty (F-062).
    { params: { 99001: { from: 2015, to: 2018 } }, current: {} },
  ];
  for (const state of cases) {
    const failure = await failureOf(() => apply(
      routes(ssrRoute(), apiRoute(apiState(state))), 'params[99001]=2015..2018',
    ).rows);
    assert(failure?.code === 'COMMAND_EXEC', `an unapplied range was accepted: ${failure && failure.code}`);
  }
});

// The range already on the URL belongs to the caller as much as the one being applied: it is
// carried in the same two keys, and it is compared as a range instead of being flattened.
check('a range already applied to the URL survives the next call', async () => {
  const carried = { 159478: ['18629557'], 99001: { from: 2015, to: 0 } };
  const driven = apply(routes(
    ssrRoute(ssrState({ core: { params: carried } })),
    apiRoute(apiState({ params: { ...carried, 121588: ['2850684'] }, current: { 'params[121588]': ['2850684'] } })),
  ), 'params[121588]=2850684');
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('params[99001][from]=2015') && !url.includes('params[99001][to]'),
    `the untouched range must be carried unchanged: ${url}`);

  const failure = await failureOf(() => apply(routes(
    ssrRoute(ssrState({ core: { params: carried } })),
    apiRoute(apiState({
      params: { ...carried, 99001: { from: 2010, to: 0 }, 121588: ['2850684'] },
      current: { 'params[121588]': ['2850684'] },
    })),
  ), 'params[121588]=2850684').rows);
  assert(failure?.code === 'COMMAND_EXEC', `a changed range must not pass as preserved: ${failure && failure.code}`);
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
  const driven = apply(routes(ssrRoute(ssrState({ filters })), apiRoute(apiState({ filters }))));
  await driven.rows;
  assert(driven.page.calls.length === 2, `expected the SSR read and one API call, got ${driven.page.calls.length}`);
});

check('one value under two names in two groups stops before the API', async () => {
  const drifted = [
    { id: '', title: 'Популярные', options: [{ value: '18629557', name: 'DDR5' }] },
    { id: '', title: 'Все', options: [{ value: '18629557', name: 'DDR-5' }] },
  ];
  const driven = apply(routes(ssrRoute(ssrState({
    filters: sourceFilters({ type: 'sectionedMultiselect', values: drifted }),
  }))));
  const failure = await failureOf(() => driven.rows);
  assert(failure?.code === 'ARGUMENT', `an ambiguous option was accepted: ${failure && failure.code}`);
  assert(/unavailable or ambiguous/.test(failure.message), `unexpected message: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'API called despite an ambiguous option');
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
  const driven = apply(routes(ssrRoute(ssrState({ filters })), apiRoute(apiState({
    filters,
    params: { 99002: { from: 3261702, to: 3261704 } },
    current: { 'params[99002]': { from: '3261702', to: '3261704' } },
  }))), 'params[99002]=3261702..3261704');
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('params[99002][from]=3261702') && url.includes('params[99002][to]=3261704'),
    `a slider must be sent as two bounds: ${url}`);
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
    const driven = apply(routes(ssrRoute(ssrState({ filters }))), set);
    const failure = await failureOf(() => driven.rows);
    assert(failure?.code === 'ARGUMENT', `${set} was accepted: ${failure && failure.code}`);
    assert(expected.test(failure.message), `unexpected message for ${set}: ${failure.message}`);
    assert(driven.page.calls.length === 1, `API called despite a refused selection: ${set}`);
  }
});

// A keyword field takes what the caller typed: several words travel in the same indexed list
// as several options, and Avito carries them back with their spaces and case intact (F-064).
const KEYWORDS = { id: 'params[149569]', type: 'keywords' };
const withKeywords = () => sourceFilters({ extra: [SECOND_PARAM_FILTER, RANGE_PARAM_FILTER, KEYWORDS] });

check('typed words are applied as a list and confirmed verbatim', async () => {
  const filters = withKeywords();
  const typed = ['Kingston HyperX', 'новая'];
  const driven = apply(routes(
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 149569: typed }, current: { 'params[149569]': typed } })),
  ), 'params[149569]=Kingston HyperX,новая');
  await driven.rows;
  const url = requested(driven.page);
  // A space travels form-encoded as `+`, which is the form Avito answered live.
  assert(url.includes('params[149569][0]=Kingston+HyperX') && url.includes('params[149569][1]=новая'),
    `words must travel as an indexed list: ${url}`);

  // Avito lower-casing or trimming what it was sent would change which listings come back,
  // so a rewritten word is drift rather than a match.
  const rewritten = ['kingston hyperx', 'новая'];
  const failure = await failureOf(() => apply(routes(
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 149569: rewritten }, current: { 'params[149569]': rewritten } })),
  ), 'params[149569]=Kingston HyperX,новая').rows);
  assert(failure?.code === 'COMMAND_EXEC', `a rewritten keyword must not pass: ${failure && failure.code}`);
});

check('a keyword that reads as a range is refused instead of sent as one', async () => {
  const driven = apply(routes(ssrRoute(ssrState({ filters: withKeywords() }))), 'params[149569]=2015..2018');
  const failure = await failureOf(() => driven.rows);
  assert(failure?.code === 'ARGUMENT', `a range-looking keyword was sent: ${failure && failure.code}`);
  assert(/takes text/.test(failure.message), `unexpected message: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'API called despite an ambiguous keyword');
});

// A checkbox carries no vocabulary, so there is nothing to look a value up in: Avito's own
// control sends the bare key with `1`, and the schema is what proves it was applied — an
// unknown key is echoed back in searchCore with an empty currentValue (F-062).
const CHECKBOX = { id: 'params[191434]', type: 'bannerCheckBoxWithImage' };
const withCheckbox = () => sourceFilters({ extra: [SECOND_PARAM_FILTER, RANGE_PARAM_FILTER, CHECKBOX] });

check('a checkbox is sent as the bare key and confirmed by both carriers', async () => {
  const filters = withCheckbox();
  const driven = apply(routes(
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 191434: 1 }, current: { 'params[191434]': 1 } })),
  ), 'params[191434]=1');
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('params[191434]=1') && !url.includes('params[191434][0]'), `a checkbox has no index: ${url}`);

  const echoed = await failureOf(() => apply(routes(
    ssrRoute(ssrState({ filters })),
    apiRoute(apiState({ filters, params: { 191434: 1 }, current: {} })),
  ), 'params[191434]=1').rows);
  assert(echoed?.code === 'COMMAND_EXEC', `an echoed checkbox must not pass as applied: ${echoed && echoed.code}`);
});

check('a checkbox takes 1 and nothing else', async () => {
  const filters = withCheckbox();
  for (const set of ['params[191434]=2', 'params[191434]=1,1', 'params[191434]=1..5']) {
    const driven = apply(routes(ssrRoute(ssrState({ filters }))), set);
    const failure = await failureOf(() => driven.rows);
    assert(failure?.code === 'ARGUMENT', `${set} was accepted: ${failure && failure.code}`);
    assert(driven.page.calls.length <= 1, `API called despite a refused checkbox value: ${set}`);
  }
});

// `avito search` may have created this URL with a city, metro, districts or a radius, and a
// refinement of it must not widen the search behind the caller's back.
check('the geo of the source URL is carried into the request and checked as preserved', async () => {
  const geo = { metroId: ['117'], geoCoords: [55.760256, 37.611446], searchRadius: 5 };
  const driven = apply(routes(ssrRoute(ssrState({ core: geo })), apiRoute(apiState({ core: geo }))));
  await driven.rows;
  const url = requested(driven.page);
  assert(url.includes('metro[0]=117'), `metro not carried: ${url}`);
  assert(url.includes('geoCoords=55.760256,37.611446') && url.includes('radius=5'), `radius not carried: ${url}`);

  const failure = await failureOf(() => apply(routes(
    ssrRoute(ssrState({ core: geo })), apiRoute(apiState({ core: { ...geo, metroId: [] } })),
  )).rows);
  assert(failure != null && /preserved search field metroId/.test(failure.message),
    `a dropped metro must be drift: ${failure && failure.message}`);
});

check('an items API rate limit or challenge stops as access', async () => {
  const rate = await failureOf(() => apply(routes(
    ssrRoute(), apiRoute(undefined, { status: 429, body: { 'too-many-requests': true } }),
  )).rows);
  assert(rate?.code === 'ACCESS', `429 not reported as access: ${rate && rate.code}`);

  const captcha = await failureOf(() => apply(routes(
    ssrRoute(), apiRoute(undefined, { body: { firewallCaptcha: true } }),
  )).rows);
  assert(captcha?.code === 'ACCESS', `captcha not reported as access: ${captcha && captcha.code}`);
});

check('a zero-count result is a typed empty result', async () => {
  const failure = await failureOf(() => apply(routes(
    ssrRoute(), apiRoute(apiState({ items: [], count: 0 })),
  )).rows);
  assert(failure?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${failure && failure.code}`);

  // No rows and a non-zero count is not an answer, it is rows gone missing.
  const missing = await failureOf(() => apply(routes(
    ssrRoute(), apiRoute(apiState({ items: [], count: 120 })),
  )).rows);
  assert(missing?.code === 'COMMAND_EXEC', `a non-zero count with no rows was accepted: ${missing && missing.code}`);
});

// Avito fixes the page at 50 rows and offers no page-size parameter, so a full page must
// come back whole. Until 2026-08-14 a --limit default of 10 silently dropped 40 of them.
check('every listing the items API returned is kept, never a local slice', async () => {
  const items = Array.from({ length: 50 }, (unused, index) => item({ id: String(7881841669 + index) }));
  const rows = await apply(routes(ssrRoute(), apiRoute(apiState({ items })))).rows;
  assert(rows.length === 50, `expected the whole page, got ${rows.length}`);
});

// Node side: the flag is a local predicate over the returned page and is never a selection.
const CARD_ID = '8288791269';

check('remove-reserved drops the reserved rows without touching the selection', async () => {
  const items = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: CARD_ID }),
    item({ id: '8220283533', isReserved: true }),
  ];
  const driven = apply(
    routes(ssrRoute(), apiRoute(apiState({ items }))), 'params[159478]=18629557', { 'remove-reserved': true },
  );
  const rows = await driven.rows;
  assert(rows.length === 1 && rows[0].itemId === CARD_ID, `unexpected rows: ${JSON.stringify(rows.map((r) => r.itemId))}`);
  assert(!('isReserved' in rows[0]) && !('reserved' in rows[0]), 'the flag must stay out of the row contract');
  assertRow(COMMAND, rows[0]);
  const url = requested(driven.page);
  assert(url.includes('params[159478][0]=18629557'), `the selection must still be sent: ${url}`);
  assert(!/reserv/i.test(url), `remove-reserved must never become a request key: ${url}`);

  const whole = await apply(routes(ssrRoute(), apiRoute(apiState({ items })))).rows;
  assert(whole.length === 3, 'without the flag the page must come back whole');
});

check('an all-reserved page is empty and a vanished flag refuses the filter', async () => {
  const allReserved = [
    item({ id: '8329291056', isReserved: true }),
    item({ id: '8220283533', isReserved: true }),
  ];
  const empty = await failureOf(() => apply(
    routes(ssrRoute(), apiRoute(apiState({ items: allReserved }))), 'params[159478]=18629557', { 'remove-reserved': true },
  ).rows);
  assert(empty?.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${empty && empty.code}`);
  assert(/\(2\) is reserved/.test(empty.message), `page size not reported: ${empty.message}`);

  const drifted = [item({ id: CARD_ID }), item({ id: '8234297329', isReserved: null })];
  const refused = await failureOf(() => apply(
    routes(ssrRoute(), apiRoute(apiState({ items: drifted }))), 'params[159478]=18629557', { 'remove-reserved': true },
  ).rows);
  assert(refused?.code === 'COMMAND_EXEC', `drifted flag accepted: ${refused && refused.code}`);
  assert(/reservation flag/.test(refused.message), `unexpected message: ${refused.message}`);
});

// `;` separates filters, `,` separates values of one filter, `..` carries a range and an
// empty value clears. All four are parsed fail-closed: a malformed entry would otherwise
// reach Avito as a different request than the one that was asked for (D-032).
check('the set grammar is parsed fail-closed', async () => {
  const [ram, price, user] = normalizeSelections('params[159478]=18629557, 18629556 ; price=1000..5000; user= ');
  assert(JSON.stringify(ram.values) === JSON.stringify(['18629557', '18629556']), `values not parsed: ${JSON.stringify(ram)}`);
  assert(price.from === '1000' && price.to === '5000' && price.kind === 'range', `range not parsed: ${JSON.stringify(price)}`);
  assert(user.clear === true && user.values.length === 0, `clear not parsed: ${JSON.stringify(user)}`);

  const [open] = normalizeSelections('price=..30000');
  assert(open.from === null && open.to === '30000', `an open lower bound must parse: ${JSON.stringify(open)}`);

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
    const driven = apply(routes(), set);
    const failure = await failureOf(() => driven.rows);
    assert(failure?.code === 'ARGUMENT', `"${set}" accepted: ${failure && failure.code}`);
    assert(pattern.test(failure.message), `unexpected message for "${set}": ${failure.message}`);
    assert(driven.page.calls.length === 0, `"${set}" reached the network`);
  }
});

// Commander keeps only the last repeat of a named option, so before 2026-08-15 a second
// --set silently dropped the first selection and the output looked completely normal (F-050).
check('a repeated --set is refused instead of silently keeping the last one', async () => {
  const argv = process.argv;
  process.argv = [...argv, '--set', 'params[159478]=18629557', '--set', 'params[121588]=2850684'];
  const failure = await failureOf(() => apply(routes()).rows).finally(() => { process.argv = argv; });
  assert(failure?.code === 'ARGUMENT', `repeated --set accepted: ${failure && failure.code}`);
  assert(/set may be passed once/.test(failure.message), `unexpected message: ${failure.message}`);
});

// A filtered page 2 would be a different page 2 after filtering, so the two
// operations stay separate rather than one of them guessing the other.
check('a page-2 search URL is refused instead of filtered', async () => {
  const driven = apply(routes(ssrRoute(ssrState({ page: 2 }))));
  const failure = await failureOf(() => driven.rows);
  assert(failure?.code === 'ARGUMENT', `a page-2 URL was filtered: ${failure && failure.code}`);
  assert(/avito get-page/.test(failure.message), `the caller must be pointed at get-page: ${failure.message}`);
  assert(driven.page.calls.length === 1, 'the API was asked from a page-2 source');
});

export default await run('apply-filters');
