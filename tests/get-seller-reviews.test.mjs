// Offline checks for get-seller-reviews: argument guards, the node flow against stubbed
// item and ratings responses, and the real browser-side GET.
//
// The synthetic feed mirrors what was confirmed live in F-046: an ordered entries array of
// score / searchParametersV2 / info / rating blocks, reviews without a score field, an
// answer object on some entries, and a server-generated nextPage that echoes the applied sort.
import { loadCommand, runner } from './harness.mjs';
import { evaluateRunner } from './carrier.mjs';
// The browser half of this command is the shared JSON read: it has no decoding of
// its own, so there is nothing in src/browser/commands/ for it and the suite covers the
// shared function directly.
import { readJsonResponse } from '../src/browser/prelude/json.mjs';

const { COMMAND } = await loadCommand('get-seller-reviews');
const { check, assert, run } = runner();

const ITEM_URL = 'https://www.avito.ru/moskva/telefony/iphone_13_512_gb_2_sim_7991622089';
const ITEM_ID = '7991622089';
const ITEM_API = 'https://www.avito.ru/items/ads/moskva/telefony/iphone_13_512_gb_2_sim_7991622089';
const KEY = '054d2ab8d18813855a821ea4abc2ae7d64b613bcc8951faf2925e13b055d2cf2';
const FEED_PATH = `/web/7/user/${KEY}/ratings`;
const SORTS = ['goods_relevant_desc', 'date_desc', 'date_asc', 'score_desc', 'score_asc'];

function itemPayload({ id = ITEM_ID, rating = { userKey: KEY, scoreFloat: 4.9, summary: '829 отзывов' } } = {}) {
  return { buyerItem: { item: { id, title: 'iPhone 13' }, rating } };
}

function scoreBlock() {
  return { type: 'score', value: { reviewCount: 829, scoreFloat: 4.9, subtitle: '829 отзывов' } };
}

function schemaBlock(selectedOption) {
  return {
    type: 'searchParametersV2',
    value: {
      blocks: [
        { sort: { paramName: 'sortRating', options: SORTS.map((value) => ({ label: value, value })), selectedOption } },
        { inlineBoolFilter: { paramName: 'photoOnly', label: 'Только с фото', selected: false } },
      ],
      requiredFilters: ['sortRating', 'photoOnly'],
    },
  };
}

function reviewEntry(overrides = {}) {
  return {
    type: 'rating',
    value: {
      avatar: { '100x100': 'https://90.img.avito.st/image/1/avatar.jpg' },
      id: 467199178,
      itemTitle: 'iPhone 13 mini, 256 ГБ',
      rated: '7 августа',
      score: 5,
      stageTitle: 'Сделка состоялась',
      textSections: [{ text: 'Нужный товар был в наличии, без проблем' }],
      title: 'Арина',
      titleCaption: 'Покупатель',
      ...overrides,
    },
  };
}

const UNSCORED = reviewEntry({
  id: 420465716,
  score: undefined,
  stageTitle: 'Не договорились',
  textSections: [{ text: 'Товар был продан до оформления' }],
  title: 'Виктория',
  answer: {
    answerId: 17503446,
    answered: '21 октября 2022',
    title: 'Ирина',
    text: 'Окончательной договорённости о сделке не было',
    link: 'https://www.avito.ru/user/85ac93c66b68bcbc9d40063018acda4f/profile?src=ratings',
  },
});
delete UNSCORED.value.score;

const INFO = { type: 'info', value: { title: 'Отзывы без оценки', titleSize: 'h30' } };

function feedPayload({ entries, nextOffset = null, sort = 'date_desc' } = {}) {
  const payload = { entries };
  if (nextOffset != null) {
    payload.nextPage = `${FEED_PATH}?fromItem=${ITEM_ID}&limit=25&offset=${nextOffset}&photoOnly=false&sortRating=${sort}`;
  }
  return payload;
}

const ok = (payload) => ({
  responseStatus: 200,
  responseContentType: 'application/json',
  responseParseError: false,
  accessChallenge: false,
  payload,
});

/** A page whose responder decides what each requested URL returns. */
function makePage(responder) {
  const calls = { goto: [], requests: [] };
  return {
    calls,
    async goto(url) { calls.goto.push(url); },
    async evaluateWithArgs(source, args) {
      calls.requests.push(args.requestUrl);
      return responder(args.requestUrl, calls.requests.length);
    },
  };
}

/** The default happy path: item context plus one first feed page. */
function defaultResponder(feed) {
  return (url) => {
    if (url === ITEM_API) return ok(itemPayload());
    return ok(feed);
  };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to fail');
}

check('a non-Avito URL and an ID-less URL are rejected before any request', async () => {
  const page = makePage(() => { throw new Error('no request expected'); });
  for (const url of ['https://example.com/item_123', 'https://www.avito.ru/moskva/telefony', 'http://www.avito.ru/x_1']) {
    const error = await failure(COMMAND.run(page, { itemUrl: url }));
    assert(error.code === 'ARGUMENT', `${url} produced ${error.code}: ${error.message}`);
  }
  assert(page.calls.goto.length === 0, 'the guards must run before the browser is touched');
});

check('page and sort shape are validated before any request', async () => {
  const page = makePage(() => { throw new Error('no request expected'); });
  const cases = [
    { page: 0 }, { page: -1 }, { page: 2.5 }, { page: 'two' },
    { sort: 'Date Desc!' }, { sort: '' }, { sort: 'ab' },
  ];
  for (const extra of cases) {
    const error = await failure(COMMAND.run(page, { itemUrl: ITEM_URL, ...extra }));
    assert(error.code === 'ARGUMENT', `${JSON.stringify(extra)} produced ${error.code}: ${error.message}`);
  }
  assert(page.calls.goto.length === 0, 'argument guards must not open a browser context');
});

check('the feed request carries fromItem, the server page size and no sort by default', async () => {
  const page = makePage(defaultResponder(feedPayload({
    entries: [scoreBlock(), schemaBlock('goods_relevant_desc'), reviewEntry()],
  })));
  await COMMAND.run(page, { itemUrl: ITEM_URL });

  assert(page.calls.goto[0] === 'https://www.avito.ru/robots.txt', 'origin priming must stay lightweight');
  assert(page.calls.requests.length === 2, `expected two requests, got ${page.calls.requests.length}`);
  assert(page.calls.requests[0] === ITEM_API, `unexpected item URL ${page.calls.requests[0]}`);
  const feed = new URL(page.calls.requests[1]);
  assert(feed.pathname === FEED_PATH, `unexpected feed path ${feed.pathname}`);
  assert(feed.searchParams.get('fromItem') === ITEM_ID, 'fromItem must be sent');
  assert(feed.searchParams.get('limit') === '25', 'the request must ask for the server page size');
  assert(feed.searchParams.get('offset') === '0', 'default offset must be 0');
  assert(feed.searchParams.get('photoOnly') === 'false', 'photoOnly must be explicit');
  assert(feed.searchParams.get('sortRating') === null, 'no sort must be sent without --sort');
});

check('the feed decodes the visible review, and an unscored review keeps score null', async () => {
  const page = makePage(defaultResponder(feedPayload({
    entries: [scoreBlock(), schemaBlock('date_desc'), reviewEntry(), INFO, UNSCORED],
  })));
  const answer = await COMMAND.run(page, { itemUrl: ITEM_URL });

  assert(answer.reviews.length === 2, `expected two reviews, got ${answer.reviews.length}`);
  for (const key of COMMAND.keys) assert(key in answer, `${key} is missing from the answer`);
  // The seller's total is one number for the whole feed, and no longer repeats
  // on all twenty-five reviews (D-073).
  assert(answer.sellerReviewsCount === 829, 'sellerReviewsCount must come from the visible item summary');
  assert(answer.itemId === ITEM_ID && answer.page === 1 && answer.sort === null,
    `the subject of the feed must be named: ${JSON.stringify({ itemId: answer.itemId, page: answer.page })}`);
  assert(answer.reviews.every((review) => !('sellerReviewsCount' in review)),
    'the seller total must not repeat on every review');

  const [scored, unscored] = answer.reviews;
  assert(scored.reviewId === 467199178 && scored.score === 5, 'the scored review lost its identity or score');
  assert(scored.stage === 'Сделка состоялась' && scored.rated === '7 августа', 'stage/rated must stay visible strings');
  assert(scored.authorName === 'Арина' && scored.authorRole === 'Покупатель', 'author fields drifted');
  assert(scored.text === 'Нужный товар был в наличии, без проблем', 'review text drifted');
  assert(scored.answerText === null && scored.answered === null, 'a review without an answer must stay null');

  assert(unscored.score === null, 'a review without a score must not collapse to 0');
  assert(unscored.stage === 'Не договорились', 'the unscored stage drifted');
  assert(unscored.answerText === 'Окончательной договорённости о сделке не было', 'the seller answer was lost');
  assert(unscored.answered === '21 октября 2022', 'the answer date was lost');
});

// Photos left this command with the size vocabulary they needed: a review that still
// ships them decodes as text, and the key is passed over rather than refused.
check('a review that ships photos decodes without them', async () => {
  const withImages = reviewEntry({
    images: [
      {
        '1280x960': 'https://50.img.avito.st/image/1/big.jpg',
        originalSize: { width: 720, height: 960 },
      },
    ],
  });
  const page = makePage(defaultResponder(feedPayload({ entries: [scoreBlock(), withImages] })));
  const [review] = (await COMMAND.run(page, { itemUrl: ITEM_URL })).reviews;
  assert(!('images' in review), 'a review must carry no photo field');
  assert(review.text.length > 0, 'the review text must survive a payload that carries photos');
});

check('a seller without a rating is an empty result, not an empty success', async () => {
  const page = makePage((url) => {
    if (url === ITEM_API) return ok(itemPayload({ rating: null }));
    throw new Error('the feed must not be requested without a rating key');
  });
  const error = await failure(COMMAND.run(page, { itemUrl: ITEM_URL }));
  assert(error.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${error.code}`);
  assert(page.calls.requests.length === 1, 'the feed request must be skipped');
});

check('an empty page beyond the feed is an empty result', async () => {
  const page = makePage(defaultResponder(feedPayload({ entries: [] })));
  const error = await failure(COMMAND.run(page, { itemUrl: ITEM_URL, page: 5 }));
  assert(error.code === 'EMPTY_RESULT', `expected EMPTY_RESULT, got ${error.code}`);
  assert(error.message.includes('page 5'), 'the message must name the requested page');
  assert(new URL(page.calls.requests[1]).searchParams.get('offset') === '100',
    'page 5 must translate into the server offset of four full pages');
});

check('a sort outside this seller vocabulary is an argument error listing the real options', async () => {
  const page = makePage(defaultResponder(feedPayload({
    entries: [scoreBlock(), schemaBlock('date_desc'), reviewEntry()],
  })));
  const error = await failure(COMMAND.run(page, { itemUrl: ITEM_URL, sort: 'price_desc' }));
  assert(error.code === 'ARGUMENT', `expected ARGUMENT, got ${error.code}`);
  assert(error.message.includes('goods_relevant_desc') && error.message.includes('score_asc'),
    'the error must list the vocabulary Avito advertised');
});

check('a silently substituted sort fails closed on the first page', async () => {
  const page = makePage(defaultResponder(feedPayload({
    entries: [scoreBlock(), schemaBlock('date_desc'), reviewEntry()],
  })));
  const error = await failure(COMMAND.run(page, { itemUrl: ITEM_URL, sort: 'score_asc' }));
  assert(error.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${error.code}`);
  assert(error.message.includes('date_desc'), 'the message must name the sort Avito actually applied');
});

check('a deep page confirms the sort through the server-generated nextPage', async () => {
  const good = makePage(defaultResponder(feedPayload({
    entries: [reviewEntry()], nextOffset: 50, sort: 'score_asc',
  })));
  const answer = await COMMAND.run(good, { itemUrl: ITEM_URL, sort: 'score_asc', page: 2 });
  assert(answer.reviews.length === 1, 'the deep page must return its reviews');
  assert(answer.page === 2 && answer.sort === 'score_asc', 'the confirmed page and sort must be reported');
  assert(good.calls.requests.length === 2, 'a confirmed deep page must not cost a third request');

  const drifted = makePage(defaultResponder(feedPayload({
    entries: [reviewEntry()], nextOffset: 50, sort: 'date_desc',
  })));
  const error = await failure(COMMAND.run(drifted, { itemUrl: ITEM_URL, sort: 'score_asc', page: 2 }));
  assert(error.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${error.code}`);
  assert(error.message.includes('date_desc'), 'the message must name the applied sort');
});

check('a served page other than the requested one fails closed', async () => {
  const page = makePage(defaultResponder(feedPayload({ entries: [reviewEntry()], nextOffset: 25 })));
  const error = await failure(COMMAND.run(page, { itemUrl: ITEM_URL, page: 2 }));
  assert(error.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${error.code}`);
  assert(error.message.includes('page 1'), 'the message must show what Avito actually served');
});

check('a deep last page with a sort costs one bounded confirmation request', async () => {
  const page = makePage((url, index) => {
    if (index === 1) return ok(itemPayload());
    if (index === 2) return ok(feedPayload({ entries: [reviewEntry()] }));
    return ok(feedPayload({ entries: [scoreBlock(), schemaBlock('score_asc'), reviewEntry()] }));
  });
  const answer = await COMMAND.run(page, { itemUrl: ITEM_URL, sort: 'score_asc', page: 2 });
  assert(answer.reviews.length === 1, 'the last page must still return its reviews');
  assert(page.calls.requests.length === 3, `expected one confirmation request, got ${page.calls.requests.length - 2}`);
  const confirmation = new URL(page.calls.requests[2]);
  assert(confirmation.searchParams.get('offset') === '0', 'the confirmation must read the feed start');
  assert(confirmation.searchParams.get('sortRating') === 'score_asc', 'the confirmation must use the requested sort');

  const unconfirmable = makePage((url, index) => {
    if (index === 1) return ok(itemPayload());
    return ok(feedPayload({ entries: [reviewEntry()] }));
  });
  const error = await failure(COMMAND.run(unconfirmable, { itemUrl: ITEM_URL, sort: 'score_asc', page: 2 }));
  assert(error.code === 'COMMAND_EXEC', `expected COMMAND_EXEC, got ${error.code}`);
});

check('the whole server page is returned, never a local slice of it', async () => {
  const entries = [scoreBlock(), schemaBlock('date_desc')];
  for (let index = 0; index < 25; index += 1) entries.push(reviewEntry({ id: 400000000 + index }));
  const page = makePage(defaultResponder(feedPayload({ entries, nextOffset: 25 })));
  const answer = await COMMAND.run(page, { itemUrl: ITEM_URL });
  assert(answer.reviews.length === 25, `expected every review Avito served, got ${answer.reviews.length}`);
  assert(new URL(page.calls.requests[1]).searchParams.get('limit') === '25',
    'the request must keep the page size the Avito UI itself sends');
  assert(!('limit' in Object.fromEntries(COMMAND.args.map((arg) => [arg.name, arg]))),
    'the command must not advertise a limit Avito ignores');
});

check('a foreign item, a malformed entry and a challenge all stop the command', async () => {
  const foreignItem = makePage(() => ok(itemPayload({ id: '1234567890' })));
  const idError = await failure(COMMAND.run(foreignItem, { itemUrl: ITEM_URL }));
  assert(idError.code === 'COMMAND_EXEC' && idError.message.includes(ITEM_ID), 'a foreign item must fail closed');

  const malformed = makePage(defaultResponder(feedPayload({ entries: [reviewEntry({ id: 'not-a-number' })] })));
  const entryError = await failure(COMMAND.run(malformed, { itemUrl: ITEM_URL }));
  assert(entryError.code === 'COMMAND_EXEC', `a malformed entry produced ${entryError.code}`);

  const blocked = makePage(() => ({
    responseStatus: 429, responseContentType: 'text/html', responseParseError: true, accessChallenge: true, payload: null,
  }));
  const blockedError = await failure(COMMAND.run(blocked, { itemUrl: ITEM_URL }));
  assert(blockedError.code === 'COMMAND_EXEC' && /verification|cooldown/i.test(blockedError.message),
    'a challenge must stop the command');
  assert(blocked.calls.requests.length === 1, 'a blocked session must not issue the feed request');
});

check('the browser-side GET reports status, content type and the challenge signal', async () => {
  const runEvaluate = evaluateRunner(readJsonResponse);

  const good = await runEvaluate({ requestUrl: `https://www.avito.ru${FEED_PATH}` }, async () => ({
    status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    text: async () => JSON.stringify({ entries: [] }),
  }));
  assert(good.responseStatus === 200 && !good.responseParseError, 'a JSON response must parse');
  assert(good.accessChallenge === false, 'a clean response must not look like a challenge');
  assert(Array.isArray(good.payload.entries), 'the payload must be returned for Node-side decoding');

  const throttled = await runEvaluate({ requestUrl: 'https://www.avito.ru/x' }, async () => ({
    status: 429,
    headers: { get: () => 'text/html' },
    text: async () => '<html>Доступ ограничен</html>',
  }));
  assert(throttled.accessChallenge === true, 'HTTP 429 must be reported as a challenge');

  const failed = await runEvaluate({ requestUrl: 'https://www.avito.ru/x' }, async () => { throw new Error('network down'); });
  assert(failed.requestError === 'network down', 'a transport failure must be reported, not swallowed');
});

export default await run('avito/seller-reviews (offline)');
