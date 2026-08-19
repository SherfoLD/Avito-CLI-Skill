// Node-level offline checks for the category sidebar reader: the failure paths a verify
// live expectation cannot reach, because you cannot ask Avito for a malformed sidebar.
//
// This command follows nothing, but `move-category` follows what it prints, so an entry
// described wrongly here sends that command at the wrong route.
import { assertOutput, loadCommand, runner } from './harness.mjs';
import { ORIGIN } from './carrier.mjs';

const { COMMAND } = await loadCommand('get-categories');
const { check, assert, run } = runner();

const ROBOTS = 'https://www.avito.ru/robots.txt';
const SOURCE_PATH = '/moskva/telefony/mobilnye_telefony/xiaomi-ASgB';
const REQUESTED = `${ORIGIN}${SOURCE_PATH}?q=xiaomi`;

// Avito hangs the text query on every navigable sidebar URL; an entry that does not
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

const observedState = ({ sideNodes = SIDE_NODES, ...overrides } = {}) => ({
  success: true,
  responseUrl: REQUESTED,
  redirect: null,
  state: {
    url: REQUESTED,
    searchCore: SEARCH_CORE,
    rubricators: sideNodes === null ? {} : { side: { nodes: sideNodes } },
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
    async evaluateWithArgs(source, args) {
      calls.evaluateWithArgs.push(args);
      return observed;
    },
  };
}

const readCategories = async (observed = observedState()) => {
  const page = makePage(observed);
  return { page, answer: await COMMAND.run(page, { searchUrl: REQUESTED }) };
};

const withNodes = (sideNodes, core = SEARCH_CORE) => observedState({ sideNodes, searchCore: core });
const byName = (categories, name) => categories.find((entry) => entry.name === name);

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

// The sidebar is returned in the order Avito drew it, nesting included: the array
// order is the reading order, depth the indentation and parent the name above,
// so a caller can reconstruct the tree without this command inventing one.
check('every node is returned in Avito order, with its depth and parent', async () => {
  const { answer } = await readCategories();
  const { categories } = answer;
  assert(categories.length === 4, `expected the whole sidebar, got ${categories.length}`);
  assert(categories[0].name === 'Телефоны' && categories[0].depth === 0, 'the branch comes first at depth 0');
  assert(categories[0].parent === null, 'the top of the tree hangs under nothing');
  assert(categories.slice(1).every((entry) => entry.depth === 1 && entry.parent === 'Телефоны'),
    'its children are one level deeper and name it as their parent');
  assert(answer.query === 'xiaomi' && answer.locationId === '637640',
    `the search this sidebar belongs to must be named: ${answer.query}/${answer.locationId}`);
  assertOutput(COMMAND, answer);
});

// The three roles are Avito's node type, shared with move-category; `back` is the
// one this command adds, and it wins over the type because that is what the entry
// is for the caller.
check('role names what the node is, and back wins over the type', async () => {
  const { answer: { categories } } = await readCategories();
  assert(byName(categories, 'Телефоны').role === 'branch', 'a group head is a branch');
  assert(byName(categories, 'Мобильные телефоны').role === 'option', 'a followable entry is an option');
  assert(byName(categories, 'Xiaomi').role === 'current', 'the current category says so');

  const { answer: { categories: back } } = await readCategories(withNodes([
    node({ id: 1, name: 'Телефоны', url: withQuery('/moskva/telefony'), hasBack: true }),
    node({ id: 2, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery(SOURCE_PATH) }),
  ]));
  assert(byName(back, 'Телефоны').role === 'back', 'an entry Avito marks as the way up is back');
  assert(byName(back, 'Телефоны').navigable === true, 'a back entry is still followable');
});

// The route decides, not the type (D-057): a branch is not an anchor on the
// page and its URL is still a working route. What carries no searchUrl is the
// route the search is already on — moving there is not a move — and a node
// Avito hung no URL on at all.
check('every category with a route of its own carries it, whatever its type', async () => {
  const { answer: { categories } } = await readCategories();
  assert(byName(categories, 'Мобильные телефоны').targetUrl?.startsWith(ORIGIN), 'an option must carry its route');
  assert(byName(categories, 'Телефоны').targetUrl?.startsWith(ORIGIN), 'a branch carries the route Avito gave it');
  assert(byName(categories, 'Телефоны').navigable === true, 'a branch with a route is navigable');
  assert(byName(categories, 'Xiaomi').targetUrl === null && byName(categories, 'Xiaomi').navigable === false,
    'the route this search is already on is not a move');

  // Avito names the current category itself, and that answer outranks the
  // pathname: a canonical route the request did not spell the same way would
  // otherwise be handed over as a move to where the search already is (F-052).
  const { answer: { categories: canonical } } = await readCategories(withNodes([
    node({ id: 1, name: 'Xiaomi', type: 2, isCurrent: true, url: withQuery('/moskva/telefony/xiaomi-ASgB') }),
  ]));
  assert(canonical[0].navigable === false && canonical[0].targetUrl === null,
    'the category Avito marks as current is never a move, whatever its route');

  const { answer: { categories: routeless } } = await readCategories(withNodes([
    node({ id: 1, name: 'Телефоны', type: 0, url: '', children: [node({ id: 2, name: 'Xiaomi' })] }),
  ]));
  assert(byName(routeless, 'Телефоны').navigable === false, 'a node with no URL cannot be followed');
  assert(byName(routeless, 'Телефоны').targetUrl === null, 'and it carries none');
  assert(routeless.length === 2, 'it is still returned, and so are its children');
});

// This is the field move-category acts on: a route that drops the query would
// return an unrelated category listing, and that command refuses exactly those.
check('preservesQuery tells the caller which move keeps the search', async () => {
  const { answer: { categories } } = await readCategories();
  assert(byName(categories, 'Мобильные телефоны').preservesQuery === true, 'an entry carrying q preserves the search');
  assert(byName(categories, 'Аксессуары').preservesQuery === false, 'an entry without q does not');
  assert(byName(categories, 'Xiaomi').preservesQuery === null, 'an entry that cannot be followed answers nothing');

  // A query-less search: every entry preserves a query there is none of, and that
  // must read as true rather than as "unknown".
  const { answer: { categories: browse } } = await readCategories(withNodes(
    [node({ id: 1, name: 'Мобильные телефоны', url: '/moskva/telefony/mobilnye_telefony-ASgB' })],
    { ...SEARCH_CORE, query: '' },
  ));
  assert(browse[0].preservesQuery === true, 'with no query to keep, a plain route keeps it');
});

check('hasChildren describes the node, not the reading order', async () => {
  const { answer: { categories } } = await readCategories();
  assert(byName(categories, 'Телефоны').hasChildren === true, 'the branch has children');
  assert(byName(categories, 'Мобильные телефоны').hasChildren === false, 'a leaf has none');
});

// The shape of a node is this command's business; what the node's state means
// is Avito's. A tree drawn in a way the old invariants called impossible is
// still a tree, and a caller who cannot see it has no way out of the route.
check('a sidebar this command cannot decode stops it', async () => {
  const cases = [
    [[node({ id: 1, name: 'Телефоны', type: 7 })], /unsupported type/],
    [[node({ id: 1, name: 'Телефоны', children: 'not an array' })], /children: .*expected array/],
    [[node({ id: 1, name: 'Телефоны', isOpened: 'yes' })], /isOpened: .*expected boolean/],
    [[node({ id: 0, name: 'Телефоны' })], /id: Too small/],
    [[node({ id: 1, name: 'A' }), node({ id: 1, name: 'B' })], /repeats node ID 1/],
    [[node({ id: 1, name: '   ' })], /name: must not be empty/],
    [[node({ id: 1, name: 'Телефоны', url: 'https://example.com/moskva' })], /route of node 1 outside/],
    // A port and credentials make the route a different origin, and the route is
    // handed out as the next command's argument, which refuses both.
    [[node({ id: 1, name: 'Телефоны', url: 'https://www.avito.ru:8443/moskva' })], /route of node 1 outside/],
    [[node({ id: 1, name: 'Телефоны', url: 'https://user@www.avito.ru/moskva' })], /route of node 1 outside/],
    [['not a node at all'], /expected object, received string/],
  ];
  for (const [sideNodes, pattern] of cases) {
    await refuses(withNodes(sideNodes), pattern);
  }
});

// What Avito draws on a search it could not place in a category: two group
// heads both marked current, one of them collapsed (F-084). This is the route
// where the command is the only way out, so neither is a refusal (D-058).
check('a collapsed branch and two current heads are described, not refused', async () => {
  const { answer } = await readCategories(withNodes([
    node({
      id: 1,
      name: 'Услуги',
      type: 0,
      isCurrent: true,
      isOpened: true,
      url: withQuery('/moskva/predlozheniya_uslug'),
      children: [node({ id: 2, name: 'Компьютерная помощь' })],
    }),
    node({
      id: 3,
      name: 'Электроника',
      type: 0,
      isCurrent: true,
      isOpened: false,
      url: withQuery('/moskva/bytovaya_elektronika'),
      children: [node({ id: 4, name: 'Ноутбуки' })],
    }),
  ]));
  const { categories } = answer;
  assert(categories.length === 4, `expected the whole tree, got ${categories.length}`);
  assert(categories.filter((entry) => entry.current).length === 2, 'both heads say they are current');
  assert(categories.filter((entry) => entry.role === 'branch').every((entry) => entry.navigable && entry.preservesQuery),
    'both heads keep the query and can be moved to');
  assertOutput(COMMAND, answer);
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
    { observed: refusal('access', 'Доступ ограничен', { status: 429 }), code: 'ACCESS', expect: /not answering this session/ },
    { observed: refusal('http', 'Avito SSR request failed', { status: 500 }), code: 'COMMAND_EXEC', expect: /HTTP 500/ },
    { observed: refusal('content_type', 'Avito SSR response is not HTML', { contentType: 'application/json' }), code: 'COMMAND_EXEC', expect: /application\/json/ },
    { observed: refusal('no_state', 'Avito answered a page with no state'), code: 'ACCESS', expect: /not answering this session/ },
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
