// The catalog decoder, checked directly: this is the boundary where an Avito
// payload becomes a listing, and the schema and the fallback chains meet there.
import { runner } from './harness.mjs';
import { catalogItems } from '../src/site/card.mjs';
import { ORIGIN, cardPhoto, item } from './carrier.mjs';

const { check, assert, run } = runner();

const decode = (items) => catalogItems({ items });
const one = (extra = {}) => decode([item(extra)])[0];

/** The message of whatever `catalogItems` threw, or null if it returned. */
function refusal(items) {
  try {
    decode(items);
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

check('a card decodes into the fields the four listing commands declare', () => {
  const card = one();
  assert(card.itemId === '7881841669' && card.title === 'DDR5 32gb Kingston Fury', `identity: ${JSON.stringify(card)}`);
  assert(card.price === 43691, `the visible bonus price is the price, got ${card.price}`);
  assert(card.minPrice === null && card.hasPriceList === false, `not a floor and not a table: ${JSON.stringify(card)}`);
  assert(card.location === 'Китай-город, до 5 мин.', `location: ${card.location}`);
  assert(card.descriptionPreview?.startsWith('Авитодоставка открыта'), `description: ${card.descriptionPreview}`);
  assert(card.published === '2026-08-13T23:15:41Z', `published: ${card.published}`);
  assert(card.sellerName === 'AMD INTEL' && card.sellerRating === 5 && card.sellerReviewsCount === 2015,
    `seller: ${JSON.stringify([card.sellerName, card.sellerRating, card.sellerReviewsCount])}`);
  assert(card.imageCount === 2, `photo count: ${card.imageCount}`);
  assert(card.url === `${ORIGIN}/moskva/tovary_dlya_kompyutera/ddr5_7881841669`, `url: ${card.url}`);
  // `reserved` travels beside the fields and never becomes one.
  assert(card.reserved === false, `reserved: ${card.reserved}`);
});

// The SSR catalog sends its cards past the twentieth without a photo block at
// all, and that is not a listing without photos (F-089, D-062).
check('the photo count separates an empty list from a card that carries no list', () => {
  assert(one({ images: [cardPhoto('one'), cardPhoto('two')] }).imageCount === 2, 'two photos must count as two');
  assert(one({ images: [] }).imageCount === 0, 'a listing Avito says has no photos counts zero');
  assert(one({ images: null }).imageCount === null, 'a card without the key must not count as zero');
  assert(/\b0\.images/.test(refusal([item({ images: 'one photo' })]) ?? ''),
    'a photo list that is not a list is drift, and the message must name the path');
});

// Avito puts banners and widgets in the same two arrays as the cards, and none
// of them would satisfy a card's declarations. They are not listings and they are
// not drift either, so the page must survive one.
check('an entry that is not a listing is skipped rather than failing the page', () => {
  const decoded = catalogItems({
    items: [{ type: 'widget', id: 'promo', images: { main: 'x.jpg' }, sortTimeStamp: 'вчера' }, item()],
  });
  assert(decoded.length === 1 && decoded[0].itemId === '7881841669', `unexpected listings: ${JSON.stringify(decoded)}`);
});

// Avito sends the card text with its own markup in it, and the field carries text.
check('markup Avito sent inside a description becomes the text it renders as', () => {
  const card = one({ description: 'Отправим <b>сегодня</b> &mdash; в наличии' });
  assert(card.descriptionPreview === 'Отправим сегодня — в наличии', `not rendered: ${card.descriptionPreview}`);
  assert(one({ description: 'Комплект 2x16gb' }).descriptionPreview === 'Комплект 2x16gb',
    'text without markup must pass through untouched');
});

// A stamp of the wrong shape is refused by the schema and one of the wrong
// magnitude by the decoder: 1786662941 is seconds where Avito sends
// milliseconds, which reads as January 1970.
check('the publication stamp is the instant Avito prints, and drift stops the call', () => {
  assert(one().published === '2026-08-13T23:15:41Z', 'the stamp must decode to the UTC instant');
  assert(one({ sortTimeStamp: null }).published === null, 'a card without the stamp is still decoded');
  for (const drift of [1786662941, 'вчера', -1, 1.5]) {
    const message = refusal([item({ sortTimeStamp: drift })]);
    assert(message != null && /sortTimeStamp|publication stamp/.test(message),
      `a stamp of ${JSON.stringify(drift)} must stop the call, got ${message}`);
  }
});

// The step is the whole answer: the flat field beside it carries the base price,
// which is a different number on 45 cards of 50 on a live route (F-076, F-093).
check('the price is the number the card prints, and a floor is not a price', () => {
  const floor = one({ priceForm: 'floor' });
  assert(floor.price === null && floor.minPrice === 43691, `«от» is a floor, got ${JSON.stringify(floor)}`);
  assert(one({ priceForm: 'negotiable' }).price === null, '«Цена договорная» is no number at all');
  assert(one({ priceForm: 'free' }).price === 0, '«Бесплатно» is a real zero');
});

// A services card prices by a table, and then the scalar beside it is a floor
// rather than a price (F-079). The table itself belongs to `get-item` (F-081).
check('a card priced by a table says so and hands over no table', () => {
  const priced = one({ priceList: { values: [{ title: 'Стрижка' }], valuesAll: [{ title: 'Стрижка' }] } });
  assert(priced.hasPriceList === true, 'a card with a table must say so');
  assert(priced.price === null && priced.minPrice === 43691, `the scalar beside a table is its floor: ${JSON.stringify(priced)}`);
  assert(!('priceList' in priced), 'the table is not a field of a card');
  assert(/priceList/.test(refusal([item({ priceList: { values: [], countHint: 'Ещё 1 услуга' } })]) ?? ''),
    'a table in an unknown shape is drift, and the message must name the path');
});

// An anonymous session gets no seller-info step at all on a private seller's
// card, while the flat rating survives: identity and rating come from different
// carriers and neither can be derived from the other (F-049, D-028).
check('a card without the seller-info step keeps its rating and returns no name', () => {
  const card = one({ sellerInfo: false, rating: { score: 4.8, summary: '19 отзывов' } });
  assert(card.sellerName === null, `the name must stay null, got ${card.sellerName}`);
  assert(card.sellerRating === 4.8 && card.sellerReviewsCount === 19,
    `the rating must survive, got ${card.sellerRating} / ${card.sellerReviewsCount}`);
  assert(one({ sellerInfo: false, rating: { score: 5, summary: 'нет отзывов' } }).sellerReviewsCount === 0,
    '"нет отзывов" is a real zero, not a missing count');
});

check('the reservation flag is read from the card and an absent key stays null', () => {
  assert(one({ isReserved: true }).reserved === true, 'a reserved card must decode to true');
  assert(one({ isReserved: false }).reserved === false, 'an available card must decode to false');
  assert(one({ isReserved: null }).reserved === null, 'a missing flag must stay null, not become false');
  // An absent key is a field with no answer; a key carrying something else is drift,
  // and answering `null` there would hand `--remove-reserved` the same refusal (F-048).
  for (const drift of ['true', 1, {}]) {
    const message = refusal([{ ...item(), isReserved: drift }]);
    assert(/\bisReserved\b/.test(message ?? ''),
      `isReserved: ${JSON.stringify(drift)} must stop the call naming the path, got ${message}`);
  }
});

// The two steps the card is read from are the only carrier of what it prints, so a
// card without one is drift rather than a value taken from the flat field (D-070).
check('a card that carries neither price step nor description step stops the call', () => {
  assert(/carries no PriceStep/.test(refusal([item({ visiblePrice: null })]) ?? ''),
    'a card with an empty PriceStep must stop the call');
  assert(/carries no DescriptionStep/.test(refusal([item({ description: null })]) ?? ''),
    'a card with an empty DescriptionStep must stop the call');
  const noPrice = { ...item() };
  delete noPrice.iva.PriceStep;
  assert(/carries no PriceStep/.test(refusal([noPrice]) ?? ''),
    'a card with no PriceStep key at all must stop the call');
});

// Which steps a card carries is Avito's to decide — the GeoStep is absent on every
// card of two real-estate routes, where the flat geo carries the same references.
check('a card with no geo step answers its location from the flat carrier', () => {
  const flats = one({ geoStep: false });
  assert(flats.location === 'Китай-город, до 5 мин.', `location: ${flats.location}`);
  assert(one({ geoStep: false, geoReference: null }).location === 'Москва',
    'with neither step nor reference the plain city is the answer');
});

// A step is a list of rendered components. One that is not a list is drift wearing
// the shape of an absent step, and reading it as empty would hide the difference.
check('a step Avito sends in another shape is drift, and the message names the path', () => {
  const bent = { ...item(), iva: { ...item().iva, PriceStep: { componentData: {} } } };
  assert(/\biva\b/.test(refusal([bent]) ?? ''), 'a step that is not a list must stop the call');
  assert(/\biva\b/.test(refusal([{ ...item(), iva: [] }]) ?? ''), 'an iva that is not a record must stop the call');
  const noIva = { ...item() };
  delete noIva.iva;
  assert(/\biva\b/.test(refusal([noIva]) ?? ''), 'a card with no steps at all must stop the call');
});

check('an item this decoder cannot name stops the call instead of being decoded', () => {
  assert(/malformed item/.test(refusal([item({ id: 'x' })]) ?? ''),
    'an id that is not an Avito id must stop the call');
  assert(/invalid item URL/.test(refusal([item({ id: '8288791269' })].map((entry) => ({ ...entry, urlPath: '/moskva/telefony/iphone' }))) ?? ''),
    'a route that does not end in the item id must stop the call');
  assert(decode([{ type: 'banner', id: '1' }]).length === 0, 'a catalog entry that is not an item is not a listing');
});

// Avito appends a block of near-misses when the search runs short: other
// regions, other makes, headed by a placeholder that names the relaxation. They
// are not answers to the search and never reach the caller (D-072, F-094).
check('the block of near-matches Avito appends is not part of the result', () => {
  const decoded = catalogItems({
    items: [item()],
    extraBlockItems: [
      { type: 'placeholder', title: 'Похожие объявления рядом и в других городах', isGeo: true, isMixed: true },
      item({ id: '8320256694', locationName: 'Курган' }),
      item({ id: '8263547055', locationName: 'Псков' }),
    ],
  });
  assert(decoded.length === 1 && decoded[0].itemId === '7881841669',
    `unexpected listings: ${JSON.stringify(decoded.map((entry) => entry.itemId))}`);
  // A search Avito answers with nothing of its own is an empty page, whatever
  // the block beside it holds; the command turns that into EMPTY_RESULT.
  assert(catalogItems({ items: [], extraBlockItems: [item({ id: '8320256694' })] }).length === 0,
    'no listings of its own is nothing, not the near-misses instead');
});

check('the same listing twice is one listing', () => {
  assert(decode([item(), item()]).length === 1, 'a repeated id must not be decoded twice');
});

export default await run('catalog decoder');
