/**
 * The listing-page `buyerItem` decoder. It reads a different carrier from
 * `card.mjs` and holds the opposite failure contract, which is why the review
 * count and the image reader exist in both:
 *
 *   card.mjs   throws on a malformed value. A catalog row has no second source,
 *              so drift has to stop the call.
 *   item.mjs   returns `null` for the whole item. `get-item` has a fallback —
 *              the rendered page — and null is how this decoder says "try it".
 *
 * `BUYER_ITEM` is read with `safeParse` for that reason: a shape this decoder
 * cannot trust is the same answer as a value it cannot trust.
 */

import { BUYER_ITEM } from '../schemas/item.mjs';
import { parseFragment } from './html.mjs';

/** Local to this carrier: `undefined` means malformed, `null` means absent. */
export function itemReviewCount(value) {
  const summary = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  if (/^нет отзывов$/i.test(summary)) return 0;
  const digits = summary.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  const count = Number(digits);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/**
 * The price table of a service, as the listing page prints it (F-080). Avito
 * groups the entries and has only ever sent one group, «Прайс-лист»; the groups
 * are merged because a row column holds a table and not a tree, so a second
 * group would arrive as more entries rather than as a lost one. A goods listing
 * carries the key with `null` and decodes to an empty table.
 *
 * `undefined` means malformed, the same as everywhere else in this decoder.
 */
export function decodeItemPriceList(rawPriceList) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  if (rawPriceList == null) return [];
  if (typeof rawPriceList !== 'object' || Array.isArray(rawPriceList)) return undefined;
  const groups = rawPriceList.groups;
  if (!Array.isArray(groups) || groups.length > 20) return undefined;

  const entries = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined;
    if (!Array.isArray(group.values) || group.values.length > 200) return undefined;
    for (const value of group.values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const title = clean(value.title);
      // Avito's own string, «Бесплатно» and «Цена договорная» included: an entry
      // is priced by a phrase as often as by a number, and the two phrases are
      // not the same answer (F-076).
      const price = clean(value.price);
      if (!title || !price) return undefined;
      entries.push({ title, price });
    }
  }
  return entries;
}

/**
 * Original-size photos, from `item.imageUrls` when Avito ships it and from the
 * gallery otherwise. Returns `null` for anything malformed, which fails the
 * whole item rather than quietly returning fewer photos.
 */
export function decodeItemImages(rawItemImageUrls, galleryMedia) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const useItemImages = rawItemImageUrls != null;
  const sourceRows = useItemImages ? rawItemImageUrls : galleryMedia;
  if (sourceRows == null) return [];
  if (!Array.isArray(sourceRows) || sourceRows.length > 100) return null;

  const result = [];
  const seen = new Set();
  for (const sourceRow of sourceRows) {
    if (!sourceRow || typeof sourceRow !== 'object' || Array.isArray(sourceRow)) return null;
    if (!useItemImages && sourceRow.isVideo === true) continue;
    const variants = useItemImages ? sourceRow : sourceRow.urls;
    if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return null;

    // Avito owns the set of size keys, so the largest offered variant wins rather than a
    // named pair. An entry carrying no size at all fails closed rather than dropping a
    // photo silently (F-047).
    let source = null;
    let sourceArea = -1;
    for (const [key, value] of Object.entries(variants)) {
      const url = clean(value);
      const size = /^(\d+)x(\d+)$/.exec(key);
      if (!url || !size) continue;
      const area = Number(size[1]) * Number(size[2]);
      if (area > sourceArea) {
        sourceArea = area;
        source = url;
      }
    }
    if (!source) return null;

    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'https:'
      || !/(^|\.)img\.avito\.st$/.test(parsed.hostname)
      || parsed.port
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      result.push(parsed.href);
    }
  }
  return result;
}

/**
 * Decode one `buyerItem` payload, or return `null` if it is not the item that
 * was asked for or its shape cannot be trusted.
 */
export function decodeBuyerItem(rawBuyerItem, expectedItemId) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const parsed = BUYER_ITEM.safeParse(rawBuyerItem);
  if (!parsed.success) return null;
  const buyerItem = parsed.data;
  const rawItem = buyerItem.item;

  const decodedItemId = String(rawItem.id ?? '');
  const decodedTitle = clean(rawItem.title);
  if (!/^\d+$/.test(decodedItemId) || decodedItemId !== expectedItemId || !decodedTitle) return null;

  // The page prints the bonus-adjusted price in formattedPrice.string, while
  // formattedPrice.value, item.price and the microdata itemprop="price" attribute all keep
  // the base price. Two different numbers in that string mean the layout changed, so they
  // are reported as unknown instead of being concatenated into a garbage number.
  const displayedPriceGroups = clean(rawItem.formattedPrice?.string).match(/\d[\d\s]*/g) ?? [];
  const displayedPriceNumbers = [...new Set(displayedPriceGroups.map((group) => group.replace(/\s+/g, '')))];
  let decodedPrice = null;
  if (displayedPriceNumbers.length === 1) {
    const displayedPrice = Number(displayedPriceNumbers[0]);
    if (Number.isSafeInteger(displayedPrice) && displayedPrice >= 0) decodedPrice = displayedPrice;
  }
  // Last resort when Avito shows no formatted price at all; this one is the base price.
  if (decodedPrice === null && Number.isFinite(rawItem.price)) decodedPrice = Number(rawItem.price);

  const descriptionSource = (
    (rawItem.hasWysiwyg || buyerItem.hasWysiwyg) && clean(rawItem.descriptionHtml)
  ) ? rawItem.descriptionHtml : rawItem.description;
  let decodedDescription = null;
  if (typeof descriptionSource === 'string' && descriptionSource.trim()) {
    const descriptionParts = [...parseFragment(descriptionSource).childNodes]
      .map((node) => clean(node.textContent))
      .filter(Boolean);
    decodedDescription = descriptionParts.join('\n') || null;
  }

  // The listing page carries no machine-readable date anywhere — not in the item API, not
  // in JSON-LD, not in microdata — only this rendered string, without a year and without
  // seconds. It passes through as Avito wrote it; the exact instant is on the search row
  // under `published` (D-039, F-059).
  if (rawItem.sortFormatedDate != null && typeof rawItem.sortFormatedDate !== 'string') return null;
  const decodedPublishedText = clean(rawItem.sortFormatedDate) || null;

  const searchLocations = rawItem.searchLocation ?? [];
  const decodedLocation = clean(rawItem.location?.name)
    || clean(searchLocations.find((entry) => entry?.current)?.name)
    || clean(rawItem.sellerAddressInfo?.fullAddress?.locality)
    || clean(rawItem.address).split(',')[0]
    || null;

  const conditionParams = rawItem.conditionParams?.data?.items;
  const categoryParams = Array.isArray(buyerItem.paramsDto?.items)
    ? buyerItem.paramsDto.items
    : buyerItem.paramsBlock?.items;
  const rawAttributes = [conditionParams, categoryParams].filter((group) => group != null).flat();
  if (rawAttributes.length > 200) return null;
  const decodedAttributes = {};
  for (const rawAttribute of rawAttributes) {
    if (!rawAttribute || typeof rawAttribute !== 'object' || Array.isArray(rawAttribute)) return null;
    const attributeLabel = clean(rawAttribute.title).replace(/:\s*$/, '');
    const attributeValue = clean(rawAttribute.description);
    if (!attributeLabel || !attributeValue) return null;
    if (attributeLabel in decodedAttributes && decodedAttributes[attributeLabel] !== attributeValue) return null;
    decodedAttributes[attributeLabel] = attributeValue;
  }

  const decodedSellerName = clean(buyerItem.seller?.name)
    || clean(buyerItem.contactBarInfo?.publicProfileInfo?.itemSellerName)
    || clean(buyerItem.contactBarInfo?.seller?.name)
    || null;
  const rawSellerRating = buyerItem.rating?.scoreFloat;
  const decodedSellerRating = rawSellerRating == null ? null : Number(rawSellerRating);
  if (
    decodedSellerRating != null
    && (!Number.isFinite(decodedSellerRating) || decodedSellerRating < 0 || decodedSellerRating > 5)
  ) {
    return null;
  }
  const decodedSellerReviewsCount = itemReviewCount(buyerItem.rating?.summary);
  if (decodedSellerReviewsCount === undefined) return null;
  const decodedImages = decodeItemImages(rawItem.imageUrls, buyerItem.galleryInfo?.media);
  if (decodedImages === null) return null;
  const decodedPriceList = decodeItemPriceList(rawItem.priceList);
  if (decodedPriceList === undefined) return null;

  return {
    decodedItemId,
    decodedTitle,
    // A listing priced by a table has no single price, and the page prints none
    // either. The minimum of the table is not that price (F-080).
    decodedPrice: decodedPriceList.length > 0 ? null : decodedPrice,
    decodedPriceList,
    decodedLocation,
    decodedDescription,
    decodedAttributes,
    decodedPublishedText,
    decodedSellerName,
    decodedSellerRating,
    decodedSellerReviewsCount,
    decodedImages,
  };
}
