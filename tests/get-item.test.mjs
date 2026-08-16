// Offline checks for the buyerItem decoder, against synthetic payloads.
import { parseHTML } from 'linkedom';
import { loadCommand, readCommandSource, readPageSource, runner } from './harness.mjs';
import { decodeBuyerItemInBrowser } from '../src/browser/prelude/item.mjs';

// The decoder parses description markup with the browser's DOMParser. A browser puts a bare
// fragment into <body>; linkedom returns a document without one, so the shim adds the
// wrapper a browser would have added and leaves the parsing itself to linkedom.
const { DOMParser: LinkedomParser } = parseHTML('<html></html>');
const env = { DOMParser: class {
  parseFromString(markup, type) {
    return new LinkedomParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, type);
  }
} };

const { decodeVisiblePrice, normalizeItemUrl } = await loadCommand(
  'get-item',
  ['decodeVisiblePrice', 'normalizeItemUrl'],
);

const ITEM_ID = '7950831088';

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
  // seconds. The exact instant lives in the search row instead (F-059).
  sortFormatedDate = '14 августа в 02:15',
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
      imageUrls,
    },
    paramsDto: categoryItems == null ? null : { items: categoryItems },
    galleryInfo: galleryMedia == null ? null : { media: galleryMedia },
    publicProfile: { link: sellerLink },
    seller: { name: sellerName },
    rating: { scoreFloat: ratingScore, summary: ratingSummary },
  };
}

const decode = (overrides) => decodeBuyerItemInBrowser(buyerItem(overrides), ITEM_ID, env);

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

check('decodeVisiblePrice reads one number and fails closed on anything else', () => {
  assert(decodeVisiblePrice('46 882 ₽') === 46882, 'a single spaced number must be read');
  assert(decodeVisiblePrice('46\u00a0882\u00a0₽') === 46882, 'non-breaking spaces must be handled');
  assert(decodeVisiblePrice('46 882 ₽ 46 999 ₽') === null, 'two numbers must fail closed');
  assert(decodeVisiblePrice('Цена договорная') === null, 'text without digits must be null');
  assert(decodeVisiblePrice('') === null && decodeVisiblePrice(null) === null, 'empty input must be null');
  assert(decodeVisiblePrice('46 882 ₽ 46 882 ₽') === 46882, 'the same number twice is not ambiguous');
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
  assert(decode({ sortFormatedDate: false }).decodedPublishedText === null, 'an absent date must be a null column');
  assert(decode({ sortFormatedDate: '' }).decodedPublishedText === null, 'an empty date must be a null column');
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
  assert(decodeBuyerItemInBrowser(buyerItem({ id: '8030214066' }), ITEM_ID, env) === null, 'a mismatched item ID must fail closed');
  assert(decodeBuyerItemInBrowser(null, ITEM_ID, env) === null, 'a missing payload must fail closed');
  assert(decodeBuyerItemInBrowser({ item: null }, ITEM_ID, env) === null, 'a missing item must fail closed');
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

check('the visible-page fallback primes robots.txt and reads the marked price node', () => {
  // These read the DOM of a real listing, which cannot be built here, so the current
  // source is asserted directly instead of executed. The split between the two halves is
  // why there are two sources now: the navigation belongs to the command, the selectors
  // to the browser half.
  const source = readCommandSource('get-item');
  const browserSource = readPageSource('get-item');
  assert(source.includes("const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt'"), 'priming must use the lightweight origin');
  assert(source.includes('page.goto(ORIGIN_BOOTSTRAP_URL'), 'the API context must be primed through robots.txt, not the homepage');
  assert(browserSource.includes('[data-marker="item-view/item-price"]'), 'the fallback must read the marked price node');
  assert(source.includes('price: decodeVisiblePrice(fallbackObserved.domObservedPriceText)'), 'the fallback price must go through the fail-closed parser');
  // The page prints the same string the item API ships, with a leading middot.
  assert(browserSource.includes('[data-marker="item-view/item-date"]'), 'the fallback must read the marked date node');
  assert(source.includes('publishedText: fallbackObserved.domObservedPublishedText'), 'the fallback must carry the date it read');
});

check('the primed origin is never text-scanned for a challenge, the API response is', () => {
  // robots.txt lists "captcha" in its own Clean-param directives, so a detector run against
  // the primed page reports a challenge that is not there.
  const source = readCommandSource('get-item');
  const browserSource = readPageSource('get-item');
  assert(!/looksLikeChallenge/.test(source), 'the primed page must not be scanned for challenge text');
  assert(browserSource.includes('accessChallenge: response.status === 429'), 'the API response must carry the challenge verdict');
  assert(source.includes('apiAttempt?.accessChallenge'), 'a challenged API response must stop the command');
});

export default await run('item decoder (browser-side function)');
