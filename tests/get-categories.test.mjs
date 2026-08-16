// Node-level offline checks for the category sidebar reader: the failure paths a verify
// fixture cannot reach, because you cannot ask Avito for a malformed sidebar.
//
// This command follows nothing, but `move-category` follows what it prints, so a row
// described wrongly here sends that command at the wrong route.
import { assertRows, loadCommand, runner } from './harness.mjs';
import { ORIGIN } from './carrier.mjs';

const { COMMAND } = await loadCommand('get-categories');
const { check, assert, run } = runner();

const ROBOTS = 'https://www.avito.ru/robots.txt';
const SOURCE_PATH = '/moskva/telefony/mobilnye_telefony/xiaomi-ASgB';
const REQUESTED = `${ORIGIN}${SOURCE_PATH}?q=xiaomi`;

// Avito hangs the text query on every navigable sidebar URL; a row that does not
// carry it leads to a plain category browse instead of this search.
const withQuery = (path) => `${path}${path.includes('?') ? '&' : '?'}cd=1&q=xiaomi`;

const node = ({
  id,
  name,
  type = 1,
  url = withQuery('/moskva/telefony/mobilnye_telefony-ASgB'),
  children = [],
  isCurrent = false,
  isOpened = false,
  hasBack = false,
} = {}) => ({ id, name, type, url, children, isCurrent, isOpened, hasBack });

const SIDE_NODES = [
  node({
    id: 1,
    name: 'Телефоны',
    type: 0,
    isOpened: true,
    url: '/moskva/telefony',
    children: [
      node({ id: 2, name: 'Мобильные телефоны' }),
      node({ id: 3, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery(SOURCE_PATH) }),
      node({ id: 4, name: 'Аксессуары', url: '/moskva/telefony/aksessuary-ASgB' }),
    ],
  }),
];

const SEARCH_CORE = {
  page: 1,
  query: 'xiaomi',
  locationId: 637640,
  locationName: 'Москва',
};

const observedState = (overrides = {}) => ({
  success: true,
  responseUrl: REQUESTED,
  url: REQUESTED,
  searchCore: SEARCH_CORE,
  sideNodes: SIDE_NODES,
  ...overrides,
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
    async evaluateWithArgs(source, args) {
      calls.evaluateWithArgs.push(args);
      return observed;
    },
  };
}

const readCategories = async (observed = observedState()) => {
  const page = makePage(observed);
  return { page, rows: await COMMAND.run(page, { searchUrl: REQUESTED }) };
};

const withNodes = (sideNodes, core = SEARCH_CORE) => observedState({ sideNodes, searchCore: core });
const byName = (rows, name) => rows.find((row) => row.name === name);

const refuses = async (observed, pattern, code = 'COMMAND_EXEC') => {
  let failure = null;
  try {
    await readCategories(observed);
  } catch (error) { failure = error; }
  if (failure == null) throw new Error(`accepted what should have been refused: ${pattern}`);
  if (failure.code !== code) throw new Error(`expected ${code}, got ${failure.code}: ${failure.message}`);
  if (!pattern.test(failure.message)) throw new Error(`unexpected message: ${failure.message}`);
};

check('the reader primes robots.txt once and never renders the catalog page', async () => {
  const { page } = await readCategories();
  assert(page.calls.goto.length === 1 && page.calls.goto[0] === ROBOTS,
    `expected one robots.txt priming, got ${JSON.stringify(page.calls.goto)}`);
  assert(page.calls.evaluateWithArgs.length === 1, 'more than one browser evaluation');
  assert(page.calls.evaluateWithArgs[0].requestUrl === REQUESTED,
    `the requested URL must be read directly, got ${page.calls.evaluateWithArgs[0].requestUrl}`);
});

// The sidebar is returned in the order Avito drew it, nesting included: rank is
// the reading order and depth is the indentation, so a caller can reconstruct
// the tree without this command inventing one.
check('every node becomes a row in Avito order, with its depth', async () => {
  const { rows } = await readCategories();
  assert(rows.length === 4, `expected the whole sidebar, got ${rows.length}`);
  assert(JSON.stringify(rows.map((row) => row.rank)) === '[1,2,3,4]', 'rank must be the reading order');
  assert(rows[0].name === 'Телефоны' && rows[0].depth === 0, 'the branch comes first at depth 0');
  assert(rows.slice(1).every((row) => row.depth === 1), 'its children are one level deeper');
  assertRows(COMMAND, rows);
});

// The three roles are Avito's node type, shared with move-category; `back` is the
// one this command adds, and it wins over the type because that is what the row
// is for the caller.
check('role names what the node is, and back wins over the type', async () => {
  const { rows } = await readCategories();
  assert(byName(rows, 'Телефоны').role === 'expanded', 'an opened branch is expanded');
  assert(byName(rows, 'Мобильные телефоны').role === 'option', 'a followable row is an option');
  assert(byName(rows, 'Xiaomi').role === 'current', 'the current category says so');

  const { rows: back } = await readCategories(withNodes([
    node({ id: 1, name: 'Телефоны', url: withQuery('/moskva/telefony'), hasBack: true }),
    node({ id: 2, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery(SOURCE_PATH) }),
  ]));
  assert(byName(back, 'Телефоны').role === 'back', 'a row Avito marks as the way up is back');
  assert(byName(back, 'Телефоны').navigable === true, 'a back row is still followable');
});

// Only an option carries a route. An expanded branch and the current row keep a
// URL in the bootstrap, and neither may reach the caller as a searchUrl: the
// first cannot be followed, and moving to where you already are is not a move.
check('only an option carries a searchUrl, and the other rows carry null', async () => {
  const { rows } = await readCategories();
  assert(byName(rows, 'Мобильные телефоны').searchUrl?.startsWith(ORIGIN), 'an option must carry its route');
  assert(byName(rows, 'Телефоны').searchUrl === null, 'an expanded branch carries no route');
  assert(byName(rows, 'Xiaomi').searchUrl === null, 'the current category carries no route');
  assert(byName(rows, 'Телефоны').navigable === false && byName(rows, 'Xiaomi').navigable === false,
    'neither row is navigable');
});

// This is the column move-category acts on: a row that drops the query would
// return an unrelated category listing, and that command refuses exactly those.
check('preservesQuery tells the caller which move keeps the search', async () => {
  const { rows } = await readCategories();
  assert(byName(rows, 'Мобильные телефоны').preservesQuery === true, 'a row carrying q preserves the search');
  assert(byName(rows, 'Аксессуары').preservesQuery === false, 'a row without q does not');
  assert(byName(rows, 'Телефоны').preservesQuery === null, 'a row that cannot be followed answers nothing');

  // A query-less search: every row preserves a query there is none of, and that
  // must read as true rather than as "unknown".
  const { rows: browse } = await readCategories(withNodes(
    [node({ id: 1, name: 'Мобильные телефоны', url: '/moskva/telefony/mobilnye_telefony-ASgB' })],
    { ...SEARCH_CORE, query: '' },
  ));
  assert(browse[0].preservesQuery === true, 'with no query to keep, a plain route keeps it');
});

check('hasChildren describes the node, not the row order', async () => {
  const { rows } = await readCategories();
  assert(byName(rows, 'Телефоны').hasChildren === true, 'the branch has children');
  assert(byName(rows, 'Мобильные телефоны').hasChildren === false, 'a leaf has none');
});

// A sidebar whose state contradicts its type is one this command cannot
// describe, and describing it wrongly would send move-category at the wrong
// route. Each of these is refused rather than rendered.
check('a node whose state contradicts its type stops the command', async () => {
  const cases = [
    [[node({ id: 1, name: 'Телефоны', type: 0, isOpened: false, children: [node({ id: 2, name: 'A' })] })],
      /inconsistent type\/state/],
    [[node({ id: 1, name: 'Телефоны', type: 0, isOpened: true, children: [] })], /inconsistent type\/state/],
    [[node({ id: 1, name: 'Мобильные телефоны', isCurrent: true })], /inconsistent type\/state/],
    [[node({ id: 1, name: 'Xiaomi', type: 2, isCurrent: false })], /inconsistent type\/state/],
    [[node({ id: 1, name: 'Телефоны', type: 7 })], /unsupported type/],
    [[node({ id: 1, name: 'Телефоны', children: 'not an array' })], /children: .*expected array/],
    [[node({ id: 1, name: 'Телефоны', isOpened: 'yes' })], /isOpened: .*expected boolean/],
    [[node({ id: 0, name: 'Телефоны' })], /id: Too small/],
    [[node({ id: 1, name: 'A' }), node({ id: 1, name: 'B' })], /repeats node ID 1/],
    [[node({ id: 1, name: '   ' })], /name: must not be empty/],
    [[node({ id: 1, name: 'Телефоны', url: 'https://example.com/moskva' })], /points outside/],
    [[node({ id: 1, name: 'Телефоны', url: '' })], /missing URL/],
    [['not a node at all'], /expected object, received string/],
  ];
  for (const [sideNodes, pattern] of cases) {
    await refuses(withNodes(sideNodes), pattern);
  }
});

check('two current categories at once is a sidebar this command refuses', async () => {
  await refuses(withNodes([
    node({ id: 1, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery(SOURCE_PATH) }),
    node({ id: 2, name: 'Redmi', type: 2, isCurrent: true, url: withQuery(SOURCE_PATH) }),
  ]), /multiple current categories/);
});

check('a sidebar that is not a sidebar, and one with no nodes, fail closed', async () => {
  await refuses(observedState({ sideNodes: null }), /unexpected shape/);
  await refuses(observedState({ sideNodes: [] }), /no category navigation/, 'EMPTY_RESULT');
});

// The state and the response must describe the same page. A bootstrap for
// another route would name categories that do not belong to this search.
check('a bootstrap belonging to another route is refused', async () => {
  await refuses(observedState({ url: `${ORIGIN}/moskva/telefony` }), /changed the search pathname/);
});

check('a malformed searchCore is refused before any node is read', async () => {
  await refuses(observedState({ searchCore: null }), /navigation state has an unexpected shape/);
  await refuses(observedState({ searchCore: { ...SEARCH_CORE, query: 42 } }), /query: .*expected string/);
  await refuses(observedState({ searchCore: { ...SEARCH_CORE, locationId: 0 } }), /locationId: Too small/);
});

check('a challenge, a bad status and an empty bootstrap fail closed', async () => {
  const cases = [
    { observed: refusal('access', 'Доступ ограничен', { status: 429 }), code: 'COMMAND_EXEC', expect: /human verification/ },
    { observed: refusal('http', 'Avito SSR request failed', { status: 500 }), code: 'COMMAND_EXEC', expect: /HTTP 500/ },
    { observed: refusal('content_type', 'Avito SSR response is not HTML', { contentType: 'application/json' }), code: 'COMMAND_EXEC', expect: /application\/json/ },
    { observed: refusal('missing', 'Avito SSR bootstrap carries no page state'), code: 'EMPTY_RESULT', expect: /no SSR search state/ },
    { observed: refusal('parse', 'Avito SSR bootstrap carries no page state'), code: 'COMMAND_EXEC', expect: /malformed/ },
  ];
  for (const testCase of cases) {
    await refuses(testCase.observed, testCase.expect, testCase.code);
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

export default await run('get-categories (node side)');
