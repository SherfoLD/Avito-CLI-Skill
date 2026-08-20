// Offline checks for the buyerItem decoder, against synthetic payloads, and for the
// photo writer, against a stubbed CDN and a temporary directory.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertOutput, loadCommand, readCommandSource, readPageSource, runner } from './harness.mjs';
import { decodeBuyerItem } from '../src/site/item.mjs';
import { assertPhotoDirectory, savePhotos } from '../src/site/photos.mjs';

const { COMMAND, normalizeItemUrl } = await loadCommand('get-item', ['normalizeItemUrl']);

const ITEM_ID = '7950831088';
const ITEM_URL = `https://www.avito.ru/moskva/tovary_dlya_kompyutera/ddr5_${ITEM_ID}`;
const PHOTO_A = 'https://20.img.avito.st/image/1/first.jpg';
const PHOTO_B = 'https://50.img.avito.st/image/1/second.jpg';

// Shapes copied from the live carrier: the page prints formattedPrice.string, while
// formattedPrice.value and item.price keep the base price.
function buyerItem({
  id = ITEM_ID,
  title = 'V-Color XSky RGB DDR5 32GB',
  priceString = '46 882',
  basePrice = 46999,
  description = 'Память в наличии.',
  descriptionHtml = null,
  imageUrls = [{ '1280x960': 'https://20.img.avito.st/image/1/big.jpg', '640x480': 'https://20.img.avito.st/image/1/small.jpg' }],
  galleryMedia = null,
  conditionItems = [{ title: 'Состояние:', description: 'Новое' }],
  categoryItems = [{ title: 'Тип памяти', description: 'DDR5' }],
  sellerLink = '/user/f98a1b2c3d4e/profile',
  sellerName = 'AMD INTEL',
  ratingSummary = '2 015 отзывов',
  ratingScore = 4.9,
  locationName = 'Москва',
  // The only date the listing surface carries anywhere: a rendered string, no year and no
  // seconds. The exact instant lives on the search card instead (F-059).
  sortFormatedDate = '14 августа в 02:15',
  // A service is priced by a table and by nothing else: the scalar carriers are all
  // empty, and the page prints the groups exactly as they arrive (F-080).
  priceList = null,
} = {}) {
  return {
    item: {
      id,
      title,
      price: basePrice,
      formattedPrice: priceString == null ? null : { string: priceString, value: basePrice, oldString: String(basePrice), saleDiscountType: 'bonus' },
      description,
      descriptionHtml,
      hasWysiwyg: descriptionHtml != null,
      location: locationName ? { name: locationName } : null,
      searchLocation: [{ name: 'Москва', current: true }],
      conditionParams: conditionItems == null ? null : { data: { items: conditionItems } },
      ...(sortFormatedDate === false ? {} : { sortFormatedDate }),
      priceList,
      imageUrls,
    },
    paramsDto: categoryItems == null ? null : { items: categoryItems },
    galleryInfo: galleryMedia == null ? null : { media: galleryMedia },
    publicProfile: { link: sellerLink },
    seller: { name: sellerName },
    rating: { scoreFloat: ratingScore, summary: ratingSummary },
  };
}

const decode = (overrides) => decodeBuyerItem(buyerItem(overrides), ITEM_ID);

const { check, assert, run } = runner();

check('the visible bonus price is decoded, not the base price', () => {
  const decoded = decode();
  assert(decoded !== null, 'decoder rejected a valid payload');
  assert(decoded.decodedPrice === 46882, `expected the printed 46 882, got ${decoded.decodedPrice}`);
});

check('a price string with two numbers falls back to the base price instead of concatenating', () => {
  const decoded = decode({ priceString: '46 882 ₽ 46 999 ₽' });
  assert(decoded.decodedPrice === 46999, `expected the base price fallback, got ${decoded.decodedPrice}`);
  const missing = decode({ priceString: 'Цена договорная' });
  assert(missing.decodedPrice === 46999, `expected the base price fallback, got ${missing.decodedPrice}`);
});

// A service has no price, it has a table of them, and the listing page prints nothing
// where a goods listing prints its number. The entries keep Avito's own strings, and the
// groups merge because the field holds a table rather than a tree (F-080).
check('a price table replaces the price, and a listing priced by a number keeps one', () => {
  const service = decode({
    priceString: '',
    basePrice: null,
    priceList: {
      title: 'Прайс-лист',
      groups: [
        { title: 'Прайс-лист', isCollapsed: false, values: [
          { title: 'Диагностика (при заказе ремонта)', price: 'Бесплатно', subPrice: null, serviceId: 0, url: null },
          { title: 'Замена подшипников', price: 'от 2 000 ₽', subPrice: null, serviceId: 3233810, url: '/moskva/predlozheniya_uslug/zamena' },
        ] },
        { title: 'Выезд', isCollapsed: true, values: [{ title: 'Выезд за МКАД', price: 'Цена договорная' }] },
      ],
    },
  });
  assert(service.decodedPrice === null, `a table is not a price, got ${service.decodedPrice}`);
  assert(
    JSON.stringify(service.decodedPriceList) === JSON.stringify([
      { title: 'Диагностика (при заказе ремонта)', price: 'Бесплатно' },
      { title: 'Замена подшипников', price: 'от 2 000 ₽' },
      { title: 'Выезд за МКАД', price: 'Цена договорная' },
    ]),
    `unexpected table: ${JSON.stringify(service.decodedPriceList)}`,
  );

  const goods = decode();
  assert(goods.decodedPrice === 46882 && goods.decodedPriceList.length === 0, 'a listing Avito priced with a number keeps it and reports no table');

  for (const malformed of [
    { groups: null },
    { groups: [{ title: 'Прайс-лист' }] },
    { groups: [{ values: [{ title: 'Диагностика' }] }] },
    { groups: [{ values: [{ price: 'Бесплатно' }] }] },
    { groups: [{ values: ['Диагностика'] }] },
  ]) {
    assert(decode({ priceList: malformed }) === null, `a table shaped ${JSON.stringify(malformed)} must fail the item`);
  }
});

check('a WYSIWYG description keeps its visible line breaks and drops markup', () => {
  const decoded = decode({ descriptionHtml: '<p>Первая строка</p><p>Вторая <b>строка</b></p>' });
  assert(decoded.decodedDescription === 'Первая строка\nВторая строка', `unexpected description: ${JSON.stringify(decoded.decodedDescription)}`);
});

check('attributes merge condition and category params and fail closed on a conflict', () => {
  const decoded = decode();
  assert(decoded.decodedAttributes['Состояние'] === 'Новое', 'the condition label must lose its colon');
  assert(decoded.decodedAttributes['Тип памяти'] === 'DDR5', 'category params must be merged');
  const conflict = decode({ categoryItems: [{ title: 'Состояние:', description: 'Б/у' }] });
  assert(conflict === null, 'a conflicting duplicate attribute must fail closed');
  const empty = decode({ categoryItems: [{ title: 'Тип памяти', description: '' }] });
  assert(empty === null, 'an attribute without a value must fail closed');
});

check('the publication date is passed through as Avito rendered it', () => {
  assert(decode().decodedPublishedText === '14 августа в 02:15', 'the rendered date must survive untouched');
  assert(decode({ sortFormatedDate: false }).decodedPublishedText === null, 'an absent date must read as null');
  assert(decode({ sortFormatedDate: '' }).decodedPublishedText === null, 'an empty date must read as null');
  // Nothing here parses the string into a date Avito never sent, so the only failure left is
  // a carrier that stopped being a string at all.
  assert(decode({ sortFormatedDate: 1786662941000 }) === null, 'a non-string date carrier must fail closed');
});

// Anonymously the item API blanks every profile route of a private seller and puts the
// placeholder "Пользователь" where the name was. The name is therefore nullable by contract,
// and it stays whatever Avito printed — the decoder does not turn it into a guess or into
// an error (F-049).
check('an anonymous private seller keeps the name Avito sent and its rating', () => {
  const anonymous = decode({ sellerLink: '', sellerName: 'Пользователь' });
  assert(anonymous !== null, 'a blank profile link must not fail the whole item');
  assert(anonymous.decodedSellerName === 'Пользователь', `expected the sent name, got ${anonymous.decodedSellerName}`);
  assert(anonymous.decodedSellerReviewsCount === 2015 && anonymous.decodedSellerRating === 4.9, 'the rating must survive');
});

check('review counts follow the visible summary and fail closed when malformed', () => {
  assert(decode().decodedSellerReviewsCount === 2015, 'a spaced count must be parsed');
  assert(decode({ ratingSummary: 'Нет отзывов' }).decodedSellerReviewsCount === 0, '"нет отзывов" must be zero');
  assert(decode({ ratingSummary: null }).decodedSellerReviewsCount === null, 'a missing summary must be null');
  assert(decode({ ratingSummary: 'много отзывов' }) === null, 'a malformed summary must fail closed');
  assert(decode({ ratingScore: 7 }) === null, 'an out-of-range rating must fail closed');
});

check('images take the largest variant, survive a renamed key and reject foreign hosts', () => {
  assert(decode().decodedImages[0] === 'https://20.img.avito.st/image/1/big.jpg', 'the high-resolution variant must win');
  const smallOnly = decode({ imageUrls: [{ '640x480': 'https://20.img.avito.st/image/1/small.jpg' }] });
  assert(smallOnly.decodedImages[0].endsWith('small.jpg'), 'the only offered variant must be used');
  // Avito owns the size vocabulary: a bigger unknown size wins, a renamed key still
  // works, and keys that are not sizes at all fail closed instead of dropping the photo.
  const bigger = decode({ imageUrls: [{ '1280x960': 'https://20.img.avito.st/image/1/big.jpg', '1920x1440': 'https://20.img.avito.st/image/1/huge.jpg' }] });
  assert(bigger.decodedImages[0].endsWith('huge.jpg'), 'a larger unknown size must win');
  const renamed = decode({ imageUrls: [{ '1440x1080': 'https://20.img.avito.st/image/1/renamed.jpg' }] });
  assert(renamed.decodedImages[0].endsWith('renamed.jpg'), 'a renamed size key must still be readable');
  assert(decode({ imageUrls: [{ thumb: 'https://20.img.avito.st/image/1/x.jpg' }] }) === null,
    'a photo with no size variant must fail closed, not disappear');
  const foreign = decode({ imageUrls: [{ '1280x960': 'https://example.com/one.jpg' }] });
  assert(foreign === null, 'a non-Avito image host must fail closed');
  const gallery = decode({
    imageUrls: null,
    galleryMedia: [
      { isVideo: true, urls: {} },
      { urls: { '1280x960': 'https://20.img.avito.st/image/1/gallery.jpg' } },
    ],
  });
  assert(gallery.decodedImages.length === 1 && gallery.decodedImages[0].endsWith('gallery.jpg'), 'gallery videos must be skipped');
});

check('a payload for another item never decodes', () => {
  assert(decodeBuyerItem(buyerItem({ id: '8030214066' }), ITEM_ID) === null, 'a mismatched item ID must fail closed');
  assert(decodeBuyerItem(null, ITEM_ID) === null, 'a missing payload must fail closed');
  assert(decodeBuyerItem({ item: null }, ITEM_ID) === null, 'a missing item must fail closed');
});

check('the input URL must be a full Avito item URL', () => {
  const parsed = normalizeItemUrl('https://www.avito.ru/moskva/tovary/ddr5_7950831088/');
  assert(parsed.normalizedItemId === ITEM_ID, 'the trailing slash must be normalized away');
  assert(parsed.normalizedUrl === 'https://www.avito.ru/moskva/tovary/ddr5_7950831088', 'the normalized URL must drop the trailing slash');
  assert(parsed.itemApiUrl === 'https://www.avito.ru/items/ads/moskva/tovary/ddr5_7950831088', 'the API URL must mirror the pathname');
  for (const bad of ['7950831088', 'http://www.avito.ru/moskva/ddr5_7950831088', 'https://example.com/ddr5_7950831088', 'https://www.avito.ru/moskva/ddr5']) {
    let threw = false;
    try { normalizeItemUrl(bad); } catch (error) { threw = error.code === 'ARGUMENT'; }
    assert(threw, `"${bad}" must be an ArgumentError`);
  }
});

check('the fallback primes the origin and reads the hydration state, never the DOM', () => {
  // A rendered listing cannot be built here, so the current source is asserted directly
  // instead of executed. The split between the two halves is why there are two sources:
  // the navigation belongs to the command, the carrier to the browser half.
  const source = readCommandSource('get-item');
  const browserSource = readPageSource('get-item');
  assert(source.includes("primeOrigin(page, 'get-item')"), 'the API context must be primed through the shared primeOrigin (D-081)');
  assert(!/page\.goto\((?!normalizedUrl)/.test(source), 'the only navigation this command owns is the rendered listing');
  assert(browserSource.includes('__staticRouterHydrationData'), 'the fallback must read the hydration state of the rendered page');
  assert(source.includes('decodeBuyerItem(fallbackObserved?.buyerItem'), 'the fallback must come from the shared decoder');
  assert(!/decodeBuyerItem/.test(browserSource), 'the page half hands the carrier over, it does not decode it');
  // Both carriers are the same object, so both have one meaning per field (D-064).
  assert(!/querySelector|data-marker=/.test(browserSource), 'the rendered page must not be read through DOM anchors');
  assert(!/domObserved/.test(source), 'no field may be assembled from the visible page');
});

check('the primed origin is never text-scanned for a challenge, the API response is', () => {
  // The primed origin is a document like any other and may render to anything, including
  // the block page. What the command acts on is the challenge on the answer, not on it.
  const source = readCommandSource('get-item');
  const browserSource = readPageSource('get-item');
  assert(!/looksLikeChallenge/.test(source), 'the primed page must not be scanned for challenge text');
  assert(browserSource.includes('accessChallenge: response.status === 429'), 'the API response must carry the challenge verdict');
  assert(source.includes('apiAttempt?.accessChallenge'), 'a challenged API response must stop the command');
});

/** A CDN answer: the status, the one header that decides the file, and the bytes. */
function answer(contentType, body = 'jpeg bytes', status = 200) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avito-photos-'));

/** The item API answered, and nothing else in the command has to run. */
const apiPage = (rawBuyerItem) => ({
  goto: async () => {},
  evaluate: async () => 'null',
  wait: async () => {},
  evaluateWithArgs: async () => ({
    responseOk: true,
    responseStatus: 200,
    responseContentType: 'application/json',
    buyerItem: rawBuyerItem,
  }),
});

const twoPhotos = () => buyerItem({
  imageUrls: [{ '1280x960': PHOTO_A }, { '1280x960': PHOTO_B }],
});

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail and did not');
}

check('the photo directory is an argument, and is checked before anything is fetched', () => {
  const existing = temporaryDirectory();
  try {
    assert(assertPhotoDirectory(existing) === existing, 'an existing absolute directory must be accepted');
    for (const [requested, expected] of [
      ['', /directory path/],
      ['photos', /absolute path/],
      [path.join(existing, 'missing'), /does not exist/],
      [path.join(existing, 'file.txt'), /not a directory/],
    ]) {
      if (requested.endsWith('file.txt')) fs.writeFileSync(requested, 'x');
      let refused = null;
      try {
        assertPhotoDirectory(requested);
      } catch (error) {
        refused = error;
      }
      assert(refused?.code === 'ARGUMENT' && expected.test(refused.message),
        `${JSON.stringify(requested)} produced ${refused?.code}: ${refused?.message}`);
    }
  } finally {
    fs.rmSync(existing, { recursive: true, force: true });
  }
});

// Nothing converts an image here, so the request is what makes the file readable: the CDN
// picks the format from `Accept` and answers jpeg to a header that asks for one (F-086).
check('photos land in gallery order, in a directory named after the item', async () => {
  const root = temporaryDirectory();
  try {
    const asked = [];
    const files = await savePhotos([PHOTO_A, PHOTO_B], {
      directory: root,
      itemId: ITEM_ID,
      fetchImpl: async (url, init) => {
        asked.push(init.headers.accept);
        return answer('image/jpeg', url);
      },
    });
    assert(files.length === 2, `expected two files, got ${files.length}`);
    assert(files[0] === path.join(root, ITEM_ID, '01.jpg'), `unexpected first path ${files[0]}`);
    assert(files[1] === path.join(root, ITEM_ID, '02.jpg'), `unexpected second path ${files[1]}`);
    assert(fs.readFileSync(files[1], 'utf8') === PHOTO_B, 'the second file holds the second photo');
    assert(asked.every((accept) => accept === 'image/jpeg, image/png'),
      `the request must ask for a format nothing has to convert, asked ${asked.join(' | ')}`);
    assert(fs.readdirSync(root).length === 1, 'only the item subdirectory may be created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// One photo of five is phase 25's question, and the answer here is the rule: no partial
// gallery, and the text of the listing is one run without the flag away.
check('anything but a photo this CLI can hand over stops the call, leaving no partial gallery', async () => {
  const root = temporaryDirectory();
  try {
    const cases = [
      [async () => answer('image/webp'), /converts an image/],
      [async () => answer('text/html', 'nope', 404), /HTTP 404/],
      [async () => answer('image/jpeg', ''), /came back empty/],
      [async () => { throw new Error('socket hang up'); }, /could not be fetched: socket hang up/],
    ];
    for (const [fetchImpl, expected] of cases) {
      const error = await refusal(savePhotos([PHOTO_A], { directory: root, itemId: ITEM_ID, fetchImpl }));
      assert(error.code === 'COMMAND_EXEC' && expected.test(error.message),
        `expected ${expected}, got ${error.code}: ${error.message}`);
      assert(error.message.includes('photo 1 of 1'), `the refusal must name the photo, got ${error.message}`);
      assert(fs.readdirSync(path.join(root, ITEM_ID)).length === 0, 'a refused gallery must leave no file behind');
    }

    // The URLs come out of the page, so the host rule is checked again on this side —
    // it is the only thing standing between page output and a request of our own.
    const foreign = await refusal(savePhotos(['https://evil.example.com/photo.jpg'], {
      directory: root,
      itemId: ITEM_ID,
      fetchImpl: async () => answer('image/jpeg'),
    }));
    assert(/outside Avito photo hosting/.test(foreign.message), `unexpected refusal ${foreign.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('get-item writes the gallery only when it was asked to, and the answer says which', async () => {
  const root = temporaryDirectory();
  const realFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async (url) => {
      requests += 1;
      return answer('image/jpeg', url);
    };

    const written = assertOutput(COMMAND, await COMMAND.run(apiPage(twoPhotos()), { url: ITEM_URL, 'images-dir': root }));
    assert(written.imageCount === 2, `expected two photos, got ${written.imageCount}`);
    assert(written.images.length === 2 && written.images[0] === path.join(root, ITEM_ID, '01.jpg'),
      `unexpected paths ${JSON.stringify(written.images)}`);
    assert(requests === 2, `expected one request per photo, got ${requests}`);

    const plain = assertOutput(COMMAND, await COMMAND.run(apiPage(twoPhotos()), { url: ITEM_URL }));
    assert(plain.images === null, 'without the flag the answer states that nothing was written');
    assert(plain.imageCount === 2, 'the count is read from the item either way');
    assert(requests === 2, 'a run without the flag must not touch the photo CDN');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export default await run('get-item');
