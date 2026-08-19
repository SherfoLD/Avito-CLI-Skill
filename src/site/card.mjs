/**
 * The catalog-card decoder: one Avito item as it arrives on the items API, and
 * the item the four listing commands hand over.
 *
 * What the card *shows* lives in `iva`, Avito's own list of rendered steps, and
 * two of those steps are the whole answer rather than the better half of one:
 *
 *   visible price   iva.PriceStep[].payload.priceDetailed
 *   visible text    iva.DescriptionStep[].payload.description
 *
 * The flat `priceDetailed` beside the first is a different quantity — the base
 * price, which disagrees with the printed one on 45 cards of 50 on a walked
 * route (D-020, F-076) — so a card with no price step is drift and stops the
 * call rather than answering from it (D-070).
 *
 * `iva.GeoStep` is not of that kind: two real-estate routes ship no such step at
 * all and the flat `geo` carries the same references, so the location is read
 * from whichever of the two the card has (F-093).
 */

import { CommandExecutionError } from '../runtime/errors.mjs';
import { decode, z } from '../runtime/schema.mjs';
import { AVITO_BASE_URL } from './geo.mjs';
import { parseFragment } from './html.mjs';

/**
 * The keys this decoder reads. What stays `z.unknown().optional()` is what a
 * fallback chain still reaches past: the flat geo carriers, and the flat rating
 * that outlives a withheld seller-info step (F-049).
 */
const CATALOG_ITEM = z.looseObject({
  type: z.unknown().optional(),
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  urlPath: z.unknown().optional(),
  url: z.unknown().optional(),
  location: z.unknown().optional(),
  addressDetailed: z.unknown().optional(),
  geo: z.unknown().optional(),
  rating: z.unknown().optional(),
  // Which steps a card carries is Avito's to decide — `BadgeStickerStep` is on
  // 7 cards of a 50-card page — but every one of them is a list of rendered
  // components. A step that is not a list is drift wearing the shape of an
  // absent one (F-093).
  iva: z.record(z.string(), z.array(z.unknown())),
  // Avito ships the flag on every catalog card. Absent, it is a field with no
  // answer; carrying anything but a boolean, it is drift (F-048, F-093).
  isReserved: z.boolean().nullish(),
  // An empty list is a listing with no photos (F-047); the key missing
  // altogether is Avito not sending the block, which is every card past the
  // twentieth of the SSR catalog (F-089). Anything else is drift.
  images: z.array(z.unknown()).nullish(),
  // Avito sorts by this stamp and prints the same moment on the listing page,
  // so it is the publication date rather than a creation date (D-039, F-059).
  sortTimeStamp: z.number().int().positive().nullish(),
  // `values` is what Avito draws, `valuesAll` the whole list (F-079).
  priceList: z.looseObject({ valuesAll: z.array(z.unknown()) }).nullish(),
});

/**
 * The list a catalog arrives in, before anything in it is a card. Avito puts
 * banners and widgets in the same array, and every one of them would fail a
 * card's declarations — so the entries are taken as they come and the ones that
 * say `type: 'item'` are decoded afterwards.
 *
 * `catalog.extraBlockItems` is deliberately not declared and not read. It is
 * the block Avito appends when the search runs short, and its cards are answers
 * to a widened search — other regions, other makes — that the caller did not
 * ask for (D-072, F-094).
 */
const CATALOG = z.looseObject({
  items: z.array(z.unknown()).nullish(),
});

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stepPayload(item, step, component) {
  return item.iva[step]?.find((entry) => entry?.componentData?.component === component)?.payload;
}

/** The same, where the step is the only carrier of the answer (D-070). */
function requiredStepPayload(item, step, component) {
  const payload = stepPayload(item, step, component);
  if (payload == null || typeof payload !== 'object') {
    throw new CommandExecutionError(`Avito catalog card ${item.id} carries no ${step}`);
  }
  return payload;
}

/**
 * The card shows the bonus-adjusted price when Avito grants one: base 43 800 ₽
 * is rendered struck through next to the visible 43 691 ₽. That visible value
 * lives in the PriceStep payload, while the top-level priceDetailed keeps the
 * base price (D-020).
 *
 * A card with no number to show says so twice over and differently: the step
 * value is `null` under «Цена договорная» and `0` under «Бесплатно», while the
 * flat value is `0` under both (F-076). So the step answers for both, its own
 * string included.
 */
export function itemPrice(item) {
  const printed = priceStep(item);
  return firstNumber([printed.value, printed.string]);
}

/** The price as the card prints it. Its absence is drift, not a missing value. */
function priceStep(item) {
  const printed = requiredStepPayload(item, 'PriceStep', 'price').priceDetailed;
  if (printed == null || typeof printed !== 'object') {
    throw new CommandExecutionError(`Avito catalog card ${item.id} carries a price step with no price`);
  }
  return printed;
}

/** The first candidate that is a number, or that spells one. */
export function firstNumber(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
    if (typeof candidate === 'string') {
      const digits = candidate.replace(/[^\d]/g, '');
      if (digits) {
        const parsed = Number(digits);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

/**
 * Whether the number Avito printed is the price or only its floor. There is no
 * flag for «от»: the word lives inside the price string and nowhere else
 * (F-078), so the test is the shape of that string rather than its vocabulary —
 * digits and spaces alone are a price, digits with anything beside them are a
 * floor, and a string with no digits at all is a phrase («Бесплатно», «Цена
 * договорная») that `itemPrice` has already answered for.
 */
export function itemPriceIsFloor(item) {
  const printed = cleanText(priceStep(item).string);
  return /\d/.test(printed) && /[^\d\s]/.test(printed);
}

/**
 * A services card can carry a whole table of prices instead of one, and then the
 * scalar beside it is a floor rather than a price (F-079). The table itself is
 * not returned: it is the search index's copy and it disagrees with the listing
 * page's (F-081), so the item says only that `get-item` has one to read.
 */
export function itemHasPriceList(item) {
  return (item?.priceList?.valuesAll?.length ?? 0) > 0;
}

/**
 * The card prints the nearest geo reference with its walking time when Avito
 * has one ("Китай-город, до 5 мин.") and the plain city otherwise. Both carriers
 * are primary: a computer-parts page ships the step with no references on 46
 * cards of 50, and a flats page ships the references with no step at all, on all
 * 50 (F-093).
 */
export function itemLocation(item) {
  const geo = stepPayload(item, 'GeoStep', 'geo')?.geoForItems ?? item.geo;
  const reference = Array.isArray(geo?.geoReferences) ? geo.geoReferences[0] : null;
  const referenceName = cleanText(reference?.content);
  if (referenceName) {
    const walking = cleanText(reference?.afterWithIcon?.text);
    return walking ? referenceName + ', ' + walking : referenceName;
  }
  const candidates = [
    item?.location?.name,
    item?.location?.title,
    item?.addressDetailed?.locationName,
    geo?.addressLocality,
    geo?.formattedAddress,
    item?.geo?.address,
    typeof item?.location === 'string' ? item.location : null,
  ];
  return candidates.map(cleanText).find(Boolean) || null;
}

/**
 * The card text, which arrives with Avito's own markup in it. The flat
 * `description` beside the step is the same string on the items API and empty in
 * the SSR catalog, so it is a second copy rather than a second carrier and the
 * step answers alone (F-093).
 */
export function itemDescription(item) {
  const raw = cleanText(requiredStepPayload(item, 'DescriptionStep', 'description').description);
  if (!raw) return null;
  if (!/[<>]/.test(raw)) return raw;
  return cleanText(parseFragment(raw)?.textContent) || null;
}

/** "нет отзывов" is a real zero; anything else must contain a number. */
export function reviewCount(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^нет отзывов$/i.test(text)) return 0;
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) throw new CommandExecutionError('Avito catalog: seller review summary is malformed');
  const count = Number(digits);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new CommandExecutionError('Avito catalog: seller review count is malformed');
  }
  return count;
}

/**
 * A stamp Avito did not send stays null like every other nullable field; a
 * stamp it sent in an impossible shape is drift and stops the call.
 */
export function itemPublished(item) {
  const stamp = item?.sortTimeStamp;
  if (stamp == null) return null;
  const published = new Date(stamp);
  const year = published.getUTCFullYear();
  if (!Number.isFinite(published.getTime()) || year < 2000 || year > 2100) {
    throw new CommandExecutionError('Avito catalog: item publication stamp is out of range');
  }
  return published.toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * An anonymous session gets no seller-info step at all on a private seller's
 * card, while the flat rating survives — identity and rating come from
 * different carriers and neither can be derived from the other (F-049). The
 * name stays nullable; a null here is "Avito did not send it", never "there is
 * no seller" (D-028).
 */
export function itemSeller(item) {
  const payload = stepPayload(item, 'UserInfoStep', 'seller-info');
  const rawRating = payload?.rating?.score ?? item.rating?.score;
  const rating = rawRating == null ? null : Number(rawRating);
  if (rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) {
    throw new CommandExecutionError('Avito catalog: seller rating is malformed');
  }
  return {
    name: cleanText(payload?.profile?.title) || null,
    rating,
    reviewsCount: reviewCount(payload?.rating?.summary ?? item.rating?.summary),
  };
}

/**
 * Avito prints "Забронировано" on a reserved card. The machine-readable carrier
 * is the flat boolean the catalog ships with every item; nothing here infers
 * reservation from badges or card text. A card that stops carrying the key
 * decodes to null, and only `--remove-reserved` turns that into a stop, so the
 * default output never depends on this field (F-048).
 */
export function itemReserved(item) {
  return item.isReserved ?? null;
}

/**
 * How many photos the card carries. Nothing here reads a photo URL: the sizes
 * are Avito's vocabulary, the originals are `get-item`'s, and a card whose
 * placeholder is served from outside the photo CDN — every résumé — stays
 * readable because of it (D-061, F-087).
 */
export function itemImageCount(item) {
  return item?.images == null ? null : item.images.length;
}

function itemUrl(item, itemId) {
  let parsed;
  try {
    parsed = new URL(String(item?.urlPath ?? item?.url ?? ''), AVITO_BASE_URL);
  } catch {
    throw new CommandExecutionError('Avito catalog contains an invalid item URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'www.avito.ru'
    || !parsed.pathname.endsWith('_' + itemId)
  ) {
    throw new CommandExecutionError('Avito catalog contains an invalid item URL');
  }
  return parsed.origin + parsed.pathname;
}

/**
 * Decode a whole catalog: `catalog.items` and nothing else. Each decoded item
 * carries `reserved`, which is not a field of the contract: `applyReservedFilter`
 * reads it and `listingItems` drops it.
 */
export function catalogItems(catalog) {
  const decoded = decode(CATALOG, catalog, 'Avito catalog');
  const rawItems = decode(
    z.array(CATALOG_ITEM),
    (decoded.items ?? []).filter((entry) => entry?.type === 'item'),
    'Avito catalog',
  );

  const items = [];
  const seenIds = new Set();
  for (const item of rawItems) {
    const itemId = cleanText(item?.id);
    const title = cleanText(item?.title);
    if (!/^\d+$/.test(itemId) || !title) {
      throw new CommandExecutionError('Avito catalog contains a malformed item');
    }
    if (seenIds.has(itemId)) continue;
    seenIds.add(itemId);

    const hasPriceList = itemHasPriceList(item);
    // One number cannot stand for a table of them, and which entry Avito took
    // the scalar from is not stated anywhere: beside a list of 900 ₽ and up the
    // card printed «от 400 ₽» (F-079). So a number that is not the price is
    // still the floor Avito advertised, and it is handed over as one.
    const printedPrice = itemPrice(item);
    const isFloor = hasPriceList || itemPriceIsFloor(item);
    const seller = itemSeller(item);
    items.push({
      itemId,
      title,
      price: isFloor ? null : printedPrice,
      minPrice: isFloor ? printedPrice : null,
      hasPriceList,
      location: itemLocation(item),
      descriptionPreview: itemDescription(item),
      published: itemPublished(item),
      sellerName: seller.name,
      sellerRating: seller.rating,
      sellerReviewsCount: seller.reviewsCount,
      imageCount: itemImageCount(item),
      url: itemUrl(item, itemId),
      reserved: itemReserved(item),
    });
  }
  if (rawItems.length > 0 && items.length === 0) {
    throw new CommandExecutionError('Avito catalog items could not be decoded');
  }
  return items;
}

