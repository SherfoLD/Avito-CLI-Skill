/**
 * `avito get-item` — the node half.
 *
 * One listing out of one of two carriers of the same object, tried in order: the
 * item API, then the hydration state the rendered listing page still holds. They
 * are never mixed — a half-decoded API item is discarded rather than patched,
 * because an answer assembled from two carriers has no single meaning.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import {
  count,
  idString,
  itemUrl,
  text,
  z,
} from '../runtime/schema.mjs';
import { assertPhotoDirectory, savePhotos } from '../site/photos.mjs';
import { decodeBuyerItem } from '../site/item.mjs';
import { readItemApi, readItemPage } from '../browser/commands/get-item.mjs';
import { primeOrigin } from '../site/carriers.mjs';

const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);

export function normalizeItemUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError('url must be a non-empty Avito item URL');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArgumentError('url must be a valid absolute URL');
  }

  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new ArgumentError('url must use https://www.avito.ru');
  }

  const normalizedPath = parsed.pathname.replace(/\/$/, '');
  const match = normalizedPath.match(/_(\d+)$/);
  if (!match) {
    throw new ArgumentError('url must end with an Avito item ID, for example ..._8030214066');
  }

  return {
    normalizedUrl: `https://www.avito.ru${normalizedPath}`,
    normalizedItemId: match[1],
    itemApiUrl: `https://www.avito.ru/items/ads${normalizedPath}`,
  };
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, 20);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function toOutput(decodedItem, normalizedUrl, imageFiles) {
  return {
    itemId: decodedItem.decodedItemId,
    title: decodedItem.decodedTitle,
    price: decodedItem.decodedPrice,
    priceList: decodedItem.decodedPriceList,
    location: decodedItem.decodedLocation,
    description: decodedItem.decodedDescription,
    attributes: decodedItem.decodedAttributes,
    publishedText: decodedItem.decodedPublishedText,
    sellerName: decodedItem.decodedSellerName,
    sellerRating: decodedItem.decodedSellerRating,
    sellerReviewsCount: decodedItem.decodedSellerReviewsCount,
    imageCount: decodedItem.decodedImages.length,
    images: imageFiles,
    url: normalizedUrl,
  };
}

/**
 * Name why the API answer was not usable, so the failure the caller finally
 * sees says which of six things went wrong rather than "it did not work".
 */
export function describeApiFailure(apiAttempt) {
  if (!apiAttempt || typeof apiAttempt !== 'object') return 'invalid API result';
  if (apiAttempt.requestError) return `request error: ${String(apiAttempt.requestError).slice(0, 200)}`;
  if (!apiAttempt.responseOk || apiAttempt.responseStatus !== 200) {
    return `HTTP ${apiAttempt.responseStatus || 0}`;
  }
  if (!String(apiAttempt.responseContentType || '').toLowerCase().includes('application/json')) {
    return `unexpected content type ${apiAttempt.responseContentType || '<empty>'}`;
  }
  if (apiAttempt.responseParseError) return 'malformed JSON';
  if (apiAttempt.redirectCode || apiAttempt.redirectUrl) return 'item redirect response';
  return 'unexpected buyerItem schema or item ID';
}

/**
 * The listing item of `search`, minus what belongs to a card (`minPrice`,
 * `hasPriceList`) and plus what only the listing page has: the whole
 * description, the original-size photos, the price list a service is priced by
 * (D-056), and `publishedText` — the rendered string, because the page carries
 * no machine-readable date anywhere (D-039, F-059).
 */
const OUTPUT = z.strictObject({
  itemId: idString(),
  title: text(),
  price: z.number().nonnegative().nullable(),
  // Empty is "Avito priced this listing with a number, not a table".
  priceList: z.array(z.strictObject({ title: text(), price: text() })),
  location: text().nullable(),
  description: text().nullable(),
  attributes: z.record(text(), text()),
  publishedText: text().nullable(),
  sellerName: text().nullable(),
  sellerRating: z.number().min(0).max(5).nullable(),
  sellerReviewsCount: count().nullable(),
  imageCount: count(),
  // Two empties that are different answers, which is why this is not one list.
  images: z.array(text()).nullable(),
  url: itemUrl(),
});

const OUTPUT_TYPE = `type Output = {
  itemId: string;                // digits only
  title: string;
  price: number | null;          // null where the listing is priced by a table or a phrase
  priceList: PriceEntry[];       // empty where Avito priced this listing with one number
  location: string | null;
  description: string | null;    // the whole text, not the card's truncation
  attributes: Record<string, string>;  // the visible characteristics table
  publishedText: string | null;  // Avito's rendered string — no year, no seconds, Moscow time
  sellerName: string | null;     // null for a private seller in an anonymous session
  sellerRating: number | null;   // 0..5
  sellerReviewsCount: number | null;
  imageCount: number;            // read on every run, whether or not the files were written
  images: string[] | null;       // files written by --images-dir in gallery order;
                                 // null when it was not passed, [] when there are no photos
  url: string;                   // canonical listing URL, no query
};

type PriceEntry = {
  title: string;
  price: string;                 // as Avito wrote it: «от 1 500 ₽», «Цена договорная»
};`;

export default defineCommand({
  name: 'get-item',
  description: 'Get one listing in full: the complete description, a service price list and, on request, the original photos written to a directory you name — none of which a search result carries',
  access: 'read',
  example: 'avito get-item <url> --images-dir /tmp/photos',
  domain: 'www.avito.ru',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Full https://www.avito.ru item URL from avito search' },
    {
      name: 'images-dir',
      type: 'string',
      help: 'Existing absolute directory to write the photos into; the command creates <dir>/<itemId>/ and fills it with 01.jpg, 02.jpg … in gallery order',
    },
  ],
  output: OUTPUT,
  type: OUTPUT_TYPE,
  run: async (page, args) => {
    const { normalizedUrl, normalizedItemId, itemApiUrl } = normalizeItemUrl(args.url);
    const photoDirectory = args['images-dir'] == null ? null : assertPhotoDirectory(args['images-dir']);

    // The photos are fetched once the item is decoded, and only then: a run
    // without the flag makes no request to the photo CDN at all.
    const withPhotos = async (decodedItem) => {
      const imageFiles = photoDirectory === null
        ? null
        : await savePhotos(decodedItem.decodedImages, { directory: photoDirectory, itemId: normalizedItemId });
      return toOutput(decodedItem, normalizedUrl, imageFiles);
    };

    let apiContextReady = false;
    let apiFailureReason = 'Avito API context was unavailable';
    try {
      await primeOrigin(page, 'get-item');
      apiContextReady = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiFailureReason = `opening API context failed: ${message.slice(0, 200)}`;
    }

    // The primed origin is not read for an access challenge, whatever it renders to. The
    // challenge is detected where it is actually visible — in the item API response and,
    // further down, in the rendered item page.
    if (apiContextReady) {
      let apiAttempt;
      try {
        apiAttempt = await page.evaluateWithArgs(readItemApi, { requestUrl: itemApiUrl });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        apiAttempt = { requestError: message };
      }

      // A blocked session stops here instead of rendering the item page on top of it.
      if (apiAttempt?.accessChallenge) {
        throw new CommandExecutionError(
          `Avito requires human verification or a rate-limit cooldown (item API returned HTTP ${apiAttempt.responseStatus || 0})`,
        );
      }

      if (
        apiAttempt?.responseOk
        && apiAttempt.responseStatus === 200
        && String(apiAttempt.responseContentType).toLowerCase().includes('application/json')
        && !apiAttempt.responseParseError
        && !apiAttempt.redirectCode
        && !apiAttempt.redirectUrl
      ) {
        const decoded = decodeBuyerItem(apiAttempt.buyerItem, normalizedItemId);
        if (decoded) return withPhotos(decoded);
      }
      apiFailureReason = describeApiFailure(apiAttempt);
    }

    try {
      // Nothing is waited for after the load event: the hydration state is inline in the
      // document Avito served, not something the page assembles afterwards (F-093).
      await page.goto(normalizedUrl, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening Avito item fallback');
    }

    let fallbackObserved;
    try {
      // The document is already on screen, fetched by the navigation above, so
      // this read costs no request and waits for no gap.
      fallbackObserved = await page.evaluateWithArgs(readItemPage, {}, { requests: false });
    } catch (error) {
      asExecutionError(error, 'reading Avito item fallback');
    }

    if (fallbackObserved?.accessBlocked) {
      throw new CommandExecutionError(
        `Avito requires human verification (${fallbackObserved.observedDocumentTitle || 'access challenge'})`,
      );
    }
    const fallbackItem = decodeBuyerItem(fallbackObserved?.buyerItem, normalizedItemId);
    if (fallbackItem) return withPhotos(fallbackItem);
    if (fallbackObserved?.itemUnavailable) {
      throw new EmptyResultError('avito get-item', `Item ${normalizedItemId} is unavailable`);
    }

    throw new CommandExecutionError(
      `Avito item API failed (${apiFailureReason}); the rendered listing page carried no hydration state for item ${normalizedItemId}`,
    );
  },
});
