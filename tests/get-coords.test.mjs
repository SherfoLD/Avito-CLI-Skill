// Offline checks for get-coords: the node flow plus the real browser half, against a
// stubbed geocoder response.
import { loadCommand, readCommandSource, readPageSource, runner } from './harness.mjs';
import { evaluateRunner } from './carrier.mjs';
import { readCoords } from '../src/browser/commands/get-coords.mjs';

const { COMMAND } = await loadCommand('get-coords');
const { check, assert, run } = runner();

const ROBOTS = 'https://www.avito.ru/robots.txt';
const ENDPOINT = '/web/1/coords/by_address';
const runEvaluate = evaluateRunner(readCoords);

const HOUSE = {
  components: [
    { kind: 'country', name: 'Россия' },
    { kind: 'province', name: 'Москва' },
    { kind: 'locality', name: 'Москва' },
    { kind: 'street', name: 'Тверская улица' },
    { kind: 'house', name: '6с1' },
  ],
  kind: 'house',
  normalizedAddress: 'Россия, Москва, Тверская улица, 6с1',
  point: { latitude: 55.760256, longitude: 37.611446 },
  postalCode: '125009',
};

const LOCALITY = {
  components: [
    { kind: 'country', name: 'Россия' },
    { kind: 'province', name: 'Республика Татарстан' },
    { kind: 'locality', name: 'Казань' },
  ],
  kind: 'locality',
  normalizedAddress: 'Россия, Республика Татарстан, Казань',
  point: { latitude: 55.796127, longitude: 49.106414 },
};

function makePage(observed) {
  const calls = { goto: [], evaluateWithArgs: [] };
  return {
    calls,
    async goto(url) { calls.goto.push(url); },
    async evaluateWithArgs(source, args) {
      calls.evaluateWithArgs.push({ source: String(source), args });
      return typeof observed === 'function' ? observed(args) : observed;
    },
  };
}

const ok = (payload) => ({
  responseStatus: 200,
  responseContentType: 'application/json',
  responseParseError: false,
  accessChallenge: false,
  notFound: false,
  payload,
});

check('a house resolves to one row carrying Avito own normalized address', async () => {
  const page = makePage(ok(HOUSE));
  const rows = await COMMAND.run(page, { address: '  Тверская   улица, 6 ' });
  assert(rows.length === 1, 'expected exactly one row');
  const [row] = rows;
  assert(row.address === HOUSE.normalizedAddress, `normalized address not returned: ${row.address}`);
  assert(row.kind === 'house' && row.locality === 'Москва', 'kind or locality not decoded');
  assert(row.latitude === 55.760256 && row.longitude === 37.611446, 'coordinates not decoded');
  assert(row.postalCode === '125009', 'postal code not decoded');
  assert(Object.keys(row).length === COMMAND.columns.length, 'row shape drifted from the declared columns');

  assert(page.calls.goto.length === 1 && page.calls.goto[0] === ROBOTS, `expected one robots.txt priming, got ${JSON.stringify(page.calls.goto)}`);
  const { requestUrl } = page.calls.evaluateWithArgs[0].args;
  assert(requestUrl.startsWith(`https://www.avito.ru${ENDPOINT}?address=`), `unexpected endpoint: ${requestUrl}`);
  assert(decodeURIComponent(new URL(requestUrl).searchParams.get('address')) === 'Тверская улица, 6', 'address not collapsed and passed verbatim');
});

check('a bare city resolves to its centre without a postal code', async () => {
  const rows = await COMMAND.run(makePage(ok(LOCALITY)), { address: 'Казань' });
  assert(rows[0].kind === 'locality' && rows[0].locality === 'Казань', 'locality row not decoded');
  assert(rows[0].postalCode === null, 'missing postal code must be null, not empty text');
});

check('an unknown address is a typed empty result, never a city centre', async () => {
  const observed = {
    responseStatus: 404,
    responseContentType: 'application/json',
    responseParseError: false,
    accessChallenge: false,
    notFound: true,
    payload: { result: { message: 'Address not found' }, status: 'not-found' },
  };
  let failure = null;
  try {
    await COMMAND.run(makePage(observed), { address: 'йцукенгшщз 12345' });
  } catch (error) { failure = error; }
  assert(failure != null && failure.code === 'EMPTY_RESULT', `not-found mistyped: ${failure && failure.code}`);
});

check('malformed, out-of-range and non-JSON responses fail closed', async () => {
  const cases = [
    { observed: ok({ ...HOUSE, point: { latitude: '55.7', longitude: 37.6 } }), expect: /point\.latitude: .*expected number/ },
    { observed: ok({ ...HOUSE, point: { latitude: 95.1, longitude: 37.6 } }), expect: /point\.latitude: Too big/ },
    { observed: ok({ ...HOUSE, normalizedAddress: '   ' }), expect: /normalizedAddress: must not be empty/ },
    { observed: ok({ ...HOUSE, kind: '' }), expect: /kind: must not be empty/ },
    { observed: ok({ kind: 'house', normalizedAddress: 'x' }), expect: /point: .*expected object/ },
    { observed: { ...ok(null), responseContentType: 'text/html', responseParseError: true }, expect: /did not return JSON/ },
    { observed: { ...ok(null), responseStatus: 503 }, expect: /HTTP 503/ },
    { observed: { ...ok(null), accessChallenge: true, responseStatus: 429 }, expect: /human verification|cooldown/ },
  ];
  for (const testCase of cases) {
    let failure = null;
    try {
      await COMMAND.run(makePage(testCase.observed), { address: 'Тверская улица, 6' });
    } catch (error) { failure = error; }
    assert(failure != null, `case ${testCase.expect} did not fail`);
    assert(testCase.expect.test(failure.message), `unexpected message: ${failure.message}`);
  }
});

check('an empty or oversized address never reaches the network', async () => {
  for (const address of ['', '   ', 'x'.repeat(301)]) {
    const page = makePage(ok(HOUSE));
    let failure = null;
    try {
      await COMMAND.run(page, { address });
    } catch (error) { failure = error; }
    assert(failure != null && failure.code === 'ARGUMENT', `accepted address ${JSON.stringify(address.slice(0, 12))}`);
    assert(page.calls.goto.length === 0, 'primed the origin for an invalid address');
  }
});

check('the browser half reports status, challenge and not-found from the real response', async () => {
  const stub = (status, body, contentType = 'application/json') => async () => ({
    status,
    headers: { get: () => contentType },
    async text() { return body; },
  });

  const good = await runEvaluate(
    { requestUrl: `https://www.avito.ru${ENDPOINT}?address=x` },
    stub(200, JSON.stringify(HOUSE)),
  );
  assert(good.responseStatus === 200 && good.notFound === false, 'a 200 was misreported');
  assert(good.payload.point.latitude === 55.760256, 'payload not returned to the Node half');

  const missing = await runEvaluate(
    { requestUrl: `https://www.avito.ru${ENDPOINT}?address=x` },
    stub(404, JSON.stringify({ result: { message: 'Address not found' }, status: 'not-found' })),
  );
  assert(missing.notFound === true && missing.accessChallenge === false, 'not-found not reported');

  const blocked = await runEvaluate(
    { requestUrl: `https://www.avito.ru${ENDPOINT}?address=x` },
    stub(429, 'Доступ ограничен: проблема с IP', 'text/html'),
  );
  assert(blocked.accessChallenge === true, 'a 429 challenge was not reported');
  assert(blocked.responseParseError === true, 'a non-JSON body was not flagged');

  const failed = await runEvaluate(
    { requestUrl: `https://www.avito.ru${ENDPOINT}?address=x` },
    async () => { throw new Error('network down'); },
  );
  assert(/network down/.test(failed.requestError || ''), 'a transport failure was not reported');
});

check('the primed origin is never text-scanned for a challenge', () => {
  const source = readCommandSource('get-coords') + readPageSource('get-coords');
  assert(!/document\.body\.innerText/.test(source), 'coords text-scans a page for a challenge (F-044)');
  assert(/robots\.txt/.test(readCommandSource('get-coords')), 'coords no longer primes a lightweight origin');
});

export default await run('coords (node and browser sides)');
