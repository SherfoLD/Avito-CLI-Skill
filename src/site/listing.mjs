/**
 * The listing row: the twelve columns `search`, `get-page`, `apply-filters` and
 * `move-category` all hand over, and the two pieces of logic they share.
 *
 * `card.mjs` decodes the catalog into `api*` rows inside the page; this is the
 * Node half of the same boundary, mapping those onto the declared columns.
 */

import { CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import {
  count,
  httpsUrl,
  idString,
  itemUrl,
  searchUrl,
  text,
  z,
} from '../runtime/schema.mjs';

/**
 * Nullability here is a statement about Avito, not about our confidence:
 *
 *   price          a listing can be shown without one
 *   location       a card can carry no geo reference and no city
 *   published      a card can arrive without the stamp Avito sorts by (F-059)
 *   sellerName     an anonymous session gets no seller-info step for a private
 *                  seller, while the flat rating survives (F-049, D-028)
 */
export const LISTING_ROW = z.strictObject({
  itemId: idString(),
  title: text(),
  price: z.number().nonnegative().nullable(),
  location: text().nullable(),
  descriptionPreview: text().nullable(),
  published: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'must be a UTC instant like 2026-08-14T02:15:41Z',
  ).nullable(),
  sellerName: text().nullable(),
  sellerRating: z.number().min(0).max(5).nullable(),
  sellerReviewsCount: count().nullable(),
  imagesPreviews: z.array(httpsUrl()),
  url: itemUrl(),
  searchUrl: searchUrl(),
});

/**
 * Map the decoder's `api*` rows onto the declared columns. `apiReserved` is not
 * among them: it is a predicate the command applies, not a value the caller gets.
 */
export function listingRows(apiRows, resultSearchUrl) {
  return apiRows.map((row) => ({
    itemId: row.apiItemId,
    title: row.apiTitle,
    price: row.apiPrice,
    location: row.apiLocation,
    descriptionPreview: row.apiDescriptionPreview,
    published: row.apiPublished,
    sellerName: row.apiSeller.name,
    sellerRating: row.apiSeller.rating,
    sellerReviewsCount: row.apiSeller.reviewsCount,
    imagesPreviews: row.apiImages,
    url: row.apiUrl,
    searchUrl: resultSearchUrl,
  }));
}

/**
 * Avito offers no reservation filter, so this is a local predicate over the page
 * it returned: the page is only shortened, never refilled from the next one
 * (F-048, D-024).
 */
export function applyReservedFilter(rows, removeReserved, command) {
  if (!removeReserved) return rows;
  if (rows.some((row) => typeof row.apiReserved !== 'boolean')) {
    throw new CommandExecutionError(
      'Avito stopped reporting the reservation flag for part of the page; '
      + 'remove-reserved is refused rather than applied to a guess',
    );
  }
  const available = rows.filter((row) => row.apiReserved === false);
  if (available.length === 0) {
    throw new EmptyResultError(
      command,
      `every listing Avito returned on this page (${rows.length}) is reserved`,
    );
  }
  return available;
}
