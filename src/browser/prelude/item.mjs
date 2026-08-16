/**
 * The listing-page `buyerItem` decoder. It reads a different carrier from
 * `card.mjs` and holds the opposite failure contract, which is why the review
 * count and the image reader exist in both:
 *
 *   card.mjs   throws on a malformed value. A catalog row has no second source,
 *              so drift has to stop the call.
 *   item.mjs   returns `null` for the whole item. `get-item` has a fallback —
 *              the rendered page — and null is how this decoder says "try it".
 */

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
export function decodeBuyerItemInBrowser(buyerItem, expectedItemId, env) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!buyerItem || typeof buyerItem !== 'object' || Array.isArray(buyerItem)) return null;

  const rawItem = buyerItem.item;
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return null;

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
    const descriptionDocument = new env.DOMParser().parseFromString(descriptionSource, 'text/html');
    const descriptionParts = [...descriptionDocument.body.childNodes]
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

  const searchLocations = rawItem.searchLocation == null
    ? []
    : rawItem.searchLocation;
  if (!Array.isArray(searchLocations)) return null;
  const decodedLocation = clean(rawItem.location?.name)
    || clean(searchLocations.find((entry) => entry?.current)?.name)
    || clean(rawItem.sellerAddressInfo?.fullAddress?.locality)
    || clean(rawItem.address).split(',')[0]
    || null;

  const conditionParams = rawItem.conditionParams?.data?.items;
  const categoryParams = Array.isArray(buyerItem.paramsDto?.items)
    ? buyerItem.paramsDto.items
    : buyerItem.paramsBlock?.items;
  const rawAttributeGroups = [conditionParams, categoryParams].filter((group) => group != null);
  if (rawAttributeGroups.some((group) => !Array.isArray(group))) return null;

  const rawAttributes = rawAttributeGroups.flat();
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

  return {
    decodedItemId,
    decodedTitle,
    decodedPrice,
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
