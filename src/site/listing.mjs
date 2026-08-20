/**
 * The listing item: what `search`, `get-page`, `apply-filters` and
 * `move-category` all put in `items`, plus the two pieces of logic they share.
 *
 * `card.mjs` decodes one catalog into these fields plus `reserved`, which is a
 * predicate the command applies rather than a value the caller gets. The
 * `searchUrl` is not here: it is one URL for the whole answer and lives on the
 * envelope each of the four declares (D-073).
 */

import { CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import {
  count,
  idString,
  itemUrl,
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
export const LISTING_ITEM = z.strictObject({
  itemId: idString(),
  title: text(),
  price: z.number().nonnegative().nullable(),
  minPrice: z.number().nonnegative().nullable(),
  hasPriceList: z.boolean(),
  location: text().nullable(),
  descriptionPreview: text().nullable(),
  published: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'must be a UTC instant like 2026-08-14T02:15:41Z',
  ).nullable(),
  sellerName: text().nullable(),
  sellerRating: z.number().min(0).max(5).nullable(),
  sellerReviewsCount: count().nullable(),
  imageCount: count().nullable(),
  url: itemUrl(),
});

/** The `Item` half of the `type` the four listing commands print. */
export const LISTING_ITEM_TYPE = `type Item = {
  itemId: string;                    // digits only
  title: string;
  price: number | null;              // null where Avito printed no single price
  minPrice: number | null;           // set instead of price where Avito printed «от …»
  hasPriceList: boolean;             // the prices are a table — read it with get-item
  location: string | null;
  descriptionPreview: string | null; // Avito's own truncation, not the description
  published: string | null;          // ISO 8601 instant, UTC
  sellerName: string | null;         // null for a private seller in an anonymous session
  sellerRating: number | null;       // 0..5
  sellerReviewsCount: number | null;
  imageCount: number | null;         // null means the page carried no photo block for this card,
                                     // which is not zero photos; the photos are get-item --images-dir
  url: string;                       // listing URL, no query
};`;

/**
 * What the four say about the answer as a whole, declared once. `medianPrice` is
 * nullable for the same reason `price` is: a page can hold nothing with a single
 * price to take a median of.
 */
export const LISTING_SUMMARY = {
  itemsCount: count(),
  medianPrice: z.number().nonnegative().nullable(),
};

/** The `Envelope` half of the `type`, wherever the four print their own. */
export const LISTING_SUMMARY_TYPE = `  itemsCount: number;     // listings in this answer, which is fewer than the page
                          // Avito served when --remove-reserved dropped some
  medianPrice: number | null; // median of the price field over the listings in this
                          // answer that carry one; null where none of them does`;

/**
 * The two counts and the list, as the four listing commands put them on the
 * envelope. Both are facts about this answer rather than about the search: they
 * describe what `items` holds after `--remove-reserved` shortened it, and never
 * the size or the prices of the result set Avito reports (D-077).
 */
export function listingAnswer(items, removeReserved, command) {
  const answered = listingItems(applyReservedFilter(items, removeReserved, command));
  return {
    itemsCount: answered.length,
    medianPrice: medianPrice(answered),
    items: answered,
  };
}

/**
 * A listing Avito priced from a floor or by a table carries no single price
 * (D-056), and its `minPrice` is a different quantity — counting it would put a
 * number in the middle of the page that no listing costs, so it is left out and
 * a page where nothing carries a price has no median at all. What the numbers
 * mean is still Avito's: a route that prints rates rather than sums medians
 * rates (F-077).
 */
function medianPrice(items) {
  const prices = items
    .map((item) => item.price)
    .filter((price) => price != null)
    .sort((left, right) => left - right);
  if (prices.length === 0) return null;
  const middle = prices.length >> 1;
  return prices.length % 2 === 1
    ? prices[middle]
    : (prices[middle - 1] + prices[middle]) / 2;
}

/** Drop `reserved`, which is a predicate this page answered rather than a field. */
export function listingItems(items) {
  return items.map((item) => {
    const fields = { ...item };
    delete fields.reserved;
    return fields;
  });
}

/**
 * Avito offers no reservation filter, so this is a local predicate over the page
 * it returned: the page is only shortened, never refilled from the next one
 * (F-048, D-024).
 */
export function applyReservedFilter(items, removeReserved, command) {
  if (!removeReserved) return items;
  if (items.some((item) => typeof item.reserved !== 'boolean')) {
    throw new CommandExecutionError(
      'Avito stopped reporting the reservation flag for part of the page; '
      + 'remove-reserved is refused rather than applied to a guess',
    );
  }
  const available = items.filter((item) => item.reserved === false);
  if (available.length === 0) {
    throw new EmptyResultError(
      command,
      `every listing Avito returned on this page (${items.length}) is reserved`,
    );
  }
  return available;
}
