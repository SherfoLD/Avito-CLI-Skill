/**
 * The catalog-card decoder: one Avito item as it arrives on the items API, and
 * the row the four listing commands hand over.
 *
 * What the card *shows* is not what the flat item says:
 *
 *   visible price     iva.PriceStep[].payload.priceDetailed   (flat: base price)
 *   visible text      iva.DescriptionStep[].payload           (flat: empty in SSR)
 *   visible location  geo.geoReferences[0] + walking time     (flat: null on most)
 *
 * The flat fields stay as fallbacks, so drift there does not fail — it answers
 * four commands with the other meaning. `CATALOG_ITEM` marks every such carrier
 * `z.unknown()`: what the schema declares is the shape that already stops the
 * call, and what it leaves open is where a fallback still decides.
 */

import { CommandExecutionError } from '../runtime/errors.mjs';
import { decode, z } from '../runtime/schema.mjs';
import { AVITO_BASE_URL } from './geo.mjs';
import { parseFragment } from './html.mjs';

/**
 * The keys this decoder reads. `z.unknown().optional()` is not laziness: those
 * are the carriers a fallback chain reaches past, and declaring a shape for one
 * would fail the call where the decoder answers from the other carrier instead.
 */
const CATALOG_ITEM = z.looseObject({
  type: z.unknown().optional(),
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  urlPath: z.unknown().optional(),
  url: z.unknown().optional(),
  description: z.unknown().optional(),
  priceDetailed: z.unknown().optional(),
  location: z.unknown().optional(),
  addressDetailed: z.unknown().optional(),
  geo: z.unknown().optional(),
  rating: z.unknown().optional(),
  iva: z.unknown().optional(),
  isReserved: z.unknown().optional(),
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
 * The two lists a catalog arrives in, before anything in them is a card. Avito
 * puts banners and widgets in the same arrays, and every one of them would fail
 * a card's declarations — so the entries are taken as they come and the ones
 * that say `type: 'item'` are decoded afterwards.
 */
const CATALOG = z.looseObject({
  items: z.array(z.unknown()).nullish(),
  extraBlockItems: z.array(z.unknown()).nullish(),
});

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stepPayload(item, step, component) {
  const steps = Array.isArray(item?.iva?.[step]) ? item.iva[step] : [];
  return steps.find((entry) => entry?.componentData?.component === component)?.payload;
}

/**
 * The card shows the bonus-adjusted price when Avito grants one: base 43 800 ₽
 * is rendered struck through next to the visible 43 691 ₽. That visible value
 * lives in the PriceStep payload, while the top-level priceDetailed keeps the
 * base price (D-020).
 *
 * A card with no number to show says so twice over and differently: the step
 * value is `null` under «Цена договорная» and `0` under «Бесплатно», while the
 * flat value is `0` under both (F-076). So the step is the whole answer wherever
 * Avito sent one — its own string included — and the flat field, which carries a
 * different quantity, is read only where there is no step at all.
 */
export function itemPrice(item) {
  const visible = stepPayload(item, 'PriceStep', 'price')?.priceDetailed;
  if (visible) return firstNumber([visible.value, visible.string]);
  if (item?.priceDetailed?.hasValue === false) return null;
  return firstNumber([
    item?.priceDetailed?.value,
    item?.priceDetailed?.price,
    item?.priceDetailed?.string,
    item?.priceDetailed?.fullString,
    item?.price,
  ]);
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
  const visible = stepPayload(item, 'PriceStep', 'price')?.priceDetailed;
  const printed = cleanText((visible ?? item?.priceDetailed)?.string);
  return /\d/.test(printed) && /[^\d\s]/.test(printed);
}

/**
 * A services card can carry a whole table of prices instead of one, and then the
 * scalar beside it is a floor rather than a price (F-079). The table itself is
 * not returned: it is the search index's copy and it disagrees with the listing
 * page's (F-081), so the row says only that `get-item` has one to read.
 */
export function itemHasPriceList(item) {
  return (item?.priceList?.valuesAll?.length ?? 0) > 0;
}

/**
 * The card prints the nearest geo reference with its walking time when Avito
 * has one ("Китай-город, до 5 мин.") and falls back to the plain city otherwise.
 */
export function itemLocation(item) {
  const geo = stepPayload(item, 'GeoStep', 'geo')?.geoForItems ?? item?.geo;
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

export function itemDescription(item) {
  const raw = cleanText(stepPayload(item, 'DescriptionStep', 'description')?.description
    ?? item?.description);
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
 * A stamp Avito did not send stays null like every other nullable column; a
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
  const steps = Array.isArray(item?.iva?.UserInfoStep) ? item.iva.UserInfoStep : [];
  const payload = steps.find((step) => step?.componentData?.component === 'seller-info')?.payload;
  const rawRating = payload?.rating?.score ?? item?.rating?.score;
  const rating = rawRating == null ? null : Number(rawRating);
  if (rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) {
    throw new CommandExecutionError('Avito catalog: seller rating is malformed');
  }
  return {
    name: cleanText(payload?.profile?.title) || null,
    rating,
    reviewsCount: reviewCount(payload?.rating?.summary ?? item?.rating?.summary),
  };
}

/**
 * Avito prints "Забронировано" on a reserved card. The machine-readable carrier
 * is the flat boolean the catalog ships with every item; nothing here infers
 * reservation from badges or card text. A card that stops carrying the boolean
 * decodes to null, and only `--remove-reserved` turns that into a stop, so the
 * default output never depends on this field (F-048).
 */
export function itemReserved(item) {
  return typeof item?.isReserved === 'boolean' ? item.isReserved : null;
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
 * Decode a whole catalog. The rows carry `reserved`, which is not a column:
 * `applyReservedFilter` reads it and `listingRows` drops it.
 */
export function catalogRows(catalog) {
  const decoded = decode(CATALOG, catalog, 'Avito catalog');
  const rawItems = decode(
    z.array(CATALOG_ITEM),
    [
      ...(decoded.items ?? []),
      ...(decoded.extraBlockItems ?? []),
    ].filter((entry) => entry?.type === 'item'),
    'Avito catalog',
  );

  const rows = [];
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
    rows.push({
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
  if (rawItems.length > 0 && rows.length === 0) {
    throw new CommandExecutionError('Avito catalog items could not be decoded');
  }
  return rows;
}

