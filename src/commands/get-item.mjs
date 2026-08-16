/**
 * `avito get-item` — the node half.
 *
 * The only command with two sources for one row, tried in order: the item API,
 * then the rendered listing page. They are never mixed. A half-decoded API item
 * is discarded rather than patched from the DOM, because a row assembled from
 * two carriers has no single meaning.
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
  httpsUrl,
  idString,
  itemUrl,
  text,
  z,
} from '../runtime/schema.mjs';
import { readItemApi, readItemPage } from '../browser/commands/get-item.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
// After the load event of the rendered fallback, before reading the DOM. This is the one
// place a settle time is legitimate: the page is being read as a person sees it.
const PAGE_SETTLE_MS = 1000;
const PAGE_SETTLE_SECONDS = 2;

/**
 * Read one price out of visible text. The item page prints exactly one number, so text
 * carrying two different numbers means the layout changed (for example a struck-through old
 * price inside the same container) and is reported as unknown instead of a concatenation.
 */
export function decodeVisiblePrice(value) {
  // \s also covers the non-breaking spaces Avito prints inside a price.
  const digitGroups = String(value ?? '').match(/\d[\d\s]*/g) ?? [];
  const numbers = [...new Set(digitGroups.map((group) => group.replace(/\s+/g, '')))];
  if (numbers.length !== 1) return null;
  const price = Number(numbers[0]);
  return Number.isSafeInteger(price) && price >= 0 ? price : null;
}

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

function toOutputRow(decodedItem, normalizedUrl) {
  return {
    itemId: decodedItem.decodedItemId,
    title: decodedItem.decodedTitle,
    price: decodedItem.decodedPrice,
    location: decodedItem.decodedLocation,
    description: decodedItem.decodedDescription,
    attributes: decodedItem.decodedAttributes,
    publishedText: decodedItem.decodedPublishedText,
    sellerName: decodedItem.decodedSellerName,
    sellerRating: decodedItem.decodedSellerRating,
    sellerReviewsCount: decodedItem.decodedSellerReviewsCount,
    images: decodedItem.decodedImages,
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

export default defineCommand({
  name: 'get-item',
  description: 'Get one listing in full: the complete description and the original-size photos, which a search row only previews',
  access: 'read',
  example: 'avito get-item <url> -f json',
  domain: 'www.avito.ru',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Full https://www.avito.ru item URL from avito search' },
  ],
  // The listing row of `search` with three differences: the whole description
  // instead of its preview, the original-size photos instead of the previews,
  // and `publishedText` — the rendered string Avito prints, because the listing
  // page carries no machine-readable date anywhere (D-039, F-059).
  row: z.strictObject({
    itemId: idString(),
    title: text(),
    price: z.number().nonnegative().nullable(),
    location: text().nullable(),
    description: text().nullable(),
    attributes: z.record(text(), text()),
    publishedText: text().nullable(),
    sellerName: text().nullable(),
    sellerRating: z.number().min(0).max(5).nullable(),
    sellerReviewsCount: count().nullable(),
    images: z.array(httpsUrl()),
    url: itemUrl(),
  }),
  run: async (page, args) => {
    const { normalizedUrl, normalizedItemId, itemApiUrl } = normalizeItemUrl(args.url);

    let apiContextReady = false;
    let apiFailureReason = 'Avito API context was unavailable';
    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
      apiContextReady = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiFailureReason = `opening API context failed: ${message.slice(0, 200)}`;
    }

    // The primed origin is not read for an access challenge: robots.txt itself lists
    // "captcha" in its Clean-param directives, so any text detector run against it would
    // false-positive. The challenge is detected where it is actually visible — in the item
    // API response and, further down, in the rendered item page.
    if (apiContextReady) {
      let apiAttempt;
      try {
        apiAttempt = await page.evaluateWithArgs(readItemApi, {
          requestUrl: itemApiUrl,
          expectedItemId: normalizedItemId,
        });
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
        && apiAttempt.decodedBuyerItem
      ) {
        return [toOutputRow(apiAttempt.decodedBuyerItem, normalizedUrl)];
      }
      apiFailureReason = describeApiFailure(apiAttempt);
    }

    try {
      await page.goto(normalizedUrl, { waitUntil: 'load', settleMs: PAGE_SETTLE_MS });
      await page.wait(PAGE_SETTLE_SECONDS);
    } catch (error) {
      asExecutionError(error, 'opening Avito item fallback');
    }

    let fallbackObserved;
    try {
      fallbackObserved = await page.evaluateWithArgs(readItemPage, { expectedItemId: normalizedItemId });
    } catch (error) {
      asExecutionError(error, 'reading Avito item fallback');
    }

    if (fallbackObserved?.accessBlocked) {
      throw new CommandExecutionError(
        `Avito requires human verification (${fallbackObserved.observedDocumentTitle || 'access challenge'})`,
      );
    }
    if (fallbackObserved?.decodedHydrationItem) {
      return [toOutputRow(fallbackObserved.decodedHydrationItem, normalizedUrl)];
    }
    if (fallbackObserved?.itemUnavailable) {
      throw new EmptyResultError('avito get-item', `Item ${normalizedItemId} is unavailable`);
    }
    if (!fallbackObserved?.domObservedTitle || !fallbackObserved?.domPriceContainerPresent) {
      throw new CommandExecutionError(
        `Avito item API failed (${apiFailureReason}); hydration and visible title/price fallback were unavailable`,
      );
    }

    return [{
      itemId: normalizedItemId,
      title: fallbackObserved.domObservedTitle,
      price: decodeVisiblePrice(fallbackObserved.domObservedPriceText),
      location: fallbackObserved.domObservedLocation,
      description: fallbackObserved.domObservedDescription,
      attributes: fallbackObserved.domObservedAttributes,
      publishedText: fallbackObserved.domObservedPublishedText,
      sellerName: null,
      sellerRating: null,
      sellerReviewsCount: null,
      images: [],
      url: normalizedUrl,
    }];
  },
});
