// Node-level offline checks for the filter reader: which filters reach the caller at all,
// the value syntax it advertises, the shape of the applied value and the request budget.
//
// Everything the command returns must be actionable: one row is one filter `apply-filters`
// can set, `currentValue` is written in the same syntax the caller would pass back, and the
// route state Avito keeps for its own rendering is resolved here instead (D-037).
import { assertRows, loadCommand, runner } from './harness.mjs';

const { COMMAND } = await loadCommand('get-filters');
const { check, assert, run } = runner();

const ROBOTS = 'https://www.avito.ru/robots.txt';
const REQUESTED = 'https://www.avito.ru/moskva/telefony/mobilnye_telefony/xiaomi-ASgB?q=xiaomi';

const FILTERS = [
  { id: 'price', type: 'numericRange', defaultTitle: 'Цена', dimension: '₽', currentValue: { from: null, to: null } },
  {
    id: 'user',
    type: 'radioGroup',
    defaultTitle: 'Продавец',
    values: [{ value: '0', name: 'Все' }, { value: '1', name: 'Частные' }, { value: '2', name: 'Компании' }],
  },
  { id: 'd', type: 'checkboxGroup', defaultTitle: 'Доставка', values: [{ value: '1', name: 'С Авито Доставкой' }] },
  { id: 'localPriority', type: 'boolean', defaultTitle: 'Сначала ближайшие' },
  {
    id: 'sort',
    type: 'select',
    defaultTitle: 'Сортировка',
    // Avito keeps sending the previous selection here even when the server URL proves a new
    // one was applied, which is exactly why searchCore wins for the short keys.
    currentValue: '101',
    values: [{ value: '101', name: 'По умолчанию' }, { value: '104', name: 'По дате' }],
  },
  {
    id: 'footWalkingMetro',
    type: 'select',
    defaultTitle: 'Пешком от метро',
    currentValue: '10',
    values: [{ value: '10', name: 'До 10 минут' }],
  },
  {
    id: 'params[112691]',
    type: 'multiselect',
    attrId: 112691,
    defaultTitle: 'Встроенная память',
    currentValue: ['757883', '757884'],
    values: [{ value: '757883', name: '128 ГБ' }, { value: '757884', name: '256 ГБ' }],
  },
  {
    id: 'params[110618]',
    type: 'select',
    attrId: 110618,
    defaultTitle: 'Производитель',
    currentValue: '469935',
    values: [{ value: '469935', name: 'Xiaomi' }],
  },
  { id: 'params[99001]', type: 'numericRange', attrId: 99001, defaultTitle: 'Год выпуска' },
  { id: 'params[99002]', type: 'keywords', attrId: 99002, defaultTitle: 'Ключевые слова' },
  // A hidden route constraint, and the way Avito ships them in whole rubrics: with no title
  // at all. Neither can be applied, so neither may decide whether this command works.
  { id: 'params[110680]', type: 'hidden', attrId: 110680, defaultTitle: 'Тип телефона', currentValue: '458500' },
  { id: 'params[196930]', type: 'hidden', attrId: 196930, defaultTitle: null, currentValue: 1 },
];

const SEARCH_CORE = {
  page: 1,
  query: 'xiaomi',
  locationId: 637640,
  locationName: 'Москва',
  priceMin: 1000,
  priceMax: 30000,
  owner: 2,
  withDeliveryOnly: 1,
  localPriority: 0,
  sort: '104',
  params: { 112691: ['757883', '757884'] },
};

// What the browser half hands back. It is the same envelope every other command
// uses — `{ success: true, … }` or the typed refusal from `src/browser/
// refusal.mjs` — because the document read itself is shared. A command must not
// grow an envelope of its own here: the node half would then re-derive the
// refusal from a second shape, and the two would drift apart silently.
const observedState = (overrides = {}) => ({
  success: true,
  responseUrl: REQUESTED,
  redirect: null,
  state: {
    url: REQUESTED,
    searchCore: SEARCH_CORE,
    filtersV2: { Sections: [{ Code: 'Main', Filters: FILTERS }] },
    ...overrides,
  },
});

const refusal = (code, message, details = {}) => ({
  success: false, stage: 'schema', code, message, details,
});

function makePage(observed) {
  const calls = { goto: [], evaluateWithArgs: [] };
  return {
    calls,
    async goto(url) { calls.goto.push(url); },
    async wait() {},
    async getCurrentUrl() { throw new Error('the filter reader must not navigate to the catalog'); },
    async evaluateWithArgs(source, args) {
      calls.evaluateWithArgs.push(args);
      return observed;
    },
  };
}

const readFilters = async (observed = observedState()) => {
  const page = makePage(observed);
  return { page, rows: await COMMAND.run(page, { searchUrl: REQUESTED }) };
};

const withFilters = (filters, core = SEARCH_CORE) => observedState({
  searchCore: core,
  filtersV2: { Sections: [{ Code: 'Main', Filters: filters }] },
});

const byKey = (rows, key) => rows.find((row) => row.key === key);

// This command is called at every step of the flow, so it primes the same lightweight
// origin as its neighbours rather than rendering the catalog for one JSON blob.
check('the reader primes robots.txt and never renders the catalog page', async () => {
  const { page } = await readFilters();
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === ROBOTS,
    `expected one robots.txt priming, got ${JSON.stringify(page.calls.goto)}`);
  assert(page.calls.evaluateWithArgs.length === 1, 'more than one browser evaluation');
  assert(page.calls.evaluateWithArgs[0].requestUrl === REQUESTED,
    `the requested URL must be read directly, got ${page.calls.evaluateWithArgs[0].requestUrl}`);
});

// The contract is "every row is a filter you can apply". A key with no confirmed
// serialization, a hidden route constraint and a free-text field are not rows at all.
check('only filters apply-filters can set are returned', async () => {
  const { rows } = await readFilters();
  const returned = rows.map((row) => row.key).sort();
  const expected = [
    'd', 'localPriority', 'params[110618]', 'params[112691]', 'params[99001]', 'params[99002]',
    'price', 'sort', 'user',
  ];
  assert(JSON.stringify(returned) === JSON.stringify(expected),
    `unexpected key set: ${JSON.stringify(returned)}`);
  for (const row of rows) {
    assert(typeof row.valueSyntax === 'string' && row.valueSyntax.length > 0,
      `${row.key} reached the caller without a value syntax`);
  }
});

// Avito ships hidden route constraints with `defaultTitle: null`. A filter nobody can apply
// must not decide whether the route has filters at all (F-055).
check('a nameless hidden constraint is dropped instead of stopping the command', async () => {
  const { rows } = await readFilters();
  assert(byKey(rows, 'params[196930]') === undefined, 'a hidden constraint must not be returned');
  assert(byKey(rows, 'params[110680]') === undefined, 'a hidden constraint must not be returned');
});

check('valueSyntax matches exactly what apply-filters accepts', async () => {
  const { rows } = await readFilters();
  const expected = {
    price: '<from>..<to>',
    user: '<value>',
    d: '<value>',
    localPriority: '1',
    sort: '<value>',
    'params[112691]': '<value>[,<value>]',
    'params[110618]': '<value>',
    'params[99001]': '<from>..<to>',
    'params[99002]': '<text>[,<text>]',
  };
  for (const [key, syntax] of Object.entries(expected)) {
    const row = byKey(rows, key);
    assert(row != null, `${key} is missing from the output`);
    assert(row.valueSyntax === syntax, `${key} advertises ${JSON.stringify(row.valueSyntax)}, expected ${JSON.stringify(syntax)}`);
  }
});

check('a short key reports what searchCore says, not the stale schema facet', async () => {
  const { rows } = await readFilters();
  assert(byKey(rows, 'sort').currentValue === '104', 'sort must follow searchCore, not filtersV2');
  assert(byKey(rows, 'price').currentValue === '1000..30000', 'price must come from searchCore bounds');
  assert(byKey(rows, 'user').currentValue === '2', 'seller must come from searchCore.owner');
  assert(byKey(rows, 'd').currentValue === '1', 'delivery must come from searchCore.withDeliveryOnly');
});

// `currentValue` is written in the syntax of its own key, so the caller passes it back
// verbatim instead of learning one shape per kind of key.
check('an applied value is written in the syntax of its own key', async () => {
  const { rows } = await readFilters();
  assert(byKey(rows, 'params[112691]').currentValue === '757883,757884',
    `a multi selection must join its values, got ${JSON.stringify(byKey(rows, 'params[112691]').currentValue)}`);
  assert(byKey(rows, 'params[110618]').currentValue === '469935',
    'a single selection arriving as a scalar must survive as one value');

  const bounds = [
    [{ priceMin: 1000, priceMax: null }, '1000..'],
    [{ priceMin: null, priceMax: 30000 }, '..30000'],
    [{ priceMin: null, priceMax: null }, null],
  ];
  for (const [core, expected] of bounds) {
    const { rows: priced } = await readFilters(withFilters(FILTERS, { ...SEARCH_CORE, ...core }));
    assert(byKey(priced, 'price').currentValue === expected,
      `${JSON.stringify(core)} must read as ${JSON.stringify(expected)}, got ${JSON.stringify(byKey(priced, 'price').currentValue)}`);
  }
});

// Avito answers `0` for a switch nobody touched. That is not a selection, and `0` is not
// among the values these keys offer, so nothing applied must read as nothing applied.
check('a resting switch reads as nothing applied, not as a value', async () => {
  const { rows } = await readFilters();
  assert(byKey(rows, 'localPriority').currentValue === null,
    `an untouched switch must be null, got ${JSON.stringify(byKey(rows, 'localPriority').currentValue)}`);

  const idle = await readFilters(withFilters(FILTERS, { ...SEARCH_CORE, owner: 0, withDeliveryOnly: 0, sort: '' }));
  for (const key of ['user', 'd', 'sort']) {
    assert(byKey(idle.rows, key).currentValue === null,
      `${key} must be null when nothing is applied, got ${JSON.stringify(byKey(idle.rows, key).currentValue)}`);
  }

  const free = await readFilters(withFilters([
    { id: 'params[112691]', type: 'multiselect', attrId: 112691, defaultTitle: 'Встроенная память', currentValue: [], values: [{ value: '757883', name: '128 ГБ' }] },
  ]));
  assert(free.rows[0].currentValue === null, 'an empty selection means the filter is free');
});

check('an option-less enum is not returned at all', async () => {
  let failure = null;
  try {
    await readFilters(withFilters([
      { id: 'params[112691]', type: 'multiselect', attrId: 112691, defaultTitle: 'Встроенная память', values: [] },
    ]));
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'EMPTY_RESULT',
    `a filter with no fresh vocabulary cannot be applied: ${failure && failure.code}`);
});

// A nested filter belongs to the caller as much as a top-level one, and its parent may well
// be a constraint that is skipped, so the walk continues through what it does not return.
check('a nested filter survives a skipped parent', async () => {
  const { rows } = await readFilters(withFilters([
    {
      id: 'params[110680]',
      type: 'hidden',
      attrId: 110680,
      defaultTitle: null,
      currentValue: 1,
      content: [{
        id: 'params[110618]',
        type: 'select',
        attrId: 110618,
        defaultTitle: 'Производитель',
        values: [{ value: '469935', name: 'Xiaomi' }],
      }],
    },
  ]));
  assert(rows.length === 1 && rows[0].key === 'params[110618]',
    `expected the nested filter alone, got ${JSON.stringify(rows.map((row) => row.key))}`);
});

// Avito groups the options of one control into named sections and repeats the popular ones
// in both groups. A group is presentation and carries no applicable value, so the caller
// gets the options and never the section names (F-060).
check('a sectioned control returns its options, not the names of its groups', async () => {
  const { rows } = await readFilters(withFilters([
    {
      id: 'params[110000]',
      type: 'sectionedMultiselect',
      attrId: 110000,
      defaultTitle: 'Марка',
      currentValue: ['329202'],
      values: [
        { id: '', title: 'Популярные', default: false, icon: null, options: [{ value: '329202', name: 'BMW' }, { value: '329199', name: 'Audi' }] },
        { id: '', title: 'Все', default: true, icon: null, options: [{ value: '329202', name: 'BMW' }, { value: '329199', name: 'Audi' }, { value: '329192', name: 'AC' }] },
      ],
    },
  ]));
  assert(rows.length === 1 && rows[0].key === 'params[110000]', 'the sectioned filter must be returned');
  assert(JSON.stringify(rows[0].options) === JSON.stringify({ 329202: 'BMW', 329199: 'Audi', 329192: 'AC' }),
    `an option repeated across groups is one option: ${JSON.stringify(rows[0].options)}`);
  assert(rows[0].valueSyntax === '<value>[,<value>]', 'a sectioned control takes several values');
  assert(rows[0].currentValue === '329202', 'the applied option survives the flattening');
});

// Both ranges are one row shape, and `options` is what tells the caller what a bound is: a
// numericRange takes plain numbers and offers no vocabulary, a slider takes the option
// values of its own two dropdowns (D-041).
check('a range is a row, and its options say what a bound is', async () => {
  const { rows } = await readFilters(withFilters([
    {
      id: 'params[162396]',
      type: 'slider',
      attrId: 162396,
      defaultTitle: 'Объём двигателя',
      dimension: 'л',
      currentValue: { from: '3261702', to: '3261703' },
      values: [{ value: '3261702', name: '0.2 л' }, { value: '3261703', name: '0.3 л' }],
      inputs: { from: { id: 'params[162396][from]' }, to: { id: 'params[162396][to]' } },
    },
    {
      id: 'params[164669]',
      type: 'numericRange',
      attrId: 164669,
      defaultTitle: 'Год выпуска',
      currentValue: { from: '2015', to: '2018' },
      inputs: { from: { id: 'params[164669][from]' }, to: { id: 'params[164669][to]' } },
    },
  ]));
  const slider = byKey(rows, 'params[162396]');
  const numeric = byKey(rows, 'params[164669]');
  assert(slider != null && numeric != null, `both ranges must be returned: ${JSON.stringify(rows.map((row) => row.key))}`);
  assert(slider.valueSyntax === '<from>..<to>' && numeric.valueSyntax === '<from>..<to>',
    'both ranges advertise the same syntax');
  assert(JSON.stringify(slider.options) === JSON.stringify({ 3261702: '0.2 л', 3261703: '0.3 л' }),
    `a slider must hand over the values its bounds are picked from: ${JSON.stringify(slider.options)}`);
  assert(JSON.stringify(numeric.options) === '{}', 'a numeric range has no vocabulary to offer');
  assert(slider.currentValue === '3261702..3261703' && numeric.currentValue === '2015..2018',
    'an applied range is written the way it is passed back');
});

// The bound nobody set arrives as 0, null or an empty string depending on the carrier, and
// all three mean the same thing: no restriction on that side (F-063).
check('an unset range bound is nothing applied, whichever way Avito writes it', async () => {
  const cases = [
    [{ from: '2015', to: null }, '2015..'],
    [{ from: 0, to: 2018 }, '..2018'],
    [{ from: '', to: '' }, null],
    [{ from: null, to: null }, null],
    [null, null],
  ];
  for (const [currentValue, expected] of cases) {
    const { rows } = await readFilters(withFilters([
      { id: 'params[164669]', type: 'numericRange', attrId: 164669, defaultTitle: 'Год выпуска', currentValue },
    ]));
    assert(rows[0].currentValue === expected,
      `${JSON.stringify(currentValue)} must read as ${JSON.stringify(expected)}, got ${JSON.stringify(rows[0].currentValue)}`);
  }
});

// A keyword field is the one row whose values nobody wrote down: Avito carries back exactly
// what was typed, spaces and case included, so its syntax says "text" instead of pretending
// to offer options (F-064).
check('a keyword field is a row that takes text', async () => {
  const { rows } = await readFilters(withFilters([
    {
      id: 'params[149569]',
      type: 'keywords',
      attrId: 149569,
      defaultTitle: 'Слова в описании',
      currentValue: ['Kingston HyperX', 'новая'],
    },
  ]));
  assert(rows.length === 1 && rows[0].key === 'params[149569]', 'the keyword field must be returned');
  assert(rows[0].valueSyntax === '<text>[,<text>]', `unexpected syntax ${JSON.stringify(rows[0].valueSyntax)}`);
  assert(JSON.stringify(rows[0].options) === '{}', 'a keyword field offers no options');
  assert(rows[0].currentValue === 'Kingston HyperX,новая',
    `typed words come back verbatim, got ${JSON.stringify(rows[0].currentValue)}`);
});

// A checkbox has no vocabulary at all: Avito draws it with a picture next to it and its own
// control sends `1`, so that is the only value the caller can pass (F-062).
check('a checkbox is a row that takes exactly 1', async () => {
  const { rows } = await readFilters(withFilters([
    {
      id: 'params[191434]',
      type: 'bannerCheckBoxWithImage',
      attrId: 191434,
      defaultTitle: 'Надёжный исполнитель',
      currentValue: 1,
    },
  ]));
  assert(rows.length === 1 && rows[0].key === 'params[191434]', 'the checkbox must be returned');
  assert(rows[0].valueSyntax === '1', `a checkbox takes 1, not ${JSON.stringify(rows[0].valueSyntax)}`);
  assert(JSON.stringify(rows[0].options) === '{}', 'a checkbox offers no options');
  assert(rows[0].currentValue === '1', 'an applied checkbox reads as applied');
});

// The mirror image of the checkbox above: a control Avito draws in the filter form that
// holds no value of its own. The car picker only fills the three ordinary filters it names
// itself, so it is not a row — and it must not stop the command either, the way an undecoded
// type does (F-066).
check('the car picker is not a row and does not stop the command', async () => {
  const { rows } = await readFilters(withFilters([
    {
      id: 'params[1216774800]',
      type: 'garageEntrypoint',
      attrId: 1216774800,
      defaultTitle: null,
      values: [],
      displaying: { title: 'Укажите авто', carInfmParams: { brand: '110000', model: '110001', generation: '110005' } },
    },
    { id: 'params[110000]', type: 'select', attrId: 110000, defaultTitle: 'Марка авто', values: [{ value: '329202', name: 'BMW' }] },
  ]));
  assert(byKey(rows, 'params[1216774800]') === undefined, 'the picker must not be returned');
  assert(byKey(rows, 'params[110000]') != null, 'the filters the picker fills are ordinary rows');
});

// A vocabulary Avito really ships must reach the caller whole: truck parts name 12150
// manufacturers in one control, and cutting the list would be exactly the silent clamp this
// command refuses elsewhere (F-067). The ceiling that remains catches implausible data.
check('a vocabulary of thousands of options is returned whole, never clamped', async () => {
  const values = Array.from({ length: 12150 }, (_, index) => ({ value: String(400000 + index), name: `Производитель ${index}` }));
  const { rows } = await readFilters(withFilters([
    { id: 'params[110548]', type: 'multiselect', attrId: 110548, defaultTitle: 'Производитель', values },
  ]));
  assert(rows.length === 1 && rows[0].key === 'params[110548]', 'the filter must be returned');
  assert(Object.keys(rows[0].options).length === 12150,
    `expected every option, got ${Object.keys(rows[0].options).length}`);
  assert(rows[0].options['400000'] === 'Производитель 0' && rows[0].options['412149'] === 'Производитель 12149',
    'both ends of the vocabulary must survive');
});

check('the unit Avito measures the filter in stays with the filter', async () => {
  const { rows } = await readFilters();
  assert(byKey(rows, 'price').unit === '₽', 'a dimension must reach the caller');
  assert(byKey(rows, 'user').unit === null, 'a filter without a dimension carries null');
});

check('the row fills exactly the declared columns', async () => {
  const { rows } = await readFilters();
  assertRows(COMMAND, rows);
});

// Dropping what cannot be applied is not the same as tolerating drift: a filter that is
// returned is still decoded strictly, and an API type nobody has seen still stops the run.
check('a drifted schema of a returned filter still fails closed', async () => {
  const cases = [
    {
      filters: [{ id: 'params[112691]', type: 'multiselect', attrId: 112691, defaultTitle: 'Память', values: [{ name: 'без значения' }] }],
      expect: /malformed option/,
    },
    {
      filters: [{ id: 'params[112691]', type: 'multiselect', attrId: 112691, defaultTitle: null, values: [{ value: '1', name: '128 ГБ' }, { value: '2', name: '256 ГБ' }] }],
      expect: /has no stable name/,
    },
    {
      filters: [{ id: 'params[112691]', type: 'segmentedSlider', attrId: 112691, defaultTitle: 'Память', values: [{ value: '1', name: '128 ГБ' }] }],
      expect: /unsupported key\/type/,
    },
    {
      filters: [{ id: 'params[164669]', type: 'numericRange', attrId: 164669, defaultTitle: 'Год выпуска', currentValue: ['2015', '2018'] }],
      expect: /implausible currentValue/,
    },
    {
      // A third side is a bound this reader does not apply, and `RANGE_VALUE`
      // is the one strict object in the tree for exactly that reason.
      filters: [{ id: 'params[164669]', type: 'numericRange', attrId: 164669, defaultTitle: 'Год выпуска', currentValue: { from: '2015', to: '2018', step: '1' } }],
      expect: /currentValue: must be \{from, to\}/,
    },
    {
      filters: [{
        id: 'params[110000]',
        type: 'sectionedMultiselect',
        attrId: 110000,
        defaultTitle: 'Марка',
        values: [
          { id: '', title: 'Популярные', options: [{ value: '329202', name: 'BMW' }] },
          { id: '', title: 'Все', options: [{ value: '329202', name: 'БМВ' }] },
        ],
      }],
      expect: /two different names/,
    },
    {
      filters: [{
        id: 'params[110000]',
        type: 'sectionedMultiselect',
        attrId: 110000,
        defaultTitle: 'Марка',
        values: [
          { id: '', title: 'Все', options: [{ value: '329202', name: 'BMW' }] },
          { value: '329199', name: 'Audi' },
        ],
      }],
      expect: /mixes sectioned and flat values/,
    },
    {
      filters: [{ id: 'params[112691]', type: 'multiselect', attrId: 112691, defaultTitle: 'Память', currentValue: [{ nested: true }], values: [{ value: '1', name: '128 ГБ' }] }],
      expect: /currentValue: must be/,
    },
    {
      filters: [{
        id: 'params[110548]',
        type: 'multiselect',
        attrId: 110548,
        defaultTitle: 'Производитель',
        values: Array.from({ length: 20001 }, (_, index) => ({ value: String(index), name: `Опция ${index}` })),
      }],
      expect: /malformed or implausible values/,
    },
    {
      filters: [
        { id: 'params[112691]', type: 'multiselect', attrId: 112691, defaultTitle: 'Память', values: [{ value: '1', name: '128 ГБ' }] },
        { id: 'params[112691]', type: 'select', attrId: 112691, defaultTitle: 'Память', values: [{ value: '1', name: '128 ГБ' }] },
      ],
      expect: /duplicate key/,
    },
  ];
  for (const testCase of cases) {
    let failure = null;
    try {
      await readFilters(withFilters(testCase.filters));
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'COMMAND_EXEC',
      `expected COMMAND_EXEC, got ${failure && failure.code}`);
    assert(testCase.expect.test(failure.message), `unexpected message: ${failure.message}`);
  }
});

check('a challenge, a bad status and an empty schema fail closed', async () => {
  const cases = [
    { observed: refusal('access', 'Доступ ограничен', { status: 429 }), code: 'ACCESS', expect: /not answering this session/ },
    { observed: refusal('no_state', 'Доступ ограничен', { status: 200 }), code: 'ACCESS', expect: /not answering this session/ },
    { observed: refusal('http', 'Avito SSR request failed', { status: 500 }), code: 'COMMAND_EXEC', expect: /HTTP 500/ },
    { observed: refusal('content_type', 'Avito SSR response is not HTML', { contentType: 'application/json' }), code: 'COMMAND_EXEC', expect: /application\/json/ },
    // A document with no state is not "this route has no filters": a route
    // without filters still ships a bootstrap, with an empty Sections list.
    { observed: refusal('no_state', 'Avito answered a page with no state'), code: 'ACCESS', expect: /not answering this session/ },
  ];
  for (const testCase of cases) {
    let failure = null;
    try {
      await COMMAND.run(makePage(testCase.observed), { searchUrl: REQUESTED });
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === testCase.code,
      `expected ${testCase.code}, got ${failure && failure.code}: ${failure && failure.message}`);
    assert(testCase.expect.test(failure.message), `unexpected message: ${failure.message}`);
  }
});

check('a non-Avito or relative URL never reaches the network', async () => {
  for (const searchUrl of ['', 'moskva/telefony', 'https://example.com/moskva', 'http://www.avito.ru/moskva']) {
    const page = makePage(observedState());
    let failure = null;
    try {
      await COMMAND.run(page, { searchUrl });
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'ARGUMENT', `"${searchUrl}" accepted: ${failure && failure.code}`);
    assert(page.calls.goto.length === 0, `"${searchUrl}" reached the browser`);
  }
});

export default await run('get-filters (node side)');
