/**
 * The listing row: the columns `search`, `get-page`, `apply-filters` and
 * `move-category` all hand over, and the two pieces of logic they share.
 *
 * `card.mjs` decodes one catalog into these columns plus `reserved`, which is a
 * predicate the command applies rather than a value the caller gets.
 */

import { CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import {
  count,
  idString,
  itemUrl,
  searchUrl,
  text,
  z,
} from '../runtime/schema.mjs';

/**
 * Nullability here is a statement about Avito, not about our confidence:
 *
 *   price          a listing can be shown without one, and a listing priced by
 *                  a floor or by a table has no single one to show (D-056)
 *   minPrice       the floor, and only where Avito printed one instead of a price
 *   location       a card can carry no geo reference and no city
 *   published      a card can arrive without the stamp Avito sorts by (F-059)
 *   sellerName     an anonymous session gets no seller-info step for a private
 *                  seller, while the flat rating survives (F-049, D-028)
 *   imageCount     the SSR catalog sends no photo block past its twentieth card,
 *                  which is not a listing without photos (F-089)
 */
export const LISTING_ROW = z.strictObject({
  itemId: idString(),
  title: text(),
  price: z.number().nonnegative().nullable(),
  minPrice: z.number().nonnegative().nullable()
    .meta({ note: 'set instead of price where Avito printed «от …»' }),
  hasPriceList: z.boolean().meta({ note: 'the prices are a table — read it with get-item' }),
  location: text().nullable(),
  descriptionPreview: text().nullable(),
  published: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'must be a UTC instant like 2026-08-14T02:15:41Z',
  ).meta({ note: 'ISO 8601 instant, UTC' }).nullable(),
  sellerName: text().nullable(),
  sellerRating: z.number().min(0).max(5).nullable(),
  sellerReviewsCount: count().nullable(),
  imageCount: count().nullable()
    .meta({ note: 'null where Avito sent no photo block at all (F-089); the photos themselves are get-item --images-dir' }),
  url: itemUrl(),
  searchUrl: searchUrl(),
});

/** Drop `reserved` and stamp on the URL every row carries. */
export function listingRows(rows, resultSearchUrl) {
  return rows.map((row) => {
    const columns = { ...row, searchUrl: resultSearchUrl };
    delete columns.reserved;
    return columns;
  });
}

/**
 * Avito offers no reservation filter, so this is a local predicate over the page
 * it returned: the page is only shortened, never refilled from the next one
 * (F-048, D-024).
 */
export function applyReservedFilter(rows, removeReserved, command) {
  if (!removeReserved) return rows;
  if (rows.some((row) => typeof row.reserved !== 'boolean')) {
    throw new CommandExecutionError(
      'Avito stopped reporting the reservation flag for part of the page; '
      + 'remove-reserved is refused rather than applied to a guess',
    );
  }
  const available = rows.filter((row) => row.reserved === false);
  if (available.length === 0) {
    throw new EmptyResultError(
      command,
      `every listing Avito returned on this page (${rows.length}) is reserved`,
    );
  }
  return available;
}
